import { randomUUID } from "node:crypto";
import { WaypointClient, ApiError } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { PendingQuestions, Session, SessionEvent } from "../api/sessions";
import {
  Interaction,
  InteractionDraft,
  cancelRequest,
  interactionRequest,
  isLive,
  preDispatchDetails,
  openInteractionKeys,
  plansDecisions,
  sessionInteractions,
} from "../domain/interactions";
import { mergeEvents, newerQuestions } from "../domain/transcript";
import { QuickChatStore, PendingOperation } from "../storage/quickChat";
import { FeedConnection, ConversationSnapshot } from "./sessionFeeds";
import { isStructured } from "../domain/sessions";

export interface InteractionSnapshot {
  loading: boolean;
  busy: boolean;
  interactions: Interaction[];
  drafts: Record<string, InteractionDraft>;
  pending?: PendingOperation;
  error?: string;
  notice?: string;
  outcome?: Outcome;
  revision: number;
}
export type Outcome = "pending" | "resolved" | "elsewhere";

const needsHistory = (session: Session, metadata: ServerMetadata) =>
  isStructured(session, metadata) && (isLive(session) || plansDecisions(session, metadata));
const requestEvent = (event: SessionEvent) =>
  event.kind === "approval_request" ||
  event.metadata.item_type === "plan" ||
  (event.kind === "system_note" &&
    (typeof event.metadata.method === "string" || typeof event.metadata.plan_item_id === "string"));
const unsaved =
  "Waypoint accepted the response, but this computer could not clear its saved attempt. Check the outcome, then clear it.";
