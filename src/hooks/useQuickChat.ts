import { useEffect, useMemo, useSyncExternalStore } from "react";
import { WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { ChatDefaults } from "../domain/quickChat";
import { QuickChatController, quickChatDraft } from "./quickChatController";
import { launchSession } from "./sessionLauncher";
import { FeedConnection } from "./sessionFeeds";
import { quickChatStore, connectionStore } from "../storage/raycast";
import { localWorkspace } from "../storage/workspace";

// Checks that the connection still matches the saved one, so a removed or re-pointed server gets no writes.
export function connectionCheck(connection: FeedConnection) {
  return async () => {
    const state = await connectionStore.read();
    if (!state.connections.some((item) => item.id === connection.id && item.apiUrl === connection.apiUrl))
      throw new Error("The server connection changed or was removed. Reopen Quick Chat; your draft is kept.");
  };
}

// Starts a Quick Chat session from chosen settings outside a Quick Chat view, such as from Edit Current Session in
// Search Sessions. Quick Chat then opens it as its destination.
export function startQuickChatSession(connection: FeedConnection, metadata: ServerMetadata, settings: ChatDefaults) {
  return launchSession(
    {
      connection,
      client: new WaypointClient(connection.apiUrl),
      now: Date.now,
      metadata,
      workspace: localWorkspace(connection.apiUrl),
    },
    quickChatStore,
    connectionCheck(connection),
    settings,
    quickChatDraft,
    "edit",
  );
}

export function useQuickChat(connection: FeedConnection, forceNew: boolean, resume = false) {
  const controller = useMemo(
    () =>
      new QuickChatController(connection, quickChatStore, connectionCheck(connection), {
        forceNew,
        resume,
        workspace: localWorkspace(connection.apiUrl),
      }),
    [connection.id, connection.apiUrl, connection.token, forceNew, resume],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    void controller.start();
    return () => controller.stop();
  }, [controller]);
  return { controller, state };
}
