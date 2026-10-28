import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { ApiError, WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { Session, SessionEvent } from "../api/sessions";
import {
  ChatDefaults,
  canReattach,
  createRequest,
  createTag,
  customLaunch,
  failedStartAt,
  launchContext,
  launchFingerprint,
  ongoing,
  ownerTag,
  reuseDecision,
} from "../domain/quickChat";
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
import { sessionProblem } from "../domain/sessionActions";
import { draftKeys, sessionChatDraft } from "../storage/drafts";
import {
  LaunchOrigin,
  PendingOperation,
  QuickChatState,
  QuickChatStore,
  lastActivity,
  setPointer,
} from "../storage/quickChat";
import { Workspace } from "../storage/workspace";
import { ClipboardFiles } from "../storage/clipboardFiles";
import { ManageOutcome, Released, SessionManager, refused, release } from "./sessionManager";
import { restartTimeoutMs } from "./sessionSettingsController";
import {
  LaunchDeps,
  LaunchResult,
  TargetConnectionRequired,
  createInTransaction,
  launchSession,
  ownershipProblem,
} from "./sessionLauncher";
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
  // Whether this view started the pending operation and may act on its session.
  pendingOwned: boolean;
  // Why a chat bound to one session can't send to it; the conversation stays readable.
  blocked?: string;
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
// `staged` paths entered the draft and went to be saved; a path not staged never reached storage.
export interface AddedFiles {
  problems: string[];
  staged: string[];
}
type FileStats = { size: number; modifiedMs: number };

// Pages read back when checking whether an unconfirmed message was recorded.
const outcomePages = 20;
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
// `ended` means Quick Chat no longer continues the session; `message` explains a failure or an unconfirmed result.
// `partial` is a delete that ended the session but didn't remove it; `unconfirmed` may still have done either.
export type TerminateResult =
  { ended: false; message: string } | { ended: true; outcome: "done" | "unconfirmed" | "partial"; message?: string };
// Draft keys of Quick Chat and New Chat; each keeps its own draft and binding per server.
export const quickChatDraft = "quick";
export const newChatDraft = "new";
const quickChatFamily = (draftKey: string) => draftKey === quickChatDraft || draftKey === newChatDraft;
// Quick Chat follows its saved destination, `resume` regardless of the reuse mode and timeout; New Chat starts a new
// conversation; a session chat sends only to its session and never changes Quick Chat's destination.
export type ChatDestination =
  { kind: "quick"; resume?: boolean } | { kind: "new" } | { kind: "session"; sessionId: string };
const goneMessage = "This session is no longer on this server.";
export class QuickChatController {
  private state: QuickChatSnapshot = {
    loading: true,
    busy: false,
    draft: "",
    pendingOwned: false,
    revision: 0,
    compose: emptyParts(),
    composeEpoch: 0,
    hasDraft: false,
  };
  private composeValue = "";
  private composeSaves = 0;
  private retry?: Retry;
  private listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private observedPointer?: string;
  private observedDefaults = "";
  private prepared = false;
  // A destination that turned out to be gone or unusable; Start New Chat clears it.
  private deadPointer?: string;
  private readonly forceNew: boolean;
  private readonly resume: boolean;
  private readonly boundTo?: string;
  // The bound session was deleted; nothing is saved for it again, so its removed drafts stay removed.
  private gone = false;
  private forgotten = false;
  private readonly workspace?: Workspace;
  private readonly clipboardFiles?: ClipboardFiles;
  private draftLoaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly draftKey: string;
  private readonly lineKey: string;
  private readonly composeKey: string;
  constructor(
    private readonly connection: FeedConnection,
    private readonly store: QuickChatStore,
    private readonly verifyConnection: () => Promise<void>,
    options: { destination?: ChatDestination; workspace?: Workspace; clipboardFiles?: ClipboardFiles } = {},
    private readonly client = new WaypointClient(connection.apiUrl),
    private readonly now = Date.now,
  ) {
    const destination = options.destination ?? { kind: "quick" };
    this.forceNew = destination.kind === "new";
    this.resume = destination.kind === "quick" && !!destination.resume;
    this.boundTo = destination.kind === "session" ? destination.sessionId : undefined;
    this.workspace = options.workspace;
    this.clipboardFiles = options.clipboardFiles;
    this.draftKey = this.boundTo ? sessionChatDraft(this.boundTo) : this.forceNew ? newChatDraft : quickChatDraft;
    this.lineKey = draftKeys.line(connection.id, this.draftKey);
    this.composeKey = draftKeys.compose(connection.id, this.draftKey);
  }
  canSend = () =>
    this.prepared && !this.state.loading && !this.state.busy && !this.state.pending && !this.state.blocked;
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
    next.pendingOwned = this.ownsPending(next.pending);
    if (this.boundTo)
      next.blocked = this.gone
        ? goneMessage
        : next.session && next.metadata
          ? sessionProblem(next.session, next.metadata)
          : undefined;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
  stop() {
    this.active = false;
    this.generation++;
  }
  // Quick Chat and New Chat share their operations; a session chat owns only its own. Interaction responses belong
  // to the conversation that answered them.
  private ownsPending(pending?: PendingOperation): boolean {
    if (!pending || pending.kind === "interaction") return false;
    return this.boundTo ? pending.draftKey === this.draftKey : quickChatFamily(pending.draftKey);
  }
  async start() {
    this.active = true;
    const generation = ++this.generation;
    void this.clipboardFiles?.sweep();
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
      // Another view that cleared or replaced the checkpoint may have dropped uploads from these parts.
      const reload = !this.draftLoaded || saved.pending?.operationId !== this.state.pending?.operationId;
      this.publish({
        draft: this.draftLoaded ? this.state.draft : (line ?? saved.drafts[this.draftKey] ?? ""),
        compose: reload ? (storedParts(saved.compose?.[this.draftKey]) ?? emptyParts()) : this.state.compose,
        composeEpoch: this.draftLoaded ? this.state.composeEpoch : this.state.composeEpoch + 1,
        defaults: saved.defaults,
        pending: saved.pending,
      });
      this.draftLoaded = true;
      await this.verifyConnection();
      const metadata = await this.client.me(this.connection.token);
      if (!this.active || generation !== this.generation) return;
      this.publish({ metadata });
      const owned = this.ownsPending(saved.pending);
      if (this.boundTo) {
        const session = await this.readSession(this.boundTo);
        if (this.active && generation === this.generation) this.publish({ session });
        this.prepared = true;
      } else if (this.state.session) {
        const session = await this.client.session(this.connection.token, this.state.session.id);
        if (this.active && generation === this.generation) this.publish({ session });
      } else if (owned && saved.pending?.kind === "create") {
        this.prepared = true;
      } else if (owned && saved.pending?.sessionId) {
        const session = await this.client.session(this.connection.token, saved.pending.sessionId);
        this.checkOwned(session, saved, metadata);
        if (this.active && generation === this.generation) this.publish({ session });
        this.prepared = true;
      } else if (!this.prepared && this.forceNew) {
        const session = await this.emptyBoundSession(saved, metadata);
        if (session && this.active && generation === this.generation) this.publish({ session });
        this.prepared = true;
      } else if (!this.prepared) {
        this.observedPointer = saved.pointer;
        this.observedDefaults = JSON.stringify(saved.defaults);
        // Always New skips the saved destination, except an unused session started from chosen settings.
        const unused =
          !this.resume &&
          saved.defaults.mode === "new" &&
          saved.compose?.[this.draftKey]?.launch === customLaunch &&
          saved.compose[this.draftKey].sessionId === saved.pointer
            ? await this.emptyBoundSession(saved, metadata)
            : undefined;
        if (unused) {
          if (this.active && generation === this.generation) this.publish({ session: unused });
        } else if (!this.forceNew && (saved.defaults.mode !== "new" || this.resume) && saved.pointer) {
          const session = await this.destination(saved, metadata);
          const last = lastActivity(saved, session.id);
          if (this.resume) {
            if (this.active && generation === this.generation) this.publish({ session });
          } else {
            const page = await this.client.events(this.connection.token, session.id);
            if (
              reuseDecision(
                saved.defaults,
                session,
                last,
                this.now(),
                ongoing(session, page.questions, page.events, metadata),
                false,
              ) === "continue"
            ) {
              if (this.active && generation === this.generation) this.publish({ session });
            }
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
          : this.boundTo
            ? undefined
            : this.state.session
              ? "Continue this conversation. Quick Chat defaults apply to future sessions."
              : "Ready for a new conversation. Waypoint creates it on your first send.",
      });
    } catch (error) {
      this.forgetGone();
      if (this.active && generation === this.generation)
        this.publish({
          loading: false,
          error: error instanceof Error ? error.message : "Could not prepare Quick Chat. Retry; the draft is kept.",
        });
    }
  }
  // Loads the saved destination; one that is gone or can't be used is remembered for Start New Chat to clear.
  private async destination(saved: QuickChatState, metadata: ServerMetadata) {
    const id = saved.pointer!;
    try {
      const session = await this.savedConversation(id);
      this.checkOwned(session, saved, metadata);
      return session;
    } catch (error) {
      if (!(error instanceof ApiError)) this.deadPointer = id;
      throw error;
    }
  }
  // A missing bound session marks the chat gone.
  private async readSession(id: string) {
    try {
      return await this.client.session(this.connection.token, id);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "not-found" && id === this.boundTo) {
        this.gone = true;
        throw new Error(goneMessage);
      }
      throw error;
    }
  }
  // Removes a deleted bound session's drafts. Runs outside any transaction, since forgetting takes the server lock.
  private forgetGone() {
    if (!this.gone || this.forgotten) return;
    this.forgotten = true;
    // A checkpoint that still needs the session keeps its drafts; a later refresh tries again.
    void new SessionManager(this.connection, this.store, this.client, this.now).forget(this.boundTo!).then(
      (forgotten) => (this.forgotten = forgotten),
      () => (this.forgotten = false),
    );
  }
  // The open conversation reported its session missing.
  markMissing(sessionId: string) {
    if (this.boundTo === sessionId) {
      this.gone = true;
      this.publish({});
      this.forgetGone();
    } else if (this.state.session?.id === sessionId) this.deadPointer = sessionId;
  }
  // Rereads the shown session after it changed elsewhere; a send or check in progress publishes its own.
  async refreshSession() {
    const id = this.boundTo ?? this.state.session?.id;
    if (!id || this.state.busy) return;
    const generation = this.generation;
    try {
      const session = await this.readSession(id);
      if (!this.state.busy && generation === this.generation && (this.boundTo || this.state.session?.id === id))
        this.publish({ session });
    } catch {
      if (this.gone) this.publish({});
      this.forgetGone();
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
  private checkOwned(session: Session, saved: QuickChatState, metadata: ServerMetadata) {
    const problem = ownershipProblem(session, saved, metadata);
    if (problem) throw new Error(problem);
  }
  private launchDeps(metadata: ServerMetadata): LaunchDeps {
    return { connection: this.connection, client: this.client, now: this.now, metadata, workspace: this.workspace };
  }
  private saveDraft(key: string, text: string) {
    if (this.gone) return Promise.resolve();
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
    if (this.boundTo || this.state.busy || this.state.pending) return;
    const dead = this.deadPointer;
    this.deadPointer = undefined;
    if (dead)
      await this.store
        .transaction(this.connection.id, async (saved, persist) => {
          if (saved.pointer !== dead || saved.pending) return;
          setPointer(saved, undefined);
          await persist();
        })
        .catch(() => undefined);
    let error: string | undefined;
    if (this.state.compose.launch === customLaunch) {
      this.publish({ compose: { ...this.state.compose, sessionId: undefined, launch: undefined } });
      await this.queue;
      // Moving on from an unused session started from chosen settings, so reopening doesn't continue it.
      await this.store
        .transaction(this.connection.id, async (saved, persist) => {
          const draft = saved.compose?.[this.draftKey];
          if (draft?.launch !== customLaunch) return;
          const bound = draft.sessionId;
          draft.sessionId = draft.launch = undefined;
          if (bound && saved.pointer === bound && saved.sentAt[bound] === undefined && !saved.pending)
            setPointer(saved, undefined);
          await persist();
        })
        .catch(() => (error = "Could not save the new chat. Reopening may return to the previous session."));
    }
    this.generation++;
    this.prepared = true;
    this.observedPointer = undefined;
    this.observedDefaults = "manual-new";
    this.publish({
      session: undefined,
      loading: false,
      error,
      notice: "A new conversation will be created on send. The previous session keeps running.",
      revision: this.state.revision + 1,
    });
  }
  // Starts a session from chosen settings without a message; it becomes this view's conversation. Refusals before
  // anything is sent are thrown; a failed attempt is returned and shown.
  async createSession(settings: ChatDefaults, origin: LaunchOrigin): Promise<LaunchResult> {
    const metadata = this.state.metadata;
    if (this.boundTo) throw new Error("Start new sessions from Quick Chat or New Chat.");
    if (!metadata || this.state.loading) throw new Error("Quick Chat is still loading. Try again in a moment.");
    if (this.state.busy || this.state.pending)
      throw new Error("A message is being sent or needs checking. Start the session when it finishes.");
    this.publish({ busy: true, error: undefined, notice: undefined });
    try {
      await this.queue;
      const result = await launchSession(
        this.launchDeps(metadata),
        this.store,
        this.verifyConnection,
        settings,
        this.draftKey,
        origin,
      );
      if (result.kind === "created") this.show(result.session, result.compose, "Session started.", result.problem);
      else {
        const saved = await this.store.read(this.connection.id).catch(() => undefined);
        this.publish({ pending: saved?.pending, error: result.message });
      }
      return result;
    } finally {
      this.publish({ busy: false });
    }
  }
  // Replaces the view's conversation with a session this controller just started or recovered.
  private show(session: Session, compose: ComposeParts, notice: string, error?: string) {
    this.generation++;
    this.prepared = true;
    this.observedPointer = session.id;
    this.deadPointer = undefined;
    this.retry = undefined;
    this.publish({
      session,
      compose: composeParts(compose),
      sshTarget: undefined,
      loading: false,
      error,
      pending: undefined,
      notice,
      revision: this.state.revision + 1,
    });
  }
  // Connects a password-auth SSH target without retrying anything; the caller starts again with its own values.
  connectTargetOnly(targetId: string, password: string) {
    return this.client.connectTarget(this.connection.token, targetId, password);
  }
  // A session created for this draft that never received input, by a New Chat send or from chosen settings, is
  // continued, not replaced.
  private boundSession?: Promise<Session | undefined>;
  private emptyBoundSession(saved: QuickChatState, metadata: ServerMetadata) {
    const bound = saved.compose?.[this.draftKey]?.sessionId;
    if (!bound || saved.sentAt[bound] !== undefined) return Promise.resolve(undefined);
    this.boundSession ??= (async () => {
      try {
        const session = await this.client.session(this.connection.token, bound);
        this.checkOwned(session, saved, metadata);
        // Defaults changed since the session was created: the next send starts a session with the new ones.
        // A session started from chosen settings is continued whatever the defaults are now.
        const launch = saved.compose?.[this.draftKey]?.launch;
        if (
          !launch ||
          (launch !== customLaunch &&
            launch !==
              launchFingerprint(
                createRequest(saved.defaults, metadata, saved.installation, "", { workspace: this.workspace?.dir }),
              ))
        )
          return undefined;
        const page = await this.client.events(this.connection.token, bound);
        return page.hasMore || page.events.some((event) => event.kind === "user_input") ? undefined : session;
      } catch {
        return undefined;
      }
    })();
    return this.boundSession;
  }
  // Resolves whether the parts were saved. Sends use the saved parts, so when the latest save fails the form shows those again.
  private persistCompose(compose: ComposeParts): Promise<boolean> {
    const save = ++this.composeSaves;
    this.publish({ compose });
    if (this.gone) return Promise.resolve(false);
    const result = this.queue
      .then(() =>
        this.store.transaction(this.connection.id, async (saved, persist) => {
          // A save queued before the session was found deleted would bring back the drafts forgetting removed.
          if (this.gone) return;
          saved.compose = { ...saved.compose, [this.draftKey]: compose };
          await persist();
        }),
      )
      .then(
        () => true,
        async (error) => {
          const saved =
            save === this.composeSaves ? await this.store.read(this.connection.id).catch(() => undefined) : undefined;
          this.publish({
            ...(saved && save === this.composeSaves
              ? { compose: storedParts(saved.compose?.[this.draftKey]) ?? emptyParts() }
              : {}),
            error: error instanceof Error ? error.message : "Could not save draft. Keep this view open and retry.",
          });
          return false;
        },
      );
    this.queue = result;
    return result;
  }
  // Moves the single-line draft into an empty compose draft so the text isn't sent twice.
  openCompose() {
    return this.state.busy || this.state.hasDraft ? Promise.resolve() : this.moveLineDraft();
  }
  private moveLineDraft() {
    const text = this.state.draft;
    if (!text.trim()) return Promise.resolve();
    void this.changeDraft("");
    return this.replaceComposeText(text);
  }
  // Resolves whether the text was staged and saved.
  async stageContext(kind: ContextKind, text: string): Promise<boolean> {
    if (this.state.busy) return false;
    if (Buffer.byteLength(text) > maxContextBytes) {
      this.publish({ error: "That text is larger than 256 KB. Attach it as a file instead." });
      return false;
    }
    const staged = this.state.compose.context.reduce((total, item) => total + Buffer.byteLength(item.text), 0);
    if (staged + Buffer.byteLength(text) > maxDraftContextBytes) {
      this.publish({ error: "This draft already has 1 MB of context. Remove some before adding more." });
      return false;
    }
    this.publish({ error: undefined });
    const move = !this.state.hasDraft;
    const saved = await this.persistCompose({
      ...this.state.compose,
      context: [...this.state.compose.context, { id: randomUUID(), kind, text }],
    });
    if (saved && move) await this.moveLineDraft();
    return saved;
  }
  removeContext(id: string) {
    if (this.state.busy) return this.queue;
    return this.persistCompose({
      ...this.state.compose,
      context: this.state.compose.context.filter((item) => item.id !== id),
    });
  }
  async addFiles(paths: string[]): Promise<AddedFiles> {
    if (this.state.busy) return { problems: [], staged: [] };
    const problems: string[] = [];
    const files: StagedFile[] = [];
    for (const path of paths) {
      if ([...this.state.compose.files, ...files].some((file) => file.path === path)) continue;
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
    // A send that started meanwhile owns the draft; saving this snapshot would bring back what it sent.
    if (this.state.busy)
      return {
        problems: [...problems, "A message is being sent. Add the files again when it finishes."],
        staged: [],
      };
    // Added to the parts as they are now, so a file removed while these were checked stays removed.
    const added = files.filter((file) => !this.state.compose.files.some((current) => current.path === file.path));
    if (!added.length) return { problems, staged: [] };
    await this.persistCompose({ ...this.state.compose, files: [...this.state.compose.files, ...added] });
    return { problems, staged: added.map((file) => file.path) };
  }
  // Resolves whether the files were removed.
  async removeFiles(ids: string[]): Promise<boolean> {
    if (this.state.busy) return false;
    if (this.gone) {
      this.publish({
        compose: { ...this.state.compose, files: this.state.compose.files.filter((file) => !ids.includes(file.id)) },
      });
      return true;
    }
    this.publish({ busy: true, error: undefined });
    try {
      await this.queue;
      let removedPaths: string[] = [];
      const doomed = await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (this.gone) return [];
        const draft = storedParts(saved.compose?.[this.draftKey]) ?? this.state.compose;
        const removed = draft.files.filter((file) => ids.includes(file.id));
        removedPaths = removed.map((file) => file.path);
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
      void this.clipboardFiles?.release(removedPaths);
      return true;
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : "Could not remove the file." });
      return false;
    } finally {
      this.publish({ busy: false });
    }
  }
  // Resolves whether the whole draft was discarded.
  async discardCompose(): Promise<boolean> {
    if (!(await this.removeFiles(this.state.compose.files.map((file) => file.id)))) return false;
    // A session started from chosen settings stays bound, so it is still continued until its first message.
    const { sessionId, launch } = this.state.compose;
    if (!(await this.persistCompose(launch === customLaunch ? { ...emptyParts(), sessionId, launch } : emptyParts())))
      return false;
    await this.replaceComposeText("");
    return true;
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
    if (
      (error instanceof TargetConnectionRequired ||
        (error instanceof ApiError && error.detail === "ssh-master-required")) &&
      target?.auth === "password"
    ) {
      this.retry = retry;
      this.publish({ sshTarget: target.id });
      return new ApiError(
        "rejected",
        `Connect ${target.name} to continue. Your draft is kept.`,
        "ssh-master-required",
        409,
      );
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
      const current = stats.get(file.id) ?? (await fileStats(file));
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
    let text = compose ? composeMessage(compose.text, compose.context) : this.state.draft.trim();
    if (
      !this.prepared ||
      this.state.busy ||
      this.state.loading ||
      (!text && !compose?.files.length) ||
      this.state.pending ||
      !this.state.metadata
    )
      return false;
    if (this.state.blocked) {
      this.publish({ error: this.state.blocked });
      return false;
    }
    const metadata = this.state.metadata;
    let sent = false;
    let sentPaths: string[] = [];
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
        // The saved parts are what gets uploaded, so the message uses them too.
        if (draft && compose) text = composeMessage(compose.text, draft.context);
        if (draft && !text && !draft.files.length) throw new Error("This draft has nothing to send.");
        let session = this.state.session;
        if (this.boundTo && !session) throw new Error("This session isn't loaded. Reconnect and try again.");
        if (
          !session &&
          !this.forceNew &&
          saved.defaults.mode !== "new" &&
          this.observedDefaults === JSON.stringify(saved.defaults) &&
          saved.pointer &&
          saved.pointer !== this.observedPointer
        ) {
          const candidate = await this.destination(saved, metadata);
          const page = await this.client.events(this.connection.token, candidate.id);
          if (
            reuseDecision(
              saved.defaults,
              candidate,
              lastActivity(saved, candidate.id),
              this.now(),
              ongoing(candidate, page.questions, page.events, metadata),
              false,
            ) === "continue"
          )
            session = candidate;
        }
        if (!session) {
          const defaults = this.state.defaults ?? saved.defaults;
          const context = launchContext(defaults, metadata, this.workspace?.dir);
          this.checkPolicy(draft?.files ?? [], context.backend, defaults.target || undefined);
          let created: { session: Session; problem?: string };
          try {
            created = await createInTransaction(this.launchDeps(metadata), saved, persist, defaults, {
              draftKey: this.draftKey,
              source: "defaults",
              // A line send leaves no binding, so a session the form created can't be continued in its place.
              bind: (state, created, request) => {
                const bound = draft ?? state.compose?.[this.draftKey];
                if (draft) Object.assign(draft, { sessionId: created.id, launch: launchFingerprint(request) });
                else if (bound?.launch === customLaunch) bound.sessionId = bound.launch = undefined;
              },
              text,
              onCreated: (created) => this.publish({ session: created }),
            });
          } catch (error) {
            throw error instanceof TargetConnectionRequired
              ? this.sshFailure(error, defaults.target, fromCompose ? "compose" : "send")
              : error;
          }
          if (!draft && this.state.compose.launch === customLaunch)
            this.publish({ compose: { ...this.state.compose, sessionId: undefined, launch: undefined } });
          session = created.session;
          if (created.problem) throw new Error(created.problem);
        } else if (this.boundTo) {
          session = await this.readSession(this.boundTo);
          const problem = sessionProblem(session, metadata);
          if (problem) throw new Error(problem);
        } else {
          session = await this.client.session(this.connection.token, session.id);
          this.checkOwned(session, saved, metadata);
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
            session = await this.client.action(this.connection.token, session.id, "reattach", restartTimeoutMs);
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
          // A session chat's draft never binds Quick Chat to its session.
          if (!this.boundTo) {
            // The custom mark belongs to the session the form started, not to another destination.
            if (draft.launch === customLaunch && draft.sessionId !== session.id) draft.launch = undefined;
            draft.sessionId = session.id;
          }
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
        // Sent text is cleared on screen first, so a keystroke can't bring it back, and in storage before the
        // checkpoint, so a crash in between still blocks a duplicate send. Text edited during the send is kept.
        if (draft && compose) {
          if (this.composeValue === compose.text) {
            this.composeValue = "";
            this.publish({ composeEpoch: this.state.composeEpoch + 1 });
            await this.store.drafts.write(this.composeKey, "");
          }
          // Staging waits for the send, so everything in the saved parts was sent.
          sentPaths = draft.files.map((file) => file.path);
          delete saved.compose![this.draftKey];
        } else if (this.state.draft.trim() === text) {
          this.publish({ draft: "" });
          await this.store.drafts.write(this.lineKey, "");
        }
        saved.pending = undefined;
        await persist();
        sent = true;
        this.publish({
          session,
          ...(compose ? { compose: emptyParts() } : {}),
          pending: undefined,
          revision: this.state.revision + 1,
          notice: "Message accepted by Waypoint.",
        });
      });
      // Only now is the draft that named them gone from storage.
      void this.clipboardFiles?.release(sentPaths);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "not-found" && this.state.session)
        this.markMissing(this.state.session.id);
      this.forgetGone();
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
        // Clearing a checkpoint drops its uploads from the draft that sent them, which may be this one.
        compose: storedParts(saved.compose?.[this.draftKey]) ?? emptyParts(),
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
            const session = matches[0];
            this.checkOwned(session, saved, metadata);
            // A session started from chosen settings counts as chosen when it was attempted and stays bound to
            // its draft, as a confirmed create would have left it.
            setPointer(saved, session.id, pending.origin ? pending.startedAt : undefined);
            let bound: ComposeParts | undefined;
            if (pending.origin) {
              bound = {
                ...(saved.compose?.[pending.draftKey] ?? emptyParts()),
                sessionId: session.id,
                launch: customLaunch,
              };
              saved.compose = { ...saved.compose, [pending.draftKey]: bound };
            }
            saved.pending = undefined;
            await persist();
            if (pending.origin === "launch-form")
              await this.store.drafts.write(draftKeys.launch(this.connection.id), "").catch(() => undefined);
            if (bound && pending.draftKey === this.draftKey) this.show(session, bound, "Recovered the new session.");
            else
              this.publish({
                session: this.boundTo ? this.state.session : (this.state.session ?? session),
                pending: undefined,
                notice: pending.origin
                  ? "Recovered the new session."
                  : "Recovered the created conversation. The prompt was not resent. Send it when ready.",
              });
          } else if (!matches.length && failedStartAt(pending, sessions, saved.failedStartAt) !== undefined) {
            // No input reaches a session that never started, so clearing the checkpoint cannot duplicate work.
            saved.failedStartAt = failedStartAt(pending, sessions, saved.failedStartAt);
            saved.pending = undefined;
            await persist();
            // An error, not a notice: Quick Chat shows notices only while an operation is unconfirmed.
            this.publish({
              pending: undefined,
              error:
                pending.origin === "launch-form"
                  ? "The new session failed to start on its execution target. Check the working directory and target, then start the session again. Your settings are kept."
                  : pending.origin === "edit"
                    ? "The new session failed to start on its execution target. Check the working directory and target, then try again from Edit Current Session."
                    : "The new session failed to start on its execution target. Check the working directory and target in Quick Chat Defaults. No message was sent; your draft is kept.",
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
          const recorded = pending.kind === "input" && (await this.inputRecorded(session.id, pending));
          // Only the view that started the operation switches to its session; a session chat shows only its own.
          const adopt = this.boundTo ? session.id === this.boundTo : this.ownsPending(pending) && !this.state.session;
          const shown = this.state.session?.id === session.id || adopt ? session : this.state.session;
          const name = shown?.id === session.id ? undefined : `“${session.title || "another session"}”`;
          const where = name ? ` in ${name}` : "";
          this.publish({
            session: shown,
            pending,
            notice:
              pending.kind === "input"
                ? recorded
                  ? `Waypoint recorded matching input${where}. Agent delivery is still unconfirmed; retrying can duplicate the message.`
                  : `No matching input is visible${where} yet. Delivery is unconfirmed; retrying can duplicate the message.`
                : `${name ?? "The session"} is ${session.status}. The ${pending.kind} outcome is not confirmed; no input was resent.`,
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
  // Pages back from the newest events to the send's baseline, keeping no page, so a long session is never read whole.
  private async inputRecorded(sessionId: string, pending: PendingOperation) {
    const { baseline } = pending;
    const expected = [...(pending.attachments ?? [])].sort().join(",");
    const after = (event: SessionEvent) => baseline === undefined || (event.id !== undefined && event.id > baseline);
    let before: number | undefined;
    for (let pages = 0; pages < outcomePages; pages++) {
      const page = await this.client.events(this.connection.token, sessionId, before === undefined ? {} : { before });
      if (
        page.events.some(
          (event) =>
            after(event) &&
            event.kind === "user_input" &&
            event.text.trim() === pending.text &&
            attachmentIds(event.metadata.attachments).sort().join(",") === expected,
        )
      )
        return true;
      const first = page.events[0]?.sequence;
      if (
        !page.hasMore ||
        first === undefined ||
        (before !== undefined && first >= before) ||
        page.events.some((event) => !after(event))
      )
        return false;
      before = first;
    }
    return false;
  }
  // Uploads in an unconfirmed send may have been delivered, so they are dropped from the draft, never deleted.
  private forgetUploads(saved: QuickChatState) {
    const ids = new Set(saved.pending?.attachments ?? []);
    const key = saved.pending?.draftKey;
    const draft = key === undefined ? undefined : saved.compose?.[key];
    if (!ids.size || !draft) return;
    for (const file of draft.files) if (file.upload && ids.has(file.upload.attachmentId)) file.upload = undefined;
    if (key === this.draftKey) this.publish({ compose: composeParts(structuredClone(draft)) });
  }
  async allowRetry() {
    await this.reconcile();
    if (this.state.error || !this.state.pending) return;
    if (this.state.busy) return;
    const operationId = this.state.pending.operationId;
    this.publish({ busy: true });
    try {
      await this.queue;
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
    } finally {
      this.publish({ busy: false });
    }
  }
  async abandonPending() {
    const pending = this.state.pending;
    if (this.state.busy || !pending) return;
    const operationId = pending.operationId;
    const owned = this.ownsPending(pending);
    this.publish({ busy: true });
    try {
      await this.queue;
      await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (saved.pending?.operationId !== operationId)
          throw new Error("The pending attempt changed. Check its outcome again.");
        // Quick Chat moves on from a session whose operation it abandons; another view's checkpoint leaves it alone.
        if (owned && !this.boundTo && saved.pointer === saved.pending.sessionId) setPointer(saved, undefined);
        this.forgetUploads(saved);
        saved.pending = undefined;
        await persist();
      });
      if (!owned || this.boundTo) {
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
  // The destination is released before ending the session, so a closed window or an unconfirmed result can't leave
  // Quick Chat continuing it; only a definite refusal restores it.
  terminate() {
    return this.end("terminate");
  }
  // Waypoint terminates a live session before deleting it.
  terminateAndDelete() {
    return this.end("delete");
  }
  private async end(kind: "terminate" | "delete"): Promise<TerminateResult | undefined> {
    const session = this.state.session;
    const metadata = this.state.metadata;
    if (this.boundTo || this.state.busy || this.state.pending || !session || !metadata) return;
    const id = session.id;
    const manager = new SessionManager(this.connection, this.store, this.client, this.now);
    this.publish({ busy: true, error: undefined, notice: undefined });
    let released: Released | undefined;
    try {
      await this.queue;
      const current = await this.store.transaction(this.connection.id, async (saved, persist) => {
        if (saved.pending) throw new Error("Check the earlier operation's outcome first.");
        await this.verifyConnection();
        // A session deleted elsewhere is released like an ended one.
        const current = await this.client.session(this.connection.token, id).catch((error: unknown) => {
          if (error instanceof ApiError && error.kind === "not-found") return undefined;
          throw error;
        });
        released = release(saved, id);
        await persist();
        return current;
      });
      const outcome: ManageOutcome = !current
        ? { kind: "failed", message: "This session is no longer on this server.", gone: true }
        : kind === "delete"
          ? await manager.terminateAndRemove(id, metadata)
          : current.status === "exited"
            ? { kind: "done", session: current }
            : await manager.terminate(id, metadata);
      if (outcome.kind !== "done" && refused(outcome, current?.status === "exited")) {
        await manager.restore(id, released!);
        if (outcome.kind !== "ssh" && outcome.session) this.publish({ session: outcome.session });
        return { ended: false, message: outcome.message };
      }
      const uncertain = outcome.kind === "failed" && (outcome.uncertain || outcome.gone);
      const result: TerminateResult =
        outcome.kind === "done"
          ? { ended: true, outcome: "done" }
          : kind === "delete"
            ? { ended: true, outcome: uncertain ? "unconfirmed" : "partial", message: outcome.message }
            : outcome.kind === "failed" && outcome.session?.status !== "exited"
              ? { ended: true, outcome: "unconfirmed", message: outcome.message }
              : { ended: true, outcome: "done" };
      this.generation++;
      this.prepared = true;
      this.observedPointer = undefined;
      this.observedDefaults = "manual-new";
      this.publish({
        session: undefined,
        loading: false,
        revision: this.state.revision + 1,
        compose: this.unbound(id, kind === "delete"),
      });
      return result;
    } catch (error) {
      if (released) await manager.restore(id, released).catch(() => undefined);
      const saved = await this.store.read(this.connection.id).catch(() => undefined);
      this.publish({ pending: saved?.pending });
      return { ended: false, message: error instanceof Error ? error.message : "Could not end the session." };
    } finally {
      this.publish({ busy: false });
    }
  }
  // The staged parts kept in memory are saved again on the next edit, so they drop the ended session too.
  private unbound(id: string, deleted: boolean): ComposeParts {
    const compose = this.state.compose;
    return {
      ...compose,
      ...(compose.sessionId === id ? { sessionId: undefined, launch: undefined } : {}),
      files: deleted
        ? compose.files.map((file) => (file.upload?.sessionId === id ? { ...file, upload: undefined } : file))
        : compose.files,
    };
  }
  async action(action: "interrupt" | "reattach") {
    if (this.state.busy || this.state.pending || !this.state.session || !this.state.metadata) return;
    if (action === "reattach" && !canReattach(this.state.session, this.state.metadata)) return;
    if (this.state.blocked) {
      this.publish({ error: this.state.blocked });
      return;
    }
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
          session = await this.client.action(
            this.connection.token,
            id,
            action,
            action === "reattach" ? restartTimeoutMs : undefined,
          );
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
