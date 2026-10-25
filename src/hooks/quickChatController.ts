import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { ApiError, WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import {
  ChatDefaults,
  canReattach,
  createRequest,
  createTag,
  launchContext,
  launchFingerprint,
  ongoing,
  ownerTag,
  reuseDecision,
  roleTag,
} from "../domain/quickChat";
import { isStructured } from "../domain/sessions";
import {
  ComposeParts,
  ContextKind,
  StagedFile,
  attachmentPolicy,
  composeMessage,
  composeParts,
  emptyParts,
  fileProblem,
  hasCompose,
  isImage,
  maxContextBytes,
  maxDraftContextBytes,
  reusableUpload,
} from "../domain/compose";
import { draftKeys } from "../storage/drafts";
import { PendingOperation, QuickChatState, QuickChatStore } from "../storage/quickChat";
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
  // Staged context and files. The message text is form-local; read it with composeText().
  compose: ComposeParts;
  // Bumped whenever the controller replaces the message text, so the form reads it again.
  composeEpoch: number;
  hasDraft: boolean;
  upload?: string;
  // A password-auth SSH target that must be connected before the failed operation can be retried.
  sshTarget?: string;
}
type Retry = "send" | "compose" | "reattach";
type FileStats = { size: number; modifiedMs: number };

const storedParts = (stored?: ComposeParts) => stored && composeParts(stored);
const attachmentIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "object" && item && typeof item.id === "string" ? [item.id] : []))
    : [];

