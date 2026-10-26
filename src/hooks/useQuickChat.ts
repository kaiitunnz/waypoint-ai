import { useEffect, useMemo, useSyncExternalStore } from "react";
import { QuickChatController } from "./quickChatController";
import { FeedConnection } from "./sessionFeeds";
import { quickChatStore, connectionStore } from "../storage/raycast";
import { localWorkspace } from "../storage/workspace";

export function useQuickChat(connection: FeedConnection, forceNew: boolean, resume = false) {
  const controller = useMemo(
    () =>
      new QuickChatController(
        connection,
        quickChatStore,
        async () => {
          const state = await connectionStore.read();
          if (!state.connections.some((item) => item.id === connection.id && item.apiUrl === connection.apiUrl))
            throw new Error("The server connection changed or was removed. Reopen Quick Chat; your draft is kept.");
        },
        { forceNew, resume, workspace: localWorkspace(connection.apiUrl) },
      ),
    [connection.id, connection.apiUrl, connection.token, forceNew, resume],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    void controller.start();
    return () => controller.stop();
  }, [controller]);
  return { controller, state };
}
