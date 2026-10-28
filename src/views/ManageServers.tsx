import { Action, ActionPanel, Alert, Color, Icon, List, Keyboard, Toast, confirmAlert, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import { ServerDetail, statusLabel } from "../components/ServerDetail";
import { useConnections, useConnectionStatus } from "../hooks/useConnections";
import { clipboardFiles, connectionStore, quickChatStore } from "../storage/raycast";
import { ServerForm, SignInForm } from "./ServerForm";

export function ManageServers() {
  const { state, loading, error, refresh } = useConnections();
  const [selectedId, setSelectedId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const selected =
    state?.connections.find((item) => item.id === selectedId) ??
    state?.connections.find((item) => item.id === state.activeId) ??
    state?.connections[0];
  const status = useConnectionStatus(selected, revision);
  const retry = () => setRevision((value) => value + 1);
  // Also clears data left by servers removed earlier, or written back by a view still open on one.
  useEffect(() => {
    quickChatStore
      .sweep()
      .catch(() => undefined)
      .then(() => clipboardFiles.sweep());
  }, []);
  async function reload() {
    await refresh();
    retry();
  }
  async function mutate(operation: () => Promise<void>, title: string) {
    try {
      await operation();
      await reload();
      await showToast({ style: Toast.Style.Success, title });
    } catch {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not update servers",
        message: "Your saved data was kept. Retry the action.",
      });
    }
  }
  const add = (
    <Action.Push
      title="Add Server"
      icon={Icon.Plus}
      shortcut={Keyboard.Shortcut.Common.New}
      target={<ServerForm onSaved={reload} />}
    />
  );
  return (
    <List
      navigationTitle="Waypoint · Servers"
      searchBarPlaceholder="Find a Waypoint server…"
      isShowingDetail={!!state?.connections.length && !error}
      isLoading={loading || (!!selected && status.kind === "loading")}
      selectedItemId={selected?.id}
      onSelectionChange={(id) => {
        if (id) setSelectedId(id);
      }}
    >
      {error ? (
        <List.EmptyView
          title="Saved servers need attention"
          description={error}
          icon={Icon.ExclamationMark}
          actions={
            <ActionPanel>
              <Action title="Retry Loading" icon={Icon.ArrowClockwise} onAction={refresh} />
            </ActionPanel>
          }
        />
      ) : !state?.connections.length ? (
        <List.EmptyView
          title="Your agents, one shortcut away"
          description="Add a Waypoint API server to get started. Connect a local server or a remote workspace, then sign in securely."
          icon={Icon.Network}
          actions={<ActionPanel>{add}</ActionPanel>}
        />
      ) : (
        <List.Section
          title="Saved Servers"
          subtitle={`${state.connections.length} ${state.connections.length === 1 ? "connection" : "connections"}`}
        >
          {state.connections.map((connection) => {
            const isSelected = connection.id === selected?.id;
            const isDefault = connection.id === state.defaultId;
            const isActive = connection.id === state.activeId;
            const needsSignIn =
              !connection.token || (isSelected && status.kind === "error" && status.error.kind === "expired-token");
            const signIn = (
              <Action.Push
                title={connection.token ? "Sign in Again" : "Sign in"}
                shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
                icon={Icon.Lock}
                target={<SignInForm connection={connection} onSaved={reload} />}
              />
            );
            return (
              <List.Item
                key={connection.id}
                id={connection.id}
                title={connection.name}
                keywords={[connection.apiUrl]}
                icon={{
                  source: Icon.Network,
                  tintColor:
                    isSelected && status.kind === "ready" ? Color.Green : isActive ? Color.Blue : Color.SecondaryText,
                }}
                accessories={[
                  ...(isDefault ? [{ icon: Icon.Star, tooltip: "Default server" }] : []),
                  ...(isActive
                    ? [{ icon: { source: Icon.CheckCircle, tintColor: Color.Blue }, tooltip: "Active server" }]
                    : []),
                ]}
                detail={
                  isSelected ? (
                    <ServerDetail connection={connection} status={status} isDefault={isDefault} isActive={isActive} />
                  ) : undefined
                }
                actions={
                  <ActionPanel>
                    <ActionPanel.Section title={isSelected ? statusLabel(status) : connection.name}>
                      {needsSignIn ? (
                        signIn
                      ) : (
                        <Action
                          title="Use Server"
                          icon={Icon.Checkmark}
                          onAction={() => mutate(() => connectionStore.select(connection.id), "Active server updated")}
                        />
                      )}
                      {!needsSignIn && signIn}
                      <Action
                        title="Retry Connection"
                        icon={Icon.ArrowClockwise}
                        shortcut={Keyboard.Shortcut.Common.Refresh}
                        onAction={retry}
                      />
                      {connection.frontendUrl && (
                        <Action.OpenInBrowser title="Open in Waypoint" url={connection.frontendUrl} />
                      )}
                    </ActionPanel.Section>
                    <ActionPanel.Section title="Manage">
                      <Action.Push
                        title="Edit Server"
                        icon={Icon.Pencil}
                        shortcut={Keyboard.Shortcut.Common.Edit}
                        target={<ServerForm connection={connection} onSaved={reload} />}
                      />
                      {!isDefault && (
                        <Action
                          title="Make Default Server"
                          shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
                          icon={Icon.Star}
                          onAction={() =>
                            mutate(() => connectionStore.select(connection.id, true), "Default server updated")
                          }
                        />
                      )}
                      {add}
                      <Action
                        title="Remove Server"
                        icon={Icon.Trash}
                        style={Action.Style.Destructive}
                        shortcut={Keyboard.Shortcut.Common.Remove}
                        onAction={async () => {
                          if (
                            await confirmAlert({
                              title: `Remove ${connection.name}?`,
                              message:
                                "Remove this saved connection, its local credentials, and its Quick Chat drafts and settings. Sessions on Waypoint keep running.",
                              primaryAction: { title: "Remove Server", style: Alert.ActionStyle.Destructive },
                            })
                          ) {
                            await mutate(() => connectionStore.remove(connection.id), "Server removed");
                            await quickChatStore.sweep().catch(() =>
                              showToast({
                                style: Toast.Style.Failure,
                                title: "Server removed",
                                message:
                                  "Its Quick Chat drafts couldn't be cleared yet; reopening Manage Servers retries.",
                              }),
                            );
                          }
                        }}
                      />
                    </ActionPanel.Section>
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}
