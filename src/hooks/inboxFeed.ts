import { ApiError, WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { InboxItem, InboxStatus, parseInboxFrame } from "../api/inbox";
import { Envelope, LiveSocket, StreamStatus, socketUrl } from "../api/liveSocket";
import {
  InboxSections,
  addPage,
  applyFrame,
  applyItem,
  emptySection,
  inboxPageSize,
  removeItems,
} from "../domain/inbox";
import { FeedConnection, Observable } from "./sessionFeeds";
import type { SocketFactory, Scheduler } from "../api/liveSocket";

export interface InboxSnapshot {
  sections: InboxSections;
  unresolvedCount?: number;
  metadata?: ServerMetadata;
  // A page is loading.
  loading: boolean;
  stream: StreamStatus;
  error?: ApiError;
  query: string;
}
// `onDeleted` hears of items deleted elsewhere, so their drafts can go too.
type Options = { factory?: SocketFactory; scheduler?: Scheduler; onDeleted?: (id: string) => void };

const emptySections = (): InboxSections => ({ open: emptySection(), resolved: emptySection() });
const safeError = (error: unknown) =>
  error instanceof ApiError
    ? error
    : new ApiError("unreachable", "Could not refresh the inbox. Loaded items are kept. Retry to reconnect.");

// Open items first, then resolved ones, each paged by Waypoint's cursor and kept current by the live connection.
export class InboxFeed extends Observable<InboxSnapshot> {
  private readonly socket: LiveSocket;
  private active = false;
  private generation = 0;
  private connected = false;
  private paging?: AbortController;
  // Items deleted since the current pages were requested; a page read before the delete still lists them.
  private deleted = new Set<string>();
  private readonly onDeleted?: (id: string) => void;
  constructor(
    private readonly connection: FeedConnection,
    private readonly client = new WaypointClient(connection.apiUrl),
    options: Options = {},
  ) {
    super({ sections: emptySections(), loading: true, stream: "connecting", query: "" });
    this.onDeleted = options.onDeleted;
    // Waypoint sends inbox changes on the global session socket, which starts with a session list snapshot.
    this.socket = new LiveSocket(
      socketUrl(connection.apiUrl, connection.token),
      "session_list_update",
      (message, initial) => this.receive(message, initial),
      (stream) => {
        if (!this.active) return;
        if (stream === "auth-error") {
          this.generation++;
          this.paging?.abort();
          this.publish({
            stream,
            loading: false,
            error: new ApiError("expired-token", "Your sign-in expired. Sign in again to load the inbox."),
          });
        } else this.publish({ stream });
      },
      options.factory,
      options.scheduler,
    );
  }
  start() {
    this.active = true;
    this.connected = false;
    this.socket.start();
    this.reload();
    void this.client.me(this.connection.token).then(
      (metadata) => this.active && this.publish({ metadata }),
      () => undefined,
    );
  }
  stop() {
    this.active = false;
    this.generation++;
    this.paging?.abort();
    this.socket.stop();
  }
  retry() {
    this.socket.retry();
    this.reload();
  }
  setQuery(query: string) {
    if (query === this.state.query) return;
    this.publish({ query });
    this.reload();
  }
  // Reads the first pages again, dropping what was loaded.
  reload() {
    if (!this.active) return;
    this.generation++;
    this.paging?.abort();
    this.paging = undefined;
    this.deleted = new Set();
    this.publish({ sections: emptySections(), loading: true });
    void this.loadNext();
    void this.refreshCount();
  }
  loadMore() {
    if (this.active && !this.paging) void this.loadNext();
  }
  // Shows a mutation's result at once; Waypoint's update follows.
  apply(item: InboxItem) {
    this.publish({ sections: applyItem(this.state.sections, item, this.state.query) });
  }
  remove(ids: string[]) {
    ids.forEach((id) => this.deleted.add(id));
    this.publish({ sections: removeItems(this.state.sections, ids) });
  }
  // Loads one item into its section even when paging hasn't reached it, such as one opened from the menu bar.
  async fetchItem(id: string): Promise<"found" | "deleted" | "failed"> {
    try {
      const item = await this.client.inboxItem(this.connection.token, id);
      if (!this.active) return "failed";
      this.publish({ sections: applyItem(this.state.sections, item, "", true) });
      return "found";
    } catch (error) {
      return error instanceof ApiError && error.kind === "not-found" ? "deleted" : "failed";
    }
  }
  private nextStatus(): InboxStatus | undefined {
    const { open, resolved } = this.state.sections;
    if (!open.loaded || open.hasMore) return "open";
    if (!resolved.loaded || resolved.hasMore) return "resolved";
  }
  private async loadNext(): Promise<void> {
    const status = this.nextStatus();
    if (!status) return;
    const controller = new AbortController();
    this.paging = controller;
    const generation = this.generation;
    const current = () => this.active && generation === this.generation && !controller.signal.aborted;
    this.publish({ loading: true });
    try {
      const page = await this.client.inbox(
        this.connection.token,
        {
          status,
          q: this.state.query.trim() || undefined,
          cursor: this.state.sections[status].cursor,
          limit: inboxPageSize,
        },
        controller.signal,
      );
      if (!current()) return;
      this.paging = undefined;
      this.publish({ sections: addPage(this.state.sections, status, page, this.deleted), error: undefined });
      // A short Open list may never reach the end of the list, where Raycast asks for more, so Resolved starts here.
      if (status === "open" && !page.hasMore) return this.loadNext();
      this.publish({ loading: false });
    } catch (error) {
      if (!current()) return;
      this.paging = undefined;
      const failure = safeError(error);
      if (failure.kind === "expired-token") this.socket.stop();
      this.publish({ loading: false, error: failure });
    }
  }
  private async refreshCount() {
    const generation = this.generation;
    try {
      const count = await this.client.inboxCount(this.connection.token);
      if (this.active && generation === this.generation) this.publish({ unresolvedCount: count });
    } catch {
      /* The count follows the next update. */
    }
  }
  private receive(message: Envelope, initial: boolean) {
    if (initial) {
      // Updates were missed while disconnected, so the first pages are read again.
      if (this.connected) this.reload();
      this.connected = true;
      return;
    }
    if (message.type !== "inbox_update") return;
    let frame;
    try {
      frame = parseInboxFrame(message.payload);
    } catch {
      // An update this version can't read shouldn't drop the connection; the next reload shows the item.
      return;
    }
    if (frame.deleted) {
      this.deleted.add(frame.itemId);
      this.onDeleted?.(frame.itemId);
    }
    this.publish({
      sections: applyFrame(this.state.sections, frame, this.state.query),
      unresolvedCount: frame.unresolvedCount,
    });
  }
}
