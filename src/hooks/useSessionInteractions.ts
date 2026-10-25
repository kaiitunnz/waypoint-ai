import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ServerMetadata } from "../api/contracts";
import { connectionStore, quickChatStore } from "../storage/raycast";
import { ConversationFeed, FeedConnection } from "./sessionFeeds";
import { InteractionController } from "./interactionController";

export function useSessionInteractions(
  connection: FeedConnection,
  sessionId: string | undefined,
  metadata: ServerMetadata,
  feed: ConversationFeed,
) {
  const controller = useMemo(
    () =>
      new InteractionController(connection, sessionId ?? "", metadata, quickChatStore, async () => {
        const saved = await connectionStore.read();
        if (!saved.connections.some((item) => item.id === connection.id && item.apiUrl === connection.apiUrl))
          throw new Error("This server connection changed. Reopen the conversation.");
      }),
    [connection.id, connection.apiUrl, connection.token, sessionId],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = feed.subscribe(() => controller.ingest(feed.getSnapshot(), feed));
    controller.ingest(feed.getSnapshot(), feed);
    void controller.start();
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller, feed, sessionId]);
  return { state, controller };
}
