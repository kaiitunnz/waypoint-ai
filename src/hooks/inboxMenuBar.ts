import { ApiError, WaypointClient } from "../api/client";
import { InboxItem } from "../api/inbox";
import { Connection, ConnectionState } from "../domain/connections";

export const menuBarItems = 10;

// The server is named without its token, so nothing here carries a credential.
type Server = { id: string; name: string };
export type MenuBarData =
  | { kind: "items"; server: Server; count: number; items: InboxItem[] }
  | { kind: "sign-in"; server: Server }
  | { kind: "unreachable"; server: Server; message: string }
  | { kind: "no-server" };

export function activeConnection(state: ConnectionState): Connection | undefined {
  return state.connections.find((item) => item.id === (state.activeId ?? state.defaultId)) ?? state.connections[0];
}

export async function loadMenuBar(
  state: ConnectionState,
  makeClient = (apiUrl: string) => new WaypointClient(apiUrl),
): Promise<MenuBarData> {
  const connection = activeConnection(state);
  if (!connection) return { kind: "no-server" };
  const server = { id: connection.id, name: connection.name };
  if (!connection.token) return { kind: "sign-in", server };
  const client = makeClient(connection.apiUrl);
  try {
    const [count, page] = await Promise.all([
      client.inboxCount(connection.token),
      client.inbox(connection.token, { status: "open", limit: menuBarItems }),
    ]);
    return { kind: "items", server, count, items: page.items };
  } catch (error) {
    if (error instanceof ApiError && error.kind === "expired-token") return { kind: "sign-in", server };
    return {
      kind: "unreachable",
      server,
      message: error instanceof ApiError ? error.message : "Could not reach the server.",
    };
  }
}
