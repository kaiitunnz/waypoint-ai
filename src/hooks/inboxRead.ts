import { Scheduler, timers } from "../api/liveSocket";

export const dwellMs = 1500;

// Marking an item read can resolve it and wake its session for good, while Raycast selects a row on its own whenever
// the list changes. So only a move the user made, held for a moment, or an action on the item marks it read.
// Raycast's selection events don't say who caused them; a move counts only when the previous selection is still
// shown and no selection set by the view is pending, which errs toward not reading.
export class ReadPolicy {
  private current?: string;
  private shown = new Set<string>();
  private pending?: string;
  private timer?: unknown;
  private readonly marked = new Set<string>();
  constructor(
    private readonly markRead: (id: string) => Promise<void>,
    private readonly isUnread: (id: string) => boolean,
    private readonly scheduler: Scheduler = timers,
  ) {}
  // Called on every render with the rows shown.
  visible(ids: string[]) {
    this.shown = new Set(ids);
    if (this.current !== undefined && !this.shown.has(this.current)) {
      this.current = undefined;
      this.cancel();
    }
  }
  // A new search or reload: whatever Raycast selects next is its own choice.
  reset() {
    this.current = undefined;
    this.pending = undefined;
    this.cancel();
  }
  // The view is about to select `id` itself.
  expect(id: string) {
    this.pending = id === this.current ? undefined : id;
  }
  select(id: string | undefined) {
    const previous = this.current;
    this.current = id;
    this.cancel();
    if (this.pending !== undefined) {
      this.pending = undefined;
      return;
    }
    if (previous === undefined || id === undefined || id === previous || !this.shown.has(previous)) return;
    this.timer = this.scheduler.set(() => {
      this.timer = undefined;
      if (this.current === id) this.mark(id);
    }, dwellMs);
  }
  // The user acted on the item.
  acted(id: string) {
    this.mark(id);
  }
  stop() {
    this.cancel();
  }
  private cancel() {
    if (this.timer !== undefined) this.scheduler.clear(this.timer);
    this.timer = undefined;
  }
  private mark(id: string) {
    if (this.marked.has(id) || !this.isUnread(id)) return;
    this.marked.add(id);
    // A failed read can be tried again on the next move or action.
    this.markRead(id).catch(() => this.marked.delete(id));
  }
}
