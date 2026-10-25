import { StorageAdapter } from "./connections";

// Draft text is owned by one command at a time, so it is stored per key without the server lock.
// Writes are coalesced: one write per key is in flight and a newer value replaces any queued one.
export class DraftStore {
  private readonly queued = new Map<string, string>();
  private readonly flushing = new Map<string, Promise<void>>();
  constructor(private readonly storage: StorageAdapter) {}
  read(key: string) {
    return this.queued.has(key) ? Promise.resolve(this.queued.get(key)) : this.storage.getItem(key);
  }
  // Resolves once this value or a newer one is stored.
  write(key: string, value: string): Promise<void> {
    this.queued.set(key, value);
    const current = this.flushing.get(key);
    if (current) return current;
    const flush = (async () => {
      try {
        while (this.queued.has(key)) {
          const next = this.queued.get(key)!;
          await this.storage.setItem(key, next);
          if (this.queued.get(key) === next) this.queued.delete(key);
        }
      } finally {
        this.flushing.delete(key);
      }
    })();
    this.flushing.set(key, flush);
    return flush;
  }
}

export const draftKeys = {
  line: (connectionId: string, draftKey: string) => `waypoint.draft.${connectionId}.line.${draftKey}`,
  compose: (connectionId: string, draftKey: string) => `waypoint.draft.${connectionId}.compose.${draftKey}`,
  interactions: (connectionId: string, sessionId: string) => `waypoint.draft.${connectionId}.interactions.${sessionId}`,
};
