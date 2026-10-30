import { Action, ActionPanel, Detail } from "@raycast/api";
import { useEffect, useState } from "react";
import { ApiError, WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import { isStructured, sessionUrl } from "../domain/sessions";
import { FeedConnection } from "../hooks/sessionFeeds";
import { LoadingView } from "../components/SessionPresentation";
import { ConversationScreen } from "./SessionChat";

export function InboxSession({
  connection,
  sessionId,
  metadata,
}: {
  connection: FeedConnection;
  sessionId: string;
  metadata?: ServerMetadata;
}) {
  const [state, setState] = useState<{ session?: Session; metadata?: ServerMetadata; error?: string }>();
  useEffect(() => {
    let current = true;
    const client = new WaypointClient(connection.apiUrl);
    Promise.all([client.session(connection.token, sessionId), metadata ?? client.me(connection.token)]).then(
      ([session, loaded]) => current && setState({ session, metadata: loaded }),
      (error) =>
        current &&
        setState({
          error:
            error instanceof ApiError && error.kind === "not-found"
              ? "The session that posted this item was deleted."
              : error instanceof Error
                ? error.message
                : String(error),
        }),
    );
    return () => {
      current = false;
    };
  }, [connection.id, connection.apiUrl, connection.token, sessionId]);
  if (!state) return <LoadingView title="Loading the session…" />;
  const url = sessionUrl(connection.frontendUrl, sessionId);
  if (state.session && state.metadata && isStructured(state.session, state.metadata))
    return <ConversationScreen connectionId={connection.id} sessionId={sessionId} metadata={state.metadata} />;
  return (
    <Detail
      markdown={`## ${state.error ? "Session unavailable" : "Open this session in Waypoint"}\n\n${state.error ?? "Raycast shows conversations for chat interfaces; this session uses a terminal."}`}
      actions={
        url ? (
          <ActionPanel>
            <Action.OpenInBrowser title="Open in Waypoint" url={url} />
          </ActionPanel>
        ) : undefined
      }
    />
  );
}
