import { randomUUID } from "node:crypto";
import { WaypointClient, ApiError } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { EventsPage, PendingQuestions, Session, SessionEvent } from "../api/sessions";
import {
  Interaction,
  InteractionDraft,
  cancelRequest,
  interactionRequest,
  isLive,
  preDispatchDetails,
  openInteractionKeys,
  plansDecisions,
  requestKeys,
  sessionInteractions,
} from "../domain/interactions";
import { mergeEvents, newerQuestions } from "../domain/transcript";
import { draftKeys } from "../storage/drafts";
import { QuickChatStore, PendingOperation, isInteractionDraft } from "../storage/quickChat";
import { FeedConnection, ConversationSnapshot } from "./sessionFeeds";

export interface InteractionSnapshot {
  loading: boolean;
  busy: boolean;
  interactions: Interaction[];
  drafts: Record<string, InteractionDraft>;
  pending?: PendingOperation;
  error?: string;
  notice?: string;
  outcome?: Outcome;
  // A failed refresh leaves approvals and plans unknown until the next successful one.
  loadError?: string;
}
export type Outcome = "pending" | "resolved" | "elsewhere";

// The history one feed has loaded, from its first event that follows on without a gap.
interface FeedBlock {
  source: object;
  events: SessionEvent[];
  last: number;
  cut: boolean;
}
const unsaved =
  "Waypoint accepted the response, but this computer could not clear its saved attempt. Check the outcome, then clear it.";
// Earlier messages load below a gap, so a conversation with one is reloaded first.
const unconfirmable = (cut: boolean) =>
  `Couldn't confirm from the loaded history. ${cut ? "Reload Conversation, then load" : "Load"} earlier messages until the request appears, or open it in Waypoint.`;
