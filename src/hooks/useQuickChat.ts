import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ChatDestination, QuickChatController } from "./quickChatController";
import { FeedConnection } from "./sessionFeeds";
import { clipboardFiles, quickChatStore, connectionStore } from "../storage/raycast";
import { localWorkspace } from "../storage/workspace";

// Checks that the connection still matches the saved one, so a removed or re-pointed server gets no writes.
export function connectionCheck(connection: FeedConnection) {
  return async () => {
    const state = await connectionStore.read();
    if (!state.connections.some((item) => item.id === connection.id && item.apiUrl === connection.apiUrl))
      throw new Error("The server connection changed or was removed. Reopen Quick Chat; your draft is kept.");
  };
}

export function useQuickChat(connection: FeedConnection, destination: ChatDestination) {
  const sessionId = destination.kind === "session" ? destination.sessionId : undefined;
  const resume = destination.kind === "quick" && !!destination.resume;
  const controller = useMemo(
    () =>
      new QuickChatController(connection, quickChatStore, connectionCheck(connection), {
        destination,
        workspace: localWorkspace(connection.apiUrl),
        clipboardFiles,
      }),
    // A destination written inline is a new object each render; its fields identify it.
    [connection.id, connection.apiUrl, connection.token, destination.kind, sessionId, resume],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    void controller.start();
    return () => controller.stop();
  }, [controller]);
  return { controller, state };
}
