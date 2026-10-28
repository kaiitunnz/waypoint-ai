import { useEffect, useMemo, useSyncExternalStore } from "react";
import { WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { ChatDefaults } from "../domain/quickChat";
import { ChatDestination, QuickChatController, quickChatDraft } from "./quickChatController";
import { LaunchFailure, launchSession } from "./sessionLauncher";
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

// Starts a Quick Chat session from chosen settings outside a Quick Chat view. Quick Chat then opens it as its
// destination.
// Throws `LaunchFailure` when the session wasn't started.
export async function startQuickChatSession(
  connection: FeedConnection,
  metadata: ServerMetadata,
  build: (defaults: ChatDefaults) => ChatDefaults,
) {
  const saved = await quickChatStore.read(connection.id);
  const result = await launchSession(
    {
      connection,
      client: new WaypointClient(connection.apiUrl),
      now: Date.now,
      metadata,
      workspace: localWorkspace(connection.apiUrl),
    },
    quickChatStore,
    connectionCheck(connection),
    build(saved.defaults),
    quickChatDraft,
    "edit",
  );
  if (result.kind !== "created") throw new LaunchFailure(result);
}

export function useQuickChat(connection: FeedConnection, destination: ChatDestination) {
  const sessionId = destination.kind === "session" ? destination.sessionId : undefined;
  const resume = destination.kind === "quick" && !!destination.resume;
  const controller = useMemo(
    () =>
      new QuickChatController(connection, quickChatStore, connectionCheck(connection), {
        destination,
        workspace: localWorkspace(connection.apiUrl),
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
