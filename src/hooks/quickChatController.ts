import { randomUUID } from "node:crypto";
import { ApiError, WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import {
  ChatDefaults,
  canReattach,
  createRequest,
  createTag,
  ongoing,
  ownerTag,
  reuseDecision,
  roleTag,
} from "../domain/quickChat";
import { isStructured } from "../domain/sessions";
import { PendingOperation, QuickChatStore } from "../storage/quickChat";
import { FeedConnection } from "./sessionFeeds";

export interface QuickChatSnapshot {
  loading: boolean;
  busy: boolean;
  draft: string;
  metadata?: ServerMetadata;
  defaults?: ChatDefaults;
  session?: Session;
  error?: string;
  notice?: string;
  pending?: PendingOperation;
  revision: number;
}
export class QuickChatController {
  private state: QuickChatSnapshot = { loading: true, busy: false, draft: "", revision: 0 };
  private listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private observedPointer?: string;
  private observedDefaults = "";
  private prepared = false;
  private draftLoaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly draftKey: string;
  constructor(
    private readonly connection: FeedConnection,
    private readonly store: QuickChatStore,
    private readonly verifyConnection: () => Promise<void>,
    private readonly forceNew = false,
    private readonly client = new WaypointClient(connection.apiUrl),
    private readonly now = Date.now,
  ) {
    this.draftKey = forceNew ? "new" : "quick";
  }
  canSend = () => this.prepared && !this.state.loading && !this.state.busy && !this.state.pending;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<QuickChatSnapshot>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  stop() {
    this.active = false;
    this.generation++;
  }
  async start() {
    this.active = true;
    const generation = ++this.generation;
    this.publish({ loading: true, error: undefined });
    try {
      await this.queue;
      const saved = await this.store.load(this.connection.id);
      if (!this.active || generation !== this.generation) return;
      this.publish({
        draft: this.draftLoaded ? this.state.draft : (saved.drafts[this.draftKey] ?? ""),
        defaults: saved.defaults,
        pending: saved.pending,
      });
      this.draftLoaded = true;
      await this.verifyConnection();
      const metadata = await this.client.me(this.connection.token);
      if (!this.active || generation !== this.generation) return;
      this.publish({ metadata });
      if (this.state.session) {
        const session = await this.client.session(this.connection.token, this.state.session.id);
        if (this.active && generation === this.generation) this.publish({ session });
      } else if (saved.pending?.kind === "create") {
        this.prepared = true;
      } else if (saved.pending?.sessionId && saved.pending.kind !== "interaction") {
        const session = await this.client.session(this.connection.token, saved.pending.sessionId);
        this.checkOwned(session, saved.installation, metadata);
        if (this.active && generation === this.generation) this.publish({ session });
        this.prepared = true;
      } else if (!this.prepared) {
        this.observedPointer = saved.pointer;
        this.observedDefaults = JSON.stringify(saved.defaults);
        if (!this.forceNew && saved.defaults.mode !== "new" && saved.pointer) {
          const session = await this.client.session(this.connection.token, saved.pointer);
          this.checkOwned(session, saved.installation, metadata);
          const page = await this.client.events(this.connection.token, session.id);
          const expired =
            saved.sentAt[session.id] === undefined ||
            this.now() - saved.sentAt[session.id] >= saved.defaults.timeoutMinutes * 60000;
          const events =
            saved.defaults.mode === "timed" && expired && !["starting", "running"].includes(session.status)
              ? (await this.client.events(this.connection.token, session.id, { cursor: 0 })).events
              : page.events;
          if (
            reuseDecision(
              saved.defaults,
              session,
              saved.sentAt[session.id],
              this.now(),
              ongoing(session, page.questions, events, metadata),
              false,
            ) === "continue"
          ) {
            if (this.active && generation === this.generation) this.publish({ session });
          }
        }
        this.prepared = true;
      }
      if (!this.active || generation !== this.generation) return;
      this.publish({
        loading: false,
        notice: saved.pending
          ? saved.pending.kind === "interaction"
            ? "A response to a session request is unconfirmed. Check it before sending; nothing was resent."
            : "An earlier operation has an unconfirmed outcome. Check it before sending again; no message was resent."
          : this.state.session
            ? "Continue this conversation. Quick Chat defaults apply to future sessions."
            : "Ready for a new conversation. Waypoint creates it on your first send.",
      });
    } catch (error) {
      if (this.active && generation === this.generation)
        this.publish({
          loading: false,
          error: error instanceof Error ? error.message : "Could not prepare Quick Chat. Retry; the draft is kept.",
        });
    }
  }
  private checkOwned(session: Session, installation: string, metadata: ServerMetadata) {
    if (session.tags[ownerTag] !== installation || session.tags[roleTag] !== "quick-chat")
      throw new Error(
        "The saved destination is not owned by this Quick Chat installation. Choose Start New Chat; your draft is kept.",
      );
    if (!isStructured(session, metadata))
      throw new Error(
        "This session uses an unsupported interface. Open it in Waypoint or choose Start New Chat; your draft is kept.",
      );
    if (["exited", "error"].includes(session.status) && !canReattach(session, metadata))
      throw new Error(
        "This conversation cannot be resumed by its current interface. Choose Start New Chat; your draft is kept.",
      );
  }
  changeDraft(text: string) {
    this.publish({ draft: text });
    const operation = this.queue.then(() => this.store.draft(this.connection.id, this.draftKey, text));
    this.queue = operation.catch((error) =>
      this.publish({
        error: error instanceof Error ? error.message : "Could not save draft. Keep this view open and retry.",
      }),
    );
    return this.queue;
  }
  async newChat() {
    if (this.state.busy || this.state.pending) return;
    this.generation++;
    this.prepared = true;
    this.observedPointer = undefined;
    this.observedDefaults = "manual-new";
    this.publish({
      session: undefined,
      loading: false,
      error: undefined,
      notice: "A new conversation will be created on send. The previous session keeps running.",
      revision: this.state.revision + 1,
    });
  }
  async send() {
    if (
      !this.prepared ||
      this.state.busy ||
      this.state.loading ||
      !this.state.draft.trim() ||
      this.state.pending ||
      !this.state.metadata
    )
      return;
    const text = this.state.draft.trim();
    const metadata = this.state.metadata;
    this.publish({ busy: true, error: undefined, notice: undefined });
    try {
      await this.queue;
      await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (saved.pending)
          throw new Error("Another operation has an unconfirmed outcome. Check the outcome before sending.");
        await this.verifyConnection();
        let session = this.state.session;
        if (
          !session &&
          !this.forceNew &&
          saved.defaults.mode !== "new" &&
          this.observedDefaults === JSON.stringify(saved.defaults) &&
          saved.pointer &&
          saved.pointer !== this.observedPointer
        ) {
          const candidate = await this.client.session(this.connection.token, saved.pointer);
          this.checkOwned(candidate, saved.installation, metadata);
          const page = await this.client.events(this.connection.token, candidate.id);
          if (
            reuseDecision(
              saved.defaults,
              candidate,
              saved.sentAt[candidate.id],
              this.now(),
              ongoing(candidate, page.questions, page.events, metadata),
              false,
            ) === "continue"
          )
            session = candidate;
        }
        if (!session) {
          const operationId = randomUUID();
          const request = createRequest(
            this.state.defaults ?? saved.defaults,
            metadata,
            saved.installation,
            operationId,
          );
          saved.pending = { kind: "create", operationId, text, draftKey: this.draftKey, startedAt: this.now() };
          await persist();
          try {
            session = await this.client.create(this.connection.token, request);
          } catch (error) {
            if (error instanceof ApiError && error.kind !== "uncertain") {
              saved.pending = undefined;
              await persist();
            }
            throw error;
          }
          saved.pointer = session.id;
          saved.pending = undefined;
          await persist();
          this.publish({ session });
          this.checkOwned(session, saved.installation, metadata);
        } else {
          session = await this.client.session(this.connection.token, session.id);
          this.checkOwned(session, saved.installation, metadata);
        }
        if (["exited", "error"].includes(session.status)) {
          saved.pending = {
            kind: "reattach",
            operationId: randomUUID(),
            sessionId: session.id,
            text,
            draftKey: this.draftKey,
            startedAt: this.now(),
          };
          await persist();
          try {
            session = await this.client.action(this.connection.token, session.id, "reattach");
          } catch (error) {
            if (error instanceof ApiError && error.kind !== "uncertain") {
              saved.pending = undefined;
              await persist();
            }
            throw error;
          }
          saved.pending = undefined;
          await persist();
          this.publish({ session });
        }
        const before = await this.client.events(this.connection.token, session.id);
        const baseline = before.events.reduce((max, event) => Math.max(max, event.id ?? 0), 0);
        saved.pending = {
          kind: "input",
          operationId: randomUUID(),
          sessionId: session.id,
          text,
          draftKey: this.draftKey,
          startedAt: this.now(),
          baseline,
        };
        await persist();
        try {
          session = await this.client.input(this.connection.token, session.id, text);
        } catch (error) {
          if (error instanceof ApiError && error.kind !== "uncertain") {
            saved.pending = undefined;
            await persist();
          }
          throw error;
        }
        saved.pending.acknowledgedAt = this.now();
        saved.sentAt[session.id] = saved.pending.acknowledgedAt;
        if (saved.drafts[this.draftKey]?.trim() === text) saved.drafts[this.draftKey] = "";
        saved.pending = undefined;
        await persist();
        this.publish({
          session,
          draft: this.state.draft.trim() === text ? "" : this.state.draft,
          pending: undefined,
          revision: this.state.revision + 1,
          notice: "Message accepted by Waypoint.",
        });
      });
    } catch (error) {
      const saved = await this.store.load(this.connection.id).catch(() => undefined);
      this.publish({
        pending: saved?.pending,
        error: error instanceof Error ? error.message : "Send failed. Your draft is kept.",
      });
    } finally {
      this.publish({ busy: false });
    }
  }
  // Session interactions share this checkpoint; follow changes made outside this controller.
  async syncPending() {
    if (this.state.busy) return;
    try {
      await this.queue;
      const saved = await this.store.load(this.connection.id);
      if (saved.pending?.operationId === this.state.pending?.operationId) return;
      this.publish({
        pending: saved.pending,
        error: undefined,
        notice:
          saved.pending?.kind === "interaction"
            ? "A response to a session request is unconfirmed. Check it before sending; nothing was resent."
            : saved.pending
              ? "An earlier operation has an unconfirmed outcome. Check it before sending again; no message was resent."
              : undefined,
      });
    } catch {
      /* The next send re-checks the checkpoint under the lock. */
    }
  }
  async reconcile() {
    if (this.state.busy || !this.state.metadata) return;
    const metadata = this.state.metadata;
    this.publish({ busy: true, error: undefined, notice: undefined });
    try {
      await this.queue;
      await this.store.transaction(this.connection.id, async (saved, persist) => {
        const pending = saved.pending;
        if (!pending) {
          this.publish({ pending: undefined, notice: "No unconfirmed operation remains." });
          return;
        }
        await this.verifyConnection();
        if (pending.kind === "create") {
          const sessions = await this.client.sessions(this.connection.token);
          const matches = sessions.filter(
            (session) =>
              session.tags[ownerTag] === saved.installation && session.tags[createTag] === pending.operationId,
          );
          if (matches.length === 1) {
            this.checkOwned(matches[0], saved.installation, metadata);
            saved.pointer = matches[0].id;
            saved.pending = undefined;
            await persist();
            this.publish({
              session: this.state.session ?? matches[0],
              pending: undefined,
              notice: "Recovered the created conversation. The prompt was not resent. Send it when ready.",
            });
          } else
            this.publish({
              pending,
              notice: matches.length
                ? "Multiple matching sessions exist. Review them in Waypoint before retrying; none was selected."
                : "No matching session is visible yet. This does not prove creation failed. Check Waypoint before explicitly retrying.",
            });
        } else if (pending.kind === "interaction") {
          const session = await this.client.session(this.connection.token, pending.sessionId!);
          this.publish({
            pending,
            notice: `The response to a request in “${session.title || "another session"}” is unconfirmed. Check it in that conversation; nothing was resent.`,
          });
        } else {
          const session = await this.client.session(this.connection.token, pending.sessionId!);
          const page = await this.client.events(this.connection.token, session.id, { cursor: pending.baseline ?? 0 });
          const recorded = page.events.some(
            (event) => event.kind === "user_input" && event.text.trim() === pending.text,
          );
          this.publish({
            session: this.state.session && this.state.session.id !== session.id ? this.state.session : session,
            pending,
            notice:
              pending.kind === "input"
                ? recorded
                  ? "Waypoint recorded matching input. Agent delivery is still unconfirmed; retrying can duplicate the message."
                  : "No matching input is visible yet. Delivery is unconfirmed; retrying can duplicate the message."
                : `The session is ${session.status}. The ${pending.kind} outcome is not confirmed; no input was resent.`,
          });
        }
      });
    } catch (error) {
      this.publish({
        error: error instanceof Error ? error.message : "Could not check the outcome. No operation was retried.",
      });
    } finally {
      this.publish({ busy: false });
    }
  }
  async allowRetry() {
    await this.reconcile();
    if (this.state.error || !this.state.pending) return;
    const operationId = this.state.pending.operationId;
    try {
      await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (saved.pending?.operationId !== operationId)
          throw new Error("The pending operation changed. Check the outcome again.");
        saved.pending = undefined;
        await persist();
      });
      this.publish({ pending: undefined, notice: undefined });
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : "Could not authorize another attempt." });
    }
  }
  async abandonPending() {
    const pending = this.state.pending;
    if (this.state.busy || !pending) return;
    const operationId = pending.operationId;
    this.publish({ busy: true });
    try {
      await this.queue;
      await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (saved.pending?.operationId !== operationId)
          throw new Error("The pending attempt changed. Check its outcome again.");
        if (saved.pending.kind !== "interaction" && saved.pointer === saved.pending.sessionId)
          saved.pointer = undefined;
        saved.pending = undefined;
        await persist();
      });
      if (pending.kind === "interaction") {
        this.publish({ pending: undefined, error: undefined, notice: undefined });
        return;
      }
      this.generation++;
      this.prepared = true;
      this.observedDefaults = "manual-new";
      this.publish({ session: undefined, loading: false, pending: undefined, error: undefined, notice: undefined });
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : "Could not abandon the attempt." });
    } finally {
      this.publish({ busy: false });
    }
  }
  async action(action: "interrupt" | "reattach") {
    if (this.state.busy || this.state.pending || !this.state.session || !this.state.metadata) return;
    if (action === "reattach" && !canReattach(this.state.session, this.state.metadata)) return;
    const id = this.state.session.id;
    this.publish({ busy: true, error: undefined, notice: undefined });
    try {
      await this.queue;
      await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (saved.pending) throw new Error("Check the earlier operation's outcome first.");
        await this.verifyConnection();
        const current = await this.client.session(this.connection.token, id);
        if (action === "reattach" && !["exited", "error"].includes(current.status)) {
          this.publish({ session: current });
          return;
        }
        saved.pending = {
          kind: action,
          operationId: randomUUID(),
          sessionId: id,
          text: "",
          draftKey: this.draftKey,
          startedAt: this.now(),
        };
        await persist();
        let session: Session;
        try {
          session = await this.client.action(this.connection.token, id, action);
        } catch (error) {
          if (error instanceof ApiError && error.kind !== "uncertain") {
            saved.pending = undefined;
            await persist();
          }
          throw error;
        }
        saved.pending = undefined;
        await persist();
        this.publish({ session, revision: this.state.revision + 1 });
      });
    } catch (error) {
      const saved = await this.store.load(this.connection.id).catch(() => undefined);
      this.publish({
        pending: saved?.pending,
        error: error instanceof Error ? error.message : "Operation failed. Retry after checking Waypoint.",
      });
    } finally {
      this.publish({ busy: false });
    }
  }
}
