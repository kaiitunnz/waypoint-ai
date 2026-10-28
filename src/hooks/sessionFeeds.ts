import { WaypointClient, ApiError } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { Connection } from "../domain/connections";
import { LiveSocket, StreamStatus, Envelope, SocketFactory, Scheduler, socketUrl, timers } from "../api/liveSocket";
import {
  Session,
  SessionEvent,
  PendingQuestions,
  parseSessions,
  parseSession,
  parseEvent,
  parseQuestions,
} from "../api/sessions";
import { chatExchanges } from "../domain/chatPresentation";
import { mergeEvents, newerQuestions, transcript } from "../domain/transcript";

export interface FeedConnection extends Connection {
  token: string;
}
// `watch` schedules the conversation's periodic existence check.
type Options = { factory?: SocketFactory; scheduler?: Scheduler; watch?: Scheduler };
// Waypoint announces a deletion only on the session list, so an open conversation checks that it still exists.
export const presenceIntervalMs = 20000;
// How many earlier pages a resumed conversation reads to reconnect to the history it already holds.
export const bridgePages = 5;
// How many earlier pages one Load Earlier Turns reads at most.
export const turnPages = 3;
// `stale`: a reload, a resume, or stopping replaced the history the page was read for.
export type OlderOutcome = "loaded" | "skipped" | "failed" | "stale";
const safeError = (error: unknown) =>
  error instanceof ApiError
    ? error
    : new ApiError("unreachable", "Could not refresh Waypoint. Your loaded history has been kept. Retry to reconnect.");

