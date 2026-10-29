import { ApiError, WaypointClient } from "../api/client";
import { InboxItem } from "../api/inbox";
import { Connection, ConnectionState } from "../domain/connections";

export const menuBarItems = 10;

export type MenuBarData =
  | { kind: "items"; server: Connection; count: number; items: InboxItem[] }
  | { kind: "sign-in"; server: Connection }
  | { kind: "unreachable"; server: Connection; message: string }
  | { kind: "no-server" };

export function activeConnection(state: ConnectionState): Connection | undefined {
  return state.connections.find((item) => item.id === (state.activeId ?? state.defaultId)) ?? state.connections[0];
}

export async function loadMenuBar(
  state: ConnectionState,
  makeClient = (apiUrl: string) => new WaypointClient(apiUrl),
): Promise<MenuBarData> {
  const server = activeConnection(state);
  if (!server) return { kind: "no-server" };
  if (!server.token) return { kind: "sign-in", server };
  const client = makeClient(server.apiUrl);
  try {
    const [count, page] = await Promise.all([
      client.inboxCount(server.token),
      client.inbox(server.token, { status: "open", limit: menuBarItems }),
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
