import { Action, ActionPanel, Icon, Keyboard, List, Toast, showToast } from "@raycast/api";
import { Fragment, ReactNode, useState } from "react";
import { activeConnection } from "../domain/connections";
import { FeedConnection } from "../hooks/sessionFeeds";
import { useConnections } from "../hooks/useConnections";
import { connectionStore } from "../storage/raycast";
import { ManageServers } from "../views/ManageServers";
import { SignInForm } from "../views/ServerForm";
import { LoadingView } from "./SessionPresentation";

export type ServerAccessory = React.ComponentProps<typeof List>["searchBarAccessory"];

// Asks to connect or sign in before showing a server's list; the dropdown switches the active server.
export function ServerGate({
  navigationTitle,
  signInTitle,
  signInDescription,
  initialServerId,
  children,
}: {
  navigationTitle: string;
  signInTitle: string;
  signInDescription: (server: string) => string;
  initialServerId?: string;
  children: (connection: FeedConnection, accessory: ServerAccessory, refresh: () => Promise<void>) => ReactNode;
}) {
  const { state, error, refresh } = useConnections();
  const [serverId, setServerId] = useState(initialServerId);
  if (!state && !error) return <LoadingView title="Loading saved servers…" />;
  const connection = state && activeConnection(state, serverId);
  async function selectServer(id: string) {
    setServerId(id);
    try {
      await connectionStore.select(id);
      await refresh();
    } catch {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not switch server",
        message: "Open Manage Servers and retry.",
      });
    }
  }
  const accessory = connection ? (
    <List.Dropdown tooltip="Waypoint server" value={connection.id} onChange={selectServer}>
      {state?.connections.map((server) => (
        <List.Dropdown.Item key={server.id} title={server.name} value={server.id} icon={Icon.Network} />
      ))}
    </List.Dropdown>
  ) : undefined;
  if (!connection?.token)
    return (
      <List navigationTitle={navigationTitle} searchBarAccessory={accessory}>
        <List.EmptyView
          title={error ? "Saved servers need attention" : connection ? signInTitle : "Connect to Waypoint"}
          description={
            error ??
            (connection ? signInDescription(connection.name) : "Add a Waypoint API server using Manage Servers.")
          }
          actions={
            <ActionPanel>
              {connection && (
                <Action.Push
                  title="Sign in"
                  icon={Icon.Lock}
                  target={<SignInForm connection={connection} onSaved={refresh} />}
                />
              )}
              {error && (
                <Action
                  title="Retry Loading"
                  icon={Icon.ArrowClockwise}
                  shortcut={Keyboard.Shortcut.Common.Refresh}
                  onAction={refresh}
                />
              )}
              <Action.Push title="Manage Servers" icon={Icon.Network} target={<ManageServers />} onPop={refresh} />
            </ActionPanel>
          }
        />
      </List>
    );
  return (
    <Fragment key={connection.id}>{children({ ...connection, token: connection.token }, accessory, refresh)}</Fragment>
  );
}
