import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ConversationFeed, FeedConnection, SessionsFeed } from "./sessionFeeds";

export function useSessionsFeed(connection: FeedConnection, active: boolean) {
  const feed = useMemo(() => new SessionsFeed(connection), [connection.id, connection.apiUrl, connection.token]);
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  useEffect(() => {
    if (!active) return;
    feed.start();
    return () => feed.stop();
  }, [feed, active]);
  return { state, feed };
}

export function useConversationFeed(connection: FeedConnection, sessionId: string, active: boolean) {
  const feed = useMemo(
    () => new ConversationFeed(connection, sessionId),
    [connection.id, connection.apiUrl, connection.token, sessionId],
  );
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  useEffect(() => {
    if (!active) return;
    feed.start();
    return () => feed.stop();
  }, [feed, active]);
  return { state, feed };
}
