import { KeyedStorage } from "./connections";

// Draft text is owned by one command at a time, so it is stored per key without the server lock.
// Writes are coalesced: one write per key is in flight and a newer value replaces any queued one.
export class DraftStore {
  private readonly queued = new Map<string, string>();
  private readonly flushing = new Map<string, Promise<void>>();
  constructor(private readonly storage: KeyedStorage) {}
  read(key: string) {
    return this.queued.has(key) ? Promise.resolve(this.queued.get(key)) : this.storage.getItem(key);
  }
  // Drops queued writes and waits for ones in flight, so a removed server's drafts aren't written back.
  async forget(prefix: string) {
    for (const key of this.queued.keys()) if (key.startsWith(prefix)) this.queued.delete(key);
    await Promise.all([...this.flushing].filter(([key]) => key.startsWith(prefix)).map(([, flush]) => flush));
  }
  // Drops a queued value and waits for a write in flight, so the removed draft isn't written back.
  async remove(key: string) {
    this.queued.delete(key);
    await this.flushing.get(key);
    await this.storage.removeItem(key);
  }
  // Removes every draft under a prefix, such as all of one inbox item's blocks.
  async removePrefix(prefix: string) {
    await this.forget(prefix);
    for (const key of await this.storage.keys()) if (key.startsWith(prefix)) await this.storage.removeItem(key);
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

// The draft key of a chat bound to one session.
export const sessionChatDraft = (sessionId: string) => `session:${sessionId}`;
export const draftKeys = {
  line: (connectionId: string, draftKey: string) => `waypoint.draft.${connectionId}.line.${draftKey}`,
  compose: (connectionId: string, draftKey: string) => `waypoint.draft.${connectionId}.compose.${draftKey}`,
  interactions: (connectionId: string, sessionId: string) => `waypoint.draft.${connectionId}.interactions.${sessionId}`,
  // One per server, not per conversation.
  launch: (connectionId: string) => `waypoint.draft.${connectionId}.launch`,
  inbox: (connectionId: string, itemId: string, blockId: string) =>
    `waypoint.draft.${connectionId}.inbox.${itemId}.${blockId}`,
  inboxItem: (connectionId: string, itemId: string) => `waypoint.draft.${connectionId}.inbox.${itemId}.`,
};