async function fileStats(file: StagedFile): Promise<FileStats> {
  const stats = await stat(file.path).catch(() => undefined);
  const problem = fileProblem(stats && { isFile: stats.isFile(), size: stats.size });
  if (problem) throw new Error(`${file.name}: ${problem}`);
  return { size: stats!.size, modifiedMs: stats!.mtimeMs };
}
export class QuickChatController {
  private state: QuickChatSnapshot = {
    loading: true,
    busy: false,
    draft: "",
    revision: 0,
    compose: emptyParts(),
    composeEpoch: 0,
    hasDraft: false,
  };
  private composeValue = "";
  private retry?: Retry;
  private listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private observedPointer?: string;
  private observedDefaults = "";
  private prepared = false;
  private draftLoaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly draftKey: string;
  private readonly lineKey: string;
  private readonly composeKey: string;
  constructor(
    private readonly connection: FeedConnection,
    private readonly store: QuickChatStore,
    private readonly verifyConnection: () => Promise<void>,
    private readonly forceNew = false,
    private readonly client = new WaypointClient(connection.apiUrl),
    private readonly now = Date.now,
  ) {
    this.draftKey = forceNew ? "new" : "quick";
    this.lineKey = draftKeys.line(connection.id, this.draftKey);
    this.composeKey = draftKeys.compose(connection.id, this.draftKey);
  }
  canSend = () => this.prepared && !this.state.loading && !this.state.busy && !this.state.pending;
  getSnapshot = () => this.state;
  composeText = () => this.composeValue;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<QuickChatSnapshot>) {
    if (!this.active) return;
    const next = { ...this.state, ...patch };
    next.hasDraft = hasCompose({ ...next.compose, text: this.composeValue });
    this.state = next;
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
      const [saved, line, text] = await Promise.all([
        this.store.read(this.connection.id),
        this.store.drafts.read(this.lineKey),
        this.store.drafts.read(this.composeKey),
      ]);
      if (!this.active || generation !== this.generation) return;
      if (!this.draftLoaded) {
        // Drafts saved before per-key storage are carried over once.
        const legacyLine = saved.drafts[this.draftKey];
        const legacyText = saved.compose?.[this.draftKey]?.text;
        if (line === undefined && legacyLine) void this.saveDraft(this.lineKey, legacyLine);
        if (text === undefined && legacyText) void this.saveDraft(this.composeKey, legacyText);
        this.composeValue = text ?? legacyText ?? "";
      }
      this.publish({
        draft: this.draftLoaded ? this.state.draft : (line ?? saved.drafts[this.draftKey] ?? ""),
        compose: this.draftLoaded ? this.state.compose : (storedParts(saved.compose?.[this.draftKey]) ?? emptyParts()),
        composeEpoch: this.draftLoaded ? this.state.composeEpoch : this.state.composeEpoch + 1,
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
      } else if (!this.prepared && this.forceNew) {
        const session = await this.emptyBoundSession(saved, metadata);
        if (session && this.active && generation === this.generation) this.publish({ session });
        this.prepared = true;
      } else if (!this.prepared) {
        this.observedPointer = saved.pointer;
        this.observedDefaults = JSON.stringify(saved.defaults);
        if (!this.forceNew && saved.defaults.mode !== "new" && saved.pointer) {
          const session = await this.savedConversation(saved.pointer);
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
  private async savedConversation(id: string) {
    try {
      return await this.client.session(this.connection.token, id);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "not-found")
        throw new Error(
          "Your last Quick Chat conversation is no longer on this server. Choose Start New Chat; your draft is kept.",
        );
      throw error;
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
  private saveDraft(key: string, text: string) {
    return this.store.drafts
      .write(key, text)
      .catch(() => this.publish({ error: "Could not save draft. Keep this view open and retry." }));
  }
  changeDraft(text: string) {
    this.publish({ draft: text });
    return this.saveDraft(this.lineKey, text);
  }
  // Keystrokes stay in the form; only a change in whether a draft exists is published.
  setComposeText(text: string) {
    this.composeValue = text;
    if (hasCompose({ ...this.state.compose, text }) !== this.state.hasDraft) this.publish({});
    return this.saveDraft(this.composeKey, text);
  }
  private replaceComposeText(text: string) {
    this.composeValue = text;
    this.publish({ composeEpoch: this.state.composeEpoch + 1 });
    return this.saveDraft(this.composeKey, text);
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
  // A session a New Chat send created for this draft but never delivered input to is continued, not replaced.
  private boundSession?: Promise<Session | undefined>;
  private emptyBoundSession(saved: QuickChatState, metadata: ServerMetadata) {
    const bound = saved.compose?.[this.draftKey]?.sessionId;
    if (!bound || saved.sentAt[bound] !== undefined) return Promise.resolve(undefined);
    this.boundSession ??= (async () => {
      try {
        const session = await this.client.session(this.connection.token, bound);
        this.checkOwned(session, saved.installation, metadata);
        // Defaults changed since the session was created: the next send starts a session with the new ones.
        const launch = saved.compose?.[this.draftKey]?.launch;
        if (!launch || launch !== launchFingerprint(createRequest(saved.defaults, metadata, saved.installation, "")))
          return undefined;
        const page = await this.client.events(this.connection.token, bound, { cursor: 0 });
        return page.events.some((event) => event.kind === "user_input") ? undefined : session;
      } catch {
        return undefined;
      }
    })();
    return this.boundSession;
  }
  private persistCompose(compose: ComposeParts) {
    this.publish({ compose });
    const operation = this.queue.then(() =>
      this.store.transaction(this.connection.id, async (saved, persist) => {
        saved.compose = { ...saved.compose, [this.draftKey]: compose };
        await persist();
      }),
    );
    this.queue = operation.catch((error) =>
      this.publish({
        error: error instanceof Error ? error.message : "Could not save draft. Keep this view open and retry.",
      }),
    );
    return this.queue;
  }
  // Moves the single-line draft into an empty compose draft so the text isn't sent twice.
  openCompose() {
    if (this.state.busy || this.state.hasDraft || !this.state.draft.trim()) return Promise.resolve();
    const text = this.state.draft;
    void this.changeDraft("");
    return this.replaceComposeText(text);
  }
  stageContext(kind: ContextKind, text: string) {
    if (this.state.busy) return this.queue;
    if (Buffer.byteLength(text) > maxContextBytes) {
      this.publish({ error: "That text is larger than 256 KB. Attach it as a file instead." });
      return this.queue;
    }
    const staged = this.state.compose.context.reduce((total, item) => total + Buffer.byteLength(item.text), 0);
    if (staged + Buffer.byteLength(text) > maxDraftContextBytes) {
      this.publish({ error: "This draft already has 1 MB of context. Remove some before adding more." });
      return this.queue;
    }
    void this.openCompose();
    return this.persistCompose({
      ...this.state.compose,
      context: [...this.state.compose.context, { id: randomUUID(), kind, text }],
    });
  }
  removeContext(id: string) {
    if (this.state.busy) return this.queue;
    return this.persistCompose({
      ...this.state.compose,
      context: this.state.compose.context.filter((item) => item.id !== id),
    });
  }
  async addFiles(paths: string[]): Promise<string[]> {
    if (this.state.busy) return [];
    const problems: string[] = [];
    const files = [...this.state.compose.files];
    for (const path of paths) {
      if (files.some((file) => file.path === path)) continue;
      const file: StagedFile = {
        id: randomUUID(),
        path,
        name: path.split(/[\\/]/).pop() || path,
        size: 0,
        modifiedMs: 0,
      };
      try {
        const stats = await fileStats(file);
        files.push({ ...file, ...stats });
      } catch (error) {
        problems.push(error instanceof Error ? error.message : `${file.name} cannot be attached.`);
      }
    }
    await this.persistCompose({ ...this.state.compose, files });
    return problems;
  }
  async removeFiles(ids: string[]) {
    if (this.state.busy) return;
    this.publish({ busy: true, error: undefined });
    try {
      await this.queue;
      const doomed = await this.store.transaction(this.connection.id, async (saved, persist) => {
        const draft = storedParts(saved.compose?.[this.draftKey]) ?? this.state.compose;
        const removed = draft.files.filter((file) => ids.includes(file.id));
        const next = { ...draft, files: draft.files.filter((file) => !ids.includes(file.id)) };
        saved.compose = { ...saved.compose, [this.draftKey]: next };
        await persist();
        this.publish({ compose: next });
        // A pending send may already have delivered these uploads; only unreferenced ones are deleted.
        const protectedIds = new Set(saved.pending?.attachments ?? []);
        return removed.flatMap((file) =>
          file.upload && !protectedIds.has(file.upload.attachmentId) ? [file.upload] : [],
        );
      });
      await Promise.all(
        doomed.map((upload) =>
          this.client
            .deleteAttachment(this.connection.token, upload.sessionId, upload.attachmentId)
            .catch(() => undefined),
        ),
      );
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : "Could not remove the file." });
    } finally {
      this.publish({ busy: false });
    }
  }
  async discardCompose() {
    await this.removeFiles(this.state.compose.files.map((file) => file.id));
    if (this.state.error) return;
    await this.persistCompose(emptyParts());
    await this.replaceComposeText("");
  }
  private checkPolicy(files: StagedFile[], agentId: string | undefined, targetId: string | undefined) {
    if (!files.length) return;
    const metadata = this.state.metadata!;
    const agent = metadata.agents.find((entry) => entry.id === agentId);
    const remote = !!targetId && metadata.targets.some((target) => target.id === targetId);
    const policy = attachmentPolicy(agentId ?? "", agent?.attachments === true, remote);
    const blocked = files.find((file) => !(isImage(file.path) ? policy.images : policy.files));
    if (blocked) throw new Error(`${blocked.name}: ${policy.reason ?? "This file cannot be attached here."}`);
  }
  private sshFailure(error: unknown, targetId: string | undefined, retry: Retry) {
    const target = this.state.metadata?.targets.find((entry) => entry.id === targetId);
    if (error instanceof ApiError && error.detail === "ssh-master-required" && target?.auth === "password") {
      this.retry = retry;
      this.publish({ sshTarget: target.id });
      return new ApiError("rejected", `Connect ${target.name} to continue. Your draft is kept.`, error.detail, 409);
    }
    return error;
  }
  private async upload(
    session: Session,
    stats: Map<string, FileStats>,
    saved: QuickChatState,
    persist: () => Promise<void>,
    fence: () => Promise<void>,
  ): Promise<string[]> {
    const draft = saved.compose![this.draftKey];
    const ids: string[] = [];
    const stale: { sessionId: string; attachmentId: string }[] = [];
    const protectedIds = new Set(saved.pending?.attachments ?? []);
    for (const [index, file] of draft.files.entries()) {
      const current = stats.get(file.id)!;
      const unchanged = current.size === file.size && current.modifiedMs === file.modifiedMs;
      const reusable = unchanged ? reusableUpload(file, session.id, this.now()) : undefined;
      if (reusable) {
        ids.push(reusable.attachmentId);
        continue;
      }
      if (file.upload && file.upload.sessionId !== session.id && !protectedIds.has(file.upload.attachmentId))
        stale.push(file.upload);
      this.publish({ upload: `Uploading ${file.name} (${index + 1} of ${draft.files.length})` });
      await fence();
      const attachment = await this.client.uploadAttachment(this.connection.token, session.id, file.path, current.size);
      Object.assign(file, current, {
        upload: { sessionId: session.id, attachmentId: attachment.id, uploadedAt: this.now() },
      });
      await persist();
      this.publish({ compose: structuredClone(draft) });
      ids.push(attachment.id);
    }
    this.publish({ upload: undefined });
    await Promise.all(
      stale.map((upload) =>
        this.client
          .deleteAttachment(this.connection.token, upload.sessionId, upload.attachmentId)
          .catch(() => undefined),
      ),
    );
    return ids;
  }
  async send(fromCompose = false) {
    const compose = fromCompose ? { ...this.state.compose, text: this.composeValue } : undefined;
    const text = compose ? composeMessage(compose.text, compose.context) : this.state.draft.trim();
    if (
      !this.prepared ||
      this.state.busy ||
      this.state.loading ||
      (!text && !compose?.files.length) ||
      this.state.pending ||
      !this.state.metadata
    )
      return false;
    const metadata = this.state.metadata;
    let sent = false;
    let remaining = emptyParts();
    let cleared = false;
    this.publish({ busy: true, error: undefined, notice: undefined, sshTarget: undefined });
    try {
      await this.queue;
      const stats = new Map<string, FileStats>();
      for (const file of compose?.files ?? []) stats.set(file.id, await fileStats(file));
      await this.store.transaction(this.connection.id, async (saved, persist, fence) => {
        if (saved.pending)
          throw new Error("Another operation has an unconfirmed outcome. Check the outcome before sending.");
        await this.verifyConnection();
        if (compose)
          saved.compose = {
            ...saved.compose,
            [this.draftKey]: storedParts(saved.compose?.[this.draftKey]) ?? composeParts(compose),
          };
        const draft = compose ? saved.compose![this.draftKey] : undefined;
        let session = this.state.session;
        if (
          !session &&
          !this.forceNew &&
          saved.defaults.mode !== "new" &&
          this.observedDefaults === JSON.stringify(saved.defaults) &&
          saved.pointer &&
          saved.pointer !== this.observedPointer
        ) {
          const candidate = await this.savedConversation(saved.pointer);
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
          const defaults = this.state.defaults ?? saved.defaults;
          this.checkPolicy(draft?.files ?? [], launchContext(defaults, metadata).backend, defaults.target || undefined);
          const operationId = randomUUID();
          const request = createRequest(defaults, metadata, saved.installation, operationId);
          saved.pending = { kind: "create", operationId, text, draftKey: this.draftKey, startedAt: this.now() };
          await persist();
          try {
            session = await this.client.create(this.connection.token, request);
          } catch (error) {
            if (error instanceof ApiError && error.kind !== "uncertain") {
              saved.pending = undefined;
              await persist();
            }
            throw this.sshFailure(error, defaults.target || undefined, fromCompose ? "compose" : "send");
          }
          saved.pointer = session.id;
          saved.pending = undefined;
          if (draft) Object.assign(draft, { sessionId: session.id, launch: launchFingerprint(request) });
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
            throw this.sshFailure(error, session.targetId, fromCompose ? "compose" : "send");
          }
          saved.pending = undefined;
          await persist();
          this.publish({ session });
        }
        if (draft) {
          this.checkPolicy(draft.files, session.backend, session.targetId);
          draft.sessionId = session.id;
        }
        let attachments = draft ? await this.upload(session, stats, saved, persist, fence) : [];
        const before = await this.client.events(this.connection.token, session.id);
        const baseline = before.events.reduce((max, event) => Math.max(max, event.id ?? 0), 0);
        for (let attempt = 0; ; attempt++) {
          saved.pending = {
            kind: "input",
            operationId: randomUUID(),
            sessionId: session.id,
            text,
            draftKey: this.draftKey,
            startedAt: this.now(),
            baseline,
            ...(attachments.length ? { attachments } : {}),
          };
          await persist();
          try {
            await fence();
            session = await this.client.input(this.connection.token, session.id, text, attachments);
            break;
          } catch (error) {
            if (error instanceof ApiError && error.kind !== "uncertain") {
              saved.pending = undefined;
              await persist();
            }
            // Waypoint rejects unknown attachment IDs before recording input, so one refresh is safe.
            if (!(error instanceof ApiError && error.detail === "attachment-missing" && draft && attempt === 0))
              throw this.sshFailure(error, session.targetId, fromCompose ? "compose" : "send");
            const present = new Set(await this.client.attachments(this.connection.token, session.id));
            for (const file of draft.files)
              if (file.upload && !present.has(file.upload.attachmentId)) file.upload = undefined;
            await persist();
            attachments = await this.upload(session, stats, saved, persist, fence);
          }
        }
        saved.pending!.acknowledgedAt = this.now();
        saved.sentAt[session.id] = saved.pending!.acknowledgedAt;
        // Sent text is cleared before the checkpoint, so a crash in between still blocks a duplicate send.
        // Text edited during the send differs from what was sent and is kept.
        if (draft && compose) {
          if (this.composeValue === compose.text) {
            this.composeValue = "";
            cleared = true;
            await this.store.drafts.write(this.composeKey, "");
          }
          const sentContext = new Set(compose.context.map((item) => item.id));
          const sentFiles = new Set(compose.files.map((file) => file.id));
          const rest: ComposeParts = {
            context: draft.context.filter((item) => !sentContext.has(item.id)),
            files: draft.files.filter((file) => !sentFiles.has(file.id)),
          };
          if (rest.context.length || rest.files.length) saved.compose![this.draftKey] = rest;
          else delete saved.compose![this.draftKey];
          remaining = saved.compose![this.draftKey] ?? emptyParts();
        } else if (this.state.draft.trim() === text) await this.store.drafts.write(this.lineKey, "");
        saved.pending = undefined;
        await persist();
        sent = true;
        this.publish({
          session,
          ...(compose
            ? { compose: remaining, ...(cleared ? { composeEpoch: this.state.composeEpoch + 1 } : {}) }
            : { draft: this.state.draft.trim() === text ? "" : this.state.draft }),
          pending: undefined,
          revision: this.state.revision + 1,
          notice: "Message accepted by Waypoint.",
        });
      });
    } catch (error) {
      const saved = await this.store.read(this.connection.id).catch(() => undefined);
      this.publish({
        pending: saved?.pending,
        ...(saved?.compose?.[this.draftKey] ? { compose: composeParts(saved.compose[this.draftKey]) } : {}),
        error: error instanceof Error ? error.message : "Send failed. Your draft is kept.",
      });
    } finally {
      this.publish({ busy: false, upload: undefined });
    }
    return sent;
  }
  async connectTarget(password: string): Promise<{ connected: boolean; detail?: string }> {
    const target = this.state.sshTarget;
    if (!target) return { connected: false, detail: "No execution target needs a connection." };
    const result = await this.client.connectTarget(this.connection.token, target, password);
    if (!result.connected) return result;
    this.publish({ sshTarget: undefined, error: undefined });
    const retry = this.retry;
    this.retry = undefined;
    if (retry === "reattach") await this.action("reattach");
    else if (retry) await this.send(retry === "compose");
    return result;
  }
  // Session interactions share this checkpoint; follow changes made outside this controller.
  async syncPending() {
    if (this.state.busy) return;
    try {
      await this.queue;
      const saved = await this.store.read(this.connection.id);
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
          const expected = [...(pending.attachments ?? [])].sort().join(",");
          const recorded = page.events.some(
            (event) =>
              event.kind === "user_input" &&
              event.text.trim() === pending.text &&
              attachmentIds(event.metadata.attachments).sort().join(",") === expected,
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
  // Uploads in an unconfirmed send may have been delivered, so they are dropped from the draft, never deleted.
  private forgetUploads(saved: QuickChatState) {
    const ids = new Set(saved.pending?.attachments ?? []);
    const draft = saved.compose?.[this.draftKey];
    if (!ids.size || !draft) return;
    for (const file of draft.files) if (file.upload && ids.has(file.upload.attachmentId)) file.upload = undefined;
    this.publish({ compose: composeParts(structuredClone(draft)) });
  }
  async allowRetry() {
    await this.reconcile();
    if (this.state.error || !this.state.pending) return;
    const operationId = this.state.pending.operationId;
    try {
      await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (saved.pending?.operationId !== operationId)
          throw new Error("The pending operation changed. Check the outcome again.");
        this.forgetUploads(saved);
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
        this.forgetUploads(saved);
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
          throw action === "reattach" ? this.sshFailure(error, current.targetId, "reattach") : error;
        }
        saved.pending = undefined;
        await persist();
        this.publish({ session, revision: this.state.revision + 1 });
      });
    } catch (error) {
      const saved = await this.store.read(this.connection.id).catch(() => undefined);
      this.publish({
        pending: saved?.pending,
        error: error instanceof Error ? error.message : "Operation failed. Retry after checking Waypoint.",
      });
    } finally {
      this.publish({ busy: false });
    }
  }
}
