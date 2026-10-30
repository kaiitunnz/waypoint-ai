import { useEffect, useMemo, useSyncExternalStore } from "react";
import { InboxFeed } from "./inboxFeed";
import { FeedConnection } from "./sessionFeeds";

export function useInboxFeed(connection: FeedConnection, onDeleted: (id: string) => void) {
  const feed = useMemo(
    () => new InboxFeed(connection, undefined, { onDeleted }),
    [connection.id, connection.apiUrl, connection.token],
  );
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  useEffect(() => {
    feed.start();
    return () => feed.stop();
  }, [feed]);
  return { state, feed };
}