const definitive = new Set(["expired-token", "not-found", "rejected"]);
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export class InteractionController {
  private state: InteractionSnapshot = { loading: true, busy: false, interactions: [], drafts: {} };
  private listeners = new Set<() => void>();
  private session?: Session;
  private feed?: FeedBlock;
  private questions?: PendingQuestions;
  // What each feed last delivered, so a resumed feed's cached snapshot cannot override newer state.
  private delivered = new WeakMap<object, { session?: Session; questions?: PendingQuestions }>();
  private questionSource?: object;
  private questionChanges = 0;
  private sessionChanges = 0;
  // Requests Waypoint proved are no longer pending, though history still lists them.
  private notPending = new Set<string>();
  private generation = 0;
  private active = true;
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
  private interactions(events = this.feed?.events ?? []) {
    if (!this.session) return [];
    return sessionInteractions(this.session, this.metadata, events, this.questions).map((interaction) =>
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
  private get draftsKey() {
    return draftKeys.interactions(this.connection.id, this.sessionId);
  }
  private async readDrafts(): Promise<Record<string, InteractionDraft> | undefined> {
    const raw = await this.store.drafts.read(this.draftsKey);
    if (raw === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(Object.entries(value).filter(([, draft]) => isInteractionDraft(draft)));
    } catch {
      /* An unreadable draft record is replaced by the next edit. */
    }
    return {};
  }
  private saveDrafts(drafts: Record<string, InteractionDraft>) {
    return this.store.drafts.write(this.draftsKey, JSON.stringify(drafts));
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
    this.adoptFeed(snapshot, source);
    if (snapshot.questions && snapshot.questions !== seen.questions) {
      // A feed resolves its own socket epochs, so its newer snapshot replaces its previous one outright.
      this.questions =
        source === this.questionSource ? snapshot.questions : newerQuestions(this.questions, snapshot.questions);
      this.questionSource = source;
      this.questionChanges++;
    }
    this.derive();
  }
  // Conversation History and the chat behind it share this controller. Requests come from whichever feed
  // holds the newest history; a resumed feed republishing an older block cannot displace it.
  private adoptFeed(snapshot: ConversationSnapshot, source: object) {
    const from = snapshot.contiguousFrom;
    const events = from === undefined ? snapshot.events : snapshot.events.filter((event) => event.sequence >= from);
    const last = snapshot.events.at(-1)?.sequence;
    if (last === undefined || (this.feed && this.feed.source !== source && last < this.feed.last)) return;
    this.feed = { source, events, last, cut: from !== undefined };
  }
  // A just-fetched latest page joins the feed's history only where the two meet, so a request is never
  // judged across history that neither holds.
  private window(page: EventsPage) {
    const feed = this.feed?.events ?? [];
    const first = page.events[0]?.sequence;
    const last = page.events.at(-1)?.sequence;
    const connected =
      !page.hasMore ||
      (first !== undefined &&
        last !== undefined &&
        feed.length > 0 &&
        first <= feed[feed.length - 1].sequence + 1 &&
        feed[0].sequence <= last + 1);
    return connected ? mergeEvents(feed, page.events, this.sessionId) : page.events;
  }
  // A request is known to be resolved only when the history checked still shows it; questions come from
  // Waypoint's own snapshot, which is complete whatever history is loaded.
  private resolved(key: string, events: SessionEvent[]) {
    return key.startsWith("question:") || requestKeys(events).has(key);
  }
  // The latest page is read for its question snapshot and to re-check a request; history comes from the feed.
  private async snapshot() {
    await this.verifyConnection();
    const [session, metadata, page] = await Promise.all([
      this.client.session(this.connection.token, this.sessionId),
      this.client.me(this.connection.token),
      this.client.events(this.connection.token, this.sessionId),
    ]);
    return { session, metadata, page };
  }
  private adopt(
    fresh: Awaited<ReturnType<InteractionController["snapshot"]>>,
    sessionChanges = this.sessionChanges,
    questionChanges = this.questionChanges,
  ) {
    this.metadata = fresh.metadata;
    if (sessionChanges === this.sessionChanges) this.session = fresh.session;
    if (fresh.page.questions)
      this.questions =
        questionChanges === this.questionChanges
          ? fresh.page.questions
          : newerQuestions(this.questions, fresh.page.questions);
    this.derive();
  }
  async refresh() {
    await this.load();
  }
  private async load() {
    const generation = ++this.generation;
    const sessionChanges = this.sessionChanges;
    const questionChanges = this.questionChanges;
    this.publish({ loading: true, error: undefined, loadError: undefined });
    try {
      const [fresh, saved, stored] = await Promise.all([
        this.snapshot(),
        this.store.read(this.connection.id),
        this.readDrafts(),
      ]);
      if (!this.active || generation !== this.generation) return;
      this.adopt(fresh, sessionChanges, questionChanges);
      // Drafts saved before per-session storage are carried over once.
      const legacy = Object.fromEntries(
        Object.entries(saved.interactionDrafts ?? {}).filter(([key]) => key.startsWith(`${this.sessionId}:`)),
      );
      if (stored === undefined && Object.keys(legacy).length) void this.saveDrafts(legacy).catch(() => undefined);
      this.publish({
        loading: false,
        pending: saved.pending,
        ...(saved.pending?.operationId !== this.state.pending?.operationId ? { outcome: undefined } : {}),
        drafts: { ...(stored ?? legacy), ...this.state.drafts },
      });
      await this.prune();
      return fresh;
    } catch (error) {
      if (this.active && generation === this.generation)
        this.publish({
          loading: false,
          error: message(error, "Could not refresh requests."),
          loadError: message(error, "Could not refresh requests."),
        });
    }
  }
  // Only an authoritative refresh may prune. Loaded history may not reach an approval or plan that is still
  // pending, so their drafts are kept for as long as the session could still ask for them.
  private async prune() {
    const session = this.session;
    if (!session || !this.questions) return;
    const open = openInteractionKeys(this.feed?.events ?? [], this.questions);
    const prefix = `${this.sessionId}:`;
    const kept = (interaction: string) =>
      open.has(interaction) ||
      (interaction.startsWith("approval:") && isLive(session)) ||
      (interaction.startsWith("plan:") && plansDecisions(session, this.metadata));
    const keep = (key: string, pending?: PendingOperation) =>
      !key.startsWith(prefix) || kept(key.slice(prefix.length, key.lastIndexOf(":"))) || pending?.draftKey === key;
    const drafts = Object.fromEntries(
      Object.entries(this.state.drafts).filter(([key]) => keep(key, this.state.pending)),
    );
    if (Object.keys(drafts).length === Object.keys(this.state.drafts).length) return;
    this.publish({ drafts });
    await this.saveDrafts(drafts).catch(() => undefined);
  }
  changeDraft(interaction: Interaction, draft: InteractionDraft) {
    const key = this.draftKey(interaction);
    this.publish({ drafts: { ...this.state.drafts, [key]: draft } });
    return this.saveDrafts(this.state.drafts).catch(() =>
      this.publish({ error: "Could not save this response. Keep this form open and retry." }),
    );
  }
  async submit(captured: Interaction, draft: InteractionDraft, cancel = false): Promise<boolean> {
    if (this.state.busy || this.state.loading) return false;
    this.publish({ busy: true, error: undefined, notice: undefined });
    const draftKey = this.draftKey(captured);
    let acknowledged = false;
    let settled = false;
    try {
      if (!cancel) await this.changeDraft(captured, draft);
      await this.store.transaction(this.connection.id, async (saved, persist, fence) => {
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
        const window = this.window(fresh.page);
        const current = this.interactions(window).find((item) => item.key === captured.key);
        if (!current)
          throw new Error(
            this.resolved(captured.key, window)
              ? "This request was resolved or replaced."
              : unconfirmable(!!this.feed?.cut),
          );
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
          await fence();
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
        // The answered draft is removed before the checkpoint, so a crash in between still reports it unconfirmed.
        const drafts = { ...this.state.drafts };
        delete drafts[draftKey];
        await this.saveDrafts(drafts);
        saved.pending = undefined;
        await persist();
        settled = true;
      });
    } catch (error) {
      const saved = await this.store.read(this.connection.id).catch(() => undefined);
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
    const fresh = await this.load();
    const pending = this.state.pending;
    if (!fresh || this.state.error || pending?.kind !== "interaction") return;
    const window = this.window(fresh.page);
    const key = pending.interactionKey ?? "";
    const found = this.interactions(window).some((item) => item.key === key);
    if (pending.sessionId === this.sessionId && !found && !this.resolved(key, window)) {
      this.publish({
        outcome: undefined,
        notice: unconfirmable(!!this.feed?.cut),
      });
      return;
    }
    const outcome: Outcome = pending.sessionId !== this.sessionId ? "elsewhere" : found ? "pending" : "resolved";
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