const definitive = new Set(["expired-token", "not-found", "rejected"]);
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export class InteractionController {
  private state: InteractionSnapshot = { loading: true, busy: false, interactions: [], drafts: {}, revision: 0 };
  private listeners = new Set<() => void>();
  private session?: Session;
  private events: SessionEvent[] = [];
  private questions?: PendingQuestions;
  // What each feed last delivered, so a resumed feed's cached snapshot cannot override newer state.
  private delivered = new WeakMap<object, { session?: Session; questions?: PendingQuestions }>();
  private questionSource?: object;
  private questionChanges = 0;
  private sessionChanges = 0;
  // Highest event ID covered by the full-history load; undefined until history is loaded.
  private watermark?: number;
  private historyRequested = false;
  private historyFollowUp = false;
  // Requests Waypoint proved are no longer pending, though history still lists them.
  private notPending = new Set<string>();
  private generation = 0;
  private active = true;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly connection: FeedConnection,
    private readonly sessionId: string,
    private metadata: ServerMetadata,
    private readonly store: QuickChatStore,
    private readonly verifyConnection: () => Promise<void>,
    private readonly client = new WaypointClient(connection.apiUrl),
    private readonly now = Date.now,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<InteractionSnapshot>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private interactions() {
    if (!this.session) return [];
    return sessionInteractions(
      this.session,
      this.metadata,
      this.events,
      this.questions,
      this.watermark !== undefined,
    ).map((interaction) =>
      this.notPending.has(interaction.key)
        ? {
            ...interaction,
            availability: "unavailable" as const,
            reason: "This request is no longer pending. Open it in Waypoint to check.",
          }
        : interaction,
    );
  }
  private derive() {
    this.publish({ interactions: this.interactions() });
  }
  owns(pending?: PendingOperation): pending is PendingOperation {
    return pending?.kind === "interaction" && pending.sessionId === this.sessionId;
  }
  draftKey(interaction: Interaction) {
    return `${this.sessionId}:${interaction.key}:${interaction.signature}`;
  }
  start() {
    this.active = true;
    return this.refresh();
  }
  stop() {
    this.active = false;
    this.generation++;
  }
  ingest(snapshot: ConversationSnapshot, source: object = this) {
    if (snapshot.session && snapshot.session.id !== this.sessionId) return;
    const seen = this.delivered.get(source) ?? {};
    this.delivered.set(source, { session: snapshot.session, questions: snapshot.questions });
    if (snapshot.session && snapshot.session !== seen.session) {
      this.session = snapshot.session;
      this.sessionChanges++;
    }
    this.events = mergeEvents(this.events, snapshot.events, this.sessionId);
    if (snapshot.questions && snapshot.questions !== seen.questions) {
      // A feed resolves its own socket epochs, so its newer snapshot replaces its previous one outright.
      this.questions =
        source === this.questionSource ? snapshot.questions : newerQuestions(this.questions, snapshot.questions);
      this.questionSource = source;
      this.questionChanges++;
    }
    this.derive();
    if (
      this.session &&
      !this.historyRequested &&
      (needsHistory(this.session, this.metadata) || snapshot.events.some(requestEvent))
    ) {
      this.historyRequested = true;
      // A refresh already in flight may have decided to skip history; follow it with one that loads it.
      if (this.state.loading) this.historyFollowUp = true;
      else void this.refresh();
    }
  }
  // Full history is fetched once, only when approvals or plans can be pending; later reads fetch deltas.
  private async snapshot() {
    await this.verifyConnection();
    const [session, metadata, tail] = await Promise.all([
      this.client.session(this.connection.token, this.sessionId),
      this.client.me(this.connection.token),
      this.client.events(this.connection.token, this.sessionId),
    ]);
    let watermark = this.watermark;
    let events = tail.events;
    if (watermark !== undefined || needsHistory(session, metadata) || this.historyRequested) {
      this.historyRequested = true;
      const history = await this.client.events(this.connection.token, this.sessionId, { cursor: watermark ?? 0 });
      watermark = history.events.reduce((max, event) => Math.max(max, event.id ?? 0), watermark ?? 0);
      events = mergeEvents(history.events, tail.events, this.sessionId);
    }
    return { session, metadata, events, questions: tail.questions, watermark };
  }
  private adopt(
    fresh: Awaited<ReturnType<InteractionController["snapshot"]>>,
    sessionChanges = this.sessionChanges,
    questionChanges = this.questionChanges,
  ) {
    this.metadata = fresh.metadata;
    this.events = mergeEvents(fresh.events, this.events, this.sessionId);
    if (fresh.watermark !== undefined) this.watermark = Math.max(fresh.watermark, this.watermark ?? 0);
    if (sessionChanges === this.sessionChanges) this.session = fresh.session;
    if (fresh.questions)
      this.questions =
        questionChanges === this.questionChanges ? fresh.questions : newerQuestions(this.questions, fresh.questions);
    this.derive();
  }
  async refresh() {
    const generation = ++this.generation;
    const sessionChanges = this.sessionChanges;
    const questionChanges = this.questionChanges;
    this.publish({ loading: true, error: undefined });
    try {
      await this.queue;
      const [fresh, saved] = await Promise.all([this.snapshot(), this.store.load(this.connection.id)]);
      if (!this.active || generation !== this.generation) return;
      this.adopt(fresh, sessionChanges, questionChanges);
      this.publish({
        loading: false,
        pending: saved.pending,
        ...(saved.pending?.operationId !== this.state.pending?.operationId ? { outcome: undefined } : {}),
        drafts: { ...saved.interactionDrafts, ...this.state.drafts },
      });
      await this.prune();
    } catch (error) {
      if (this.active && generation === this.generation)
        this.publish({ loading: false, error: message(error, "Could not refresh requests.") });
    }
    if (this.historyFollowUp && this.watermark === undefined && this.active && generation === this.generation) {
      this.historyFollowUp = false;
      await this.refresh();
    }
  }
  // Only an authoritative refresh may prune; filtered visibility must never discard a live request's draft.
  private async prune() {
    if (!this.session || !this.questions) return;
    const history = this.watermark !== undefined;
    if (!history && needsHistory(this.session, this.metadata)) return;
    const open = openInteractionKeys(history ? this.events : [], this.questions);
    const prefix = `${this.sessionId}:`;
    const keep = (key: string, pending?: PendingOperation) =>
      !key.startsWith(prefix) || open.has(key.slice(prefix.length, key.lastIndexOf(":"))) || pending?.draftKey === key;
    const operation = this.queue.then(() =>
      this.store.transaction(this.connection.id, async (saved, persist) => {
        const drafts = saved.interactionDrafts ?? {};
        const stale = Object.keys(drafts).filter((key) => !keep(key, saved.pending));
        if (!stale.length) return;
        stale.forEach((key) => delete drafts[key]);
        await persist();
      }),
    );
    this.queue = operation.catch(() => undefined);
    await this.queue;
    this.publish({
      drafts: Object.fromEntries(Object.entries(this.state.drafts).filter(([key]) => keep(key, this.state.pending))),
    });
  }
  changeDraft(interaction: Interaction, draft: InteractionDraft) {
    const key = this.draftKey(interaction);
    this.publish({ drafts: { ...this.state.drafts, [key]: draft } });
    const operation = this.queue.then(() =>
      this.store.transaction(this.connection.id, async (saved, persist) => {
        saved.interactionDrafts = { ...saved.interactionDrafts, [key]: draft };
        await persist();
      }),
    );
    this.queue = operation.catch(() =>
      this.publish({ error: "Could not save this response. Keep this form open and retry." }),
    );
    return this.queue;
  }
  async submit(captured: Interaction, draft: InteractionDraft, cancel = false): Promise<boolean> {
    if (this.state.busy || this.state.loading) return false;
    this.publish({ busy: true, error: undefined, notice: undefined });
    const draftKey = this.draftKey(captured);
    let acknowledged = false;
    let settled = false;
    try {
      if (!cancel) await this.changeDraft(captured, draft);
      await this.queue;
      await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (saved.pending)
          throw new Error(
            saved.pending.kind === "interaction"
              ? "An earlier response is unconfirmed. Check its outcome first."
              : "A Quick Chat operation is unconfirmed. Check it in Quick Chat first.",
          );
        const fresh = await this.snapshot();
        this.questionChanges++;
        this.sessionChanges++;
        this.adopt(fresh);
        const current = this.interactions().find((item) => item.key === captured.key);
        if (!current) throw new Error("This request was resolved or replaced.");
        if (current.signature !== captured.signature)
          throw new Error("This request changed. Review its current version.");
        if (current.availability !== "actionable")
          throw new Error(current.reason ?? "This request is not ready for a response yet.");
        const request = cancel ? cancelRequest(current) : interactionRequest(current, draft);
        saved.pending = {
          kind: "interaction",
          operationId: randomUUID(),
          sessionId: this.sessionId,
          interactionKey: captured.key,
          interactionAction: request.action,
          draftKey,
          text: "",
          startedAt: this.now(),
        };
        await persist();
        let session: Session;
        try {
          session = await this.client.interaction(
            this.connection.token,
            this.sessionId,
            request.action,
            request.body,
            preDispatchDetails(current, fresh.session.backend),
          );
        } catch (error) {
          if (error instanceof ApiError && definitive.has(error.kind)) {
            saved.pending = undefined;
            await persist();
            if (error.status === 400) {
              this.notPending.add(captured.key);
              this.derive();
            }
          }
          throw error;
        }
        acknowledged = true;
        this.session = session;
        this.sessionChanges++;
        saved.pending = undefined;
        if (saved.interactionDrafts) delete saved.interactionDrafts[draftKey];
        await persist();
        settled = true;
      });
    } catch (error) {
      const saved = await this.store.load(this.connection.id).catch(() => undefined);
      this.publish({
        pending: saved?.pending,
        error: acknowledged ? unsaved : message(error, "Could not send the response."),
      });
    }
    if (settled) {
      const drafts = { ...this.state.drafts };
      delete drafts[draftKey];
      this.publish({
        pending: undefined,
        drafts,
        revision: this.state.revision + 1,
        notice: cancel ? "Question cancelled." : "Response sent.",
      });
    }
    this.publish({ busy: false });
    if (acknowledged) {
      await this.refresh();
      if (!settled) this.publish({ error: unsaved });
    }
    return settled;
  }
  async checkOutcome(): Promise<Outcome | undefined> {
    await this.refresh();
    const pending = this.state.pending;
    if (this.state.error || pending?.kind !== "interaction") return;
    const outcome: Outcome =
      pending.sessionId !== this.sessionId
        ? "elsewhere"
        : this.state.interactions.some((item) => item.key === pending.interactionKey)
          ? "pending"
          : "resolved";
    this.publish({
      outcome,
      notice:
        outcome === "elsewhere"
          ? "The unconfirmed response belongs to another conversation. Open it to check the outcome."
          : outcome === "resolved"
            ? "The request is no longer pending. Clear the checkpoint to continue."
            : "The request is still pending. The response may not have reached the agent; another attempt can repeat its effect.",
    });
    return outcome;
  }
  async releasePending() {
    const pending = this.state.pending;
    if (this.state.busy || !this.owns(pending)) return;
    this.publish({ busy: true, error: undefined, notice: undefined });
    try {
      await this.queue;
      await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (saved.pending?.operationId !== pending.operationId)
          throw new Error("The unconfirmed attempt changed. Check it again.");
        saved.pending = undefined;
        await persist();
      });
      this.publish({ pending: undefined, outcome: undefined, notice: undefined });
    } catch (error) {
      this.publish({ error: message(error, "Could not clear the attempt.") });
    } finally {
      this.publish({ busy: false });
    }
    await this.refresh();
  }
}