class Observable<State> {
  protected listeners = new Set<() => void>();
  constructor(protected state: State) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected publish(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export interface BrowserSnapshot {
  sessions: Session[];
  metadata?: ServerMetadata;
  loading: boolean;
  stream: StreamStatus;
  error?: ApiError;
}

export class SessionsFeed extends Observable<BrowserSnapshot> {
  private socket: LiveSocket;
  private controller?: AbortController;
  private active = false;
  private revision = 0;
  private generation = 0;
  constructor(
    private readonly connection: FeedConnection,
    private readonly client = new WaypointClient(connection.apiUrl),
    options: Options = {},
  ) {
    super({ sessions: [], loading: true, stream: "connecting" });
    this.socket = new LiveSocket(
      socketUrl(connection.apiUrl, connection.token),
      "session_list_update",
      (message) => this.receive(message),
      (stream) => {
        if (!this.active) return;
        if (stream === "auth-error") {
          this.generation++;
          this.controller?.abort();
        }
        this.publish({
          stream,
          ...(stream === "auth-error"
            ? {
                loading: false,
                error: new ApiError("expired-token", "Your sign-in expired. Sign in again to load sessions."),
              }
            : {}),
        });
      },
      options.factory,
      options.scheduler,
    );
  }
  start() {
    this.active = true;
    this.socket.start();
    void this.refresh();
  }
  stop() {
    this.active = false;
    this.generation++;
    this.controller?.abort();
    this.socket.stop();
  }
  retry() {
    this.socket.retry();
    void this.refresh();
  }
  // Mutation results show at once; a later list snapshot from Waypoint replaces them.
  apply(session: Session) {
    this.revision++;
    const exists = this.state.sessions.some((item) => item.id === session.id);
    this.publish({
      sessions: exists
        ? this.state.sessions.map((item) => (item.id === session.id ? session : item))
        : [session, ...this.state.sessions],
    });
  }
  remove(id: string) {
    this.revision++;
    this.publish({ sessions: this.state.sessions.filter((item) => item.id !== id) });
  }
  private receive(message: Envelope) {
    if (message.type !== "session_list_update") return;
    const sessions = parseSessions(message.payload);
    this.revision++;
    this.publish({ sessions, loading: !this.state.metadata, error: undefined });
  }
  private async refresh() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const revision = this.revision;
    this.publish({ loading: true });
    try {
      const [metadata, sessions] = await Promise.all([
        this.client.me(this.connection.token, controller.signal),
        this.client.sessions(this.connection.token, controller.signal),
      ]);
      if (
        !this.active ||
        controller.signal.aborted ||
        generation !== this.generation ||
        this.state.stream === "auth-error"
      )
        return;
      this.publish({ metadata, ...(revision === this.revision ? { sessions } : {}), loading: false, error: undefined });
    } catch (error) {
      if (!this.active || controller.signal.aborted || generation !== this.generation) return;
      const failure = safeError(error);
      if (failure.kind === "expired-token") this.socket.stop();
      this.publish({ loading: false, error: failure });
    }
  }
}

export interface ConversationSnapshot {
  session?: Session;
  events: SessionEvent[];
  questions?: PendingQuestions;
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  stream: StreamStatus;
  error?: ApiError;
  // Where activity resumes after each gap too large to fill on resume, oldest first. Only Reload clears them.
  gaps: number[];
  // Requests are found from this event on; earlier history may be missing events.
  contiguousFrom?: number;
}

const highest = (...values: (number | undefined)[]) => {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length ? Math.max(...defined) : undefined;
};

export class ConversationFeed extends Observable<ConversationSnapshot> {
  private socket: LiveSocket;
  private active = false;
  private generation = 0;
  private epoch = 0;
  private sessionRevision = 0;
  private questionEpoch = -1;
  // Where each hole left by a failed resume begins, oldest first; the next resume bridges back to the first.
  private holes: number[] = [];
  private hydrating = false;
  private buffer: SessionEvent[] = [];
  private controller?: AbortController;
  private olderController?: AbortController;
  private olderTurn?: Promise<OlderOutcome>;
  private fallbackRunning = false;
  private hydrated = false;
  private readonly watch: Scheduler;
  private watchTimer?: unknown;
  constructor(
    private readonly connection: FeedConnection,
    private readonly sessionId: string,
    private readonly client = new WaypointClient(connection.apiUrl),
    options: Options = {},
  ) {
    super({ events: [], loading: true, loadingOlder: false, hasMore: false, stream: "connecting", gaps: [] });
    this.watch = options.watch ?? timers;
    this.socket = new LiveSocket(
      socketUrl(connection.apiUrl, connection.token, sessionId),
      "session_state",
      (message, initial) => this.receive(message, initial),
      (stream) => {
        if (!this.active) return;
        this.publish({ stream });
        if (stream === "auth-error") {
          this.generation++;
          this.controller?.abort();
          this.olderController?.abort();
          this.publish({
            loading: false,
            loadingOlder: false,
            error: new ApiError(
              "expired-token",
              "Your sign-in expired. Sign in again to reconnect to this conversation.",
            ),
          });
        } else if (stream === "reconnecting") {
          this.hydrating = true;
          if (!this.fallbackRunning) {
            this.fallbackRunning = true;
            void this.hydrate().finally(() => {
              this.fallbackRunning = false;
            });
          }
        }
      },
      options.factory,
      options.scheduler,
    );
  }
  start() {
    this.active = true;
    this.hydrating = true;
    this.socket.start();
  }
  stop() {
    this.active = false;
    this.generation++;
    this.controller?.abort();
    this.olderController?.abort();
    this.socket.stop();
    this.unwatch();
  }
  private unwatch() {
    if (this.watchTimer !== undefined) this.watch.clear(this.watchTimer);
    this.watchTimer = undefined;
  }
  private watchPresence() {
    this.unwatch();
    this.watchTimer = this.watch.set(() => {
      this.watchTimer = undefined;
      void this.checkPresence();
    }, presenceIntervalMs);
  }
  // Other failures are left to the live connection's own status.
  private async checkPresence() {
    if (!this.active) return;
    const generation = this.generation;
    try {
      await this.client.session(this.connection.token, this.sessionId);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "not-found" && this.active && generation === this.generation) {
        this.generation++;
        this.controller?.abort();
        this.olderController?.abort();
        this.socket.stop();
        this.publish({ loading: false, loadingOlder: false, error: error });
        return;
      }
    }
    if (this.active && generation === this.generation) this.watchPresence();
  }
  // A hidden conversation reconnects when it starts again, so retrying it here would only open a stray socket.
  retry() {
    if (!this.active) return;
    this.hydrating = true;
    this.socket.retry();
  }
  // Starts again from the latest page, dropping loaded history and any gap left by a long absence.
  reload() {
    if (!this.active) return;
    this.holes = [];
    this.hydrated = false;
    this.hydrating = true;
    this.publish({ events: [], hasMore: false, gaps: [], contiguousFrom: undefined });
    void this.hydrate();
  }
  private receive(message: Envelope, initial: boolean) {
    if (message.type === "session_state") {
      const session = parseSession(message.payload.session);
      if (session.id !== this.sessionId) throw new Error("Mismatched session state");
      this.sessionRevision++;
      this.publish({ session });
      if (initial) {
        this.epoch++;
        this.questionEpoch = -1;
        this.hydrating = true;
        void this.hydrate();
      }
    } else if (message.type === "event") {
      const event = parseEvent(message.payload.event, this.sessionId);
      if (this.hydrating) this.buffer.push(event);
      else this.publish({ events: mergeEvents(this.state.events, [event], this.sessionId) });
    } else if (message.type === "pending_questions") {
      this.applyQuestions(parseQuestions(message.payload, this.sessionId), true);
    }
  }
  private applyQuestions(questions: PendingQuestions, socket: boolean) {
    const next =
      socket && this.questionEpoch !== this.epoch ? questions : newerQuestions(this.state.questions, questions);
    if (socket) this.questionEpoch = this.epoch;
    this.publish({ questions: next });
  }
  private async hydrate() {
    this.controller?.abort();
    this.olderController?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const revision = this.sessionRevision;
    const oldSequence = this.state.events.at(-1)?.sequence;
    const target = this.holes.length ? this.holes[0] - 1 : oldSequence;
    this.publish({ loading: true, loadingOlder: false });
    const current = () => this.active && !controller.signal.aborted && generation === this.generation;
    try {
      const [session, page] = await Promise.all([
        this.client.session(this.connection.token, this.sessionId, controller.signal),
        this.client.events(this.connection.token, this.sessionId, {}, controller.signal),
      ]);
      if (!current()) return;
      const fetched = [...page.events];
      let bridge = page;
      // Waypoint numbers a session's events consecutively, so a page starting right after the target joins it.
      const short = () =>
        target !== undefined && bridge.hasMore && bridge.events.length > 0 && bridge.events[0].sequence > target + 1;
      for (let pages = 0; short() && pages < bridgePages; pages++) {
        const before = bridge.events[0].sequence;
        bridge = await this.client.events(this.connection.token, this.sessionId, { before }, controller.signal);
        if (!current()) return;
        if (bridge.events.length && bridge.events[0].sequence >= before)
          throw new Error("History cursor did not advance");
        fetched.push(...bridge.events);
      }
      // A gap left after the bridge is shown as one rather than filled event by event, along with the
      // holes below it that the bridge didn't reach.
      const start = bridge.events[0]?.sequence;
      const gaps = short()
        ? [...this.state.gaps, ...this.holes.filter((hole) => hole < start), start]
        : this.state.gaps;
      this.holes = [];
      this.publish({
        events: mergeEvents(this.state.events, [...fetched, ...this.buffer], this.sessionId),
        ...(revision === this.sessionRevision ? { session } : {}),
        hasMore: !this.hydrated || oldSequence === undefined ? bridge.hasMore : this.state.hasMore,
        gaps,
        contiguousFrom: gaps.at(-1),
        loading: false,
        error: undefined,
      });
      this.hydrated = true;
      this.watchPresence();
      if (page.questions && this.questionEpoch !== this.epoch) this.applyQuestions(page.questions, false);
      this.buffer = [];
      this.hydrating = false;
    } catch (error) {
      if (!current()) return;
      const failure = safeError(error);
      if (failure.kind === "expired-token" || failure.kind === "not-found") this.socket.stop();
      // Live events kept from here on follow a hole.
      if (oldSequence !== undefined && this.holes.at(-1) !== oldSequence + 1) this.holes.push(oldSequence + 1);
      this.publish({
        events: mergeEvents(this.state.events, this.buffer, this.sessionId),
        contiguousFrom: highest(this.holes.at(-1), this.state.gaps.at(-1)),
        loading: false,
        error: failure,
      });
      this.buffer = [];
      this.hydrating = false;
    }
  }
  async loadOlder(): Promise<OlderOutcome> {
    if (!this.canLoadOlder()) return "skipped";
    const generation = this.generation;
    this.publish({ loadingOlder: true });
    const outcome = await this.olderPage(generation);
    if (outcome !== "stale") this.publish({ loadingOlder: false });
    return outcome;
  }
  // Reads earlier pages until one more prompt has loaded, up to `turnPages`: a page counts messages and tool calls,
  // so one turn can span several, and the cap keeps a very long turn from walking the whole history at once.
  loadOlderTurn(): Promise<OlderOutcome> {
    if (!this.olderTurn)
      this.olderTurn = this.walkOlderTurn().finally(() => {
        this.olderTurn = undefined;
      });
    return this.olderTurn;
  }
  private async walkOlderTurn(): Promise<OlderOutcome> {
    if (!this.canLoadOlder()) return "skipped";
    const generation = this.generation;
    const anchor = this.state.events[0].sequence;
    this.publish({ loadingOlder: true });
    let loaded = false;
    let outcome: OlderOutcome = "skipped";
    for (let pages = 0; pages < turnPages; pages++) {
      outcome = await this.olderPage(generation);
      if (outcome !== "loaded") break;
      loaded = true;
      if (!this.state.hasMore || this.olderPrompts(anchor) > 0) break;
    }
    if (outcome !== "stale") this.publish({ loadingOlder: false });
    return outcome === "stale" ? outcome : loaded ? "loaded" : outcome;
  }
  // Prompts before the walk's first event; live turns arriving meanwhile land after it and don't count.
  private olderPrompts(anchor: number) {
    return chatExchanges(transcript(this.state.events), this.state.gaps).filter(
      (exchange) => exchange.prompt && exchange.prompt.sequence < anchor,
    ).length;
  }
  private canLoadOlder() {
    return (
      this.active &&
      !this.state.loading &&
      !this.state.loadingOlder &&
      this.state.hasMore &&
      this.state.events.length > 0
    );
  }
  private async olderPage(generation: number): Promise<OlderOutcome> {
    const before = this.state.events[0].sequence;
    const controller = new AbortController();
    this.olderController = controller;
    const current = () => this.active && !controller.signal.aborted && generation === this.generation;
    try {
      const page = await this.client.events(this.connection.token, this.sessionId, { before }, controller.signal);
      if (!current()) return "stale";
      if (page.events.some((event) => event.sequence >= before) || (page.hasMore && !page.events.length))
        throw new Error("History cursor did not advance");
      this.publish({
        events: mergeEvents(this.state.events, page.events, this.sessionId),
        hasMore: page.hasMore,
        error: undefined,
      });
      return "loaded";
    } catch (error) {
      if (!current()) return "stale";
      this.publish({ error: safeError(error) });
      return "failed";
    }
  }
}
