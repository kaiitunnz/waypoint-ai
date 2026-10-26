import { Action, ActionPanel, Icon, Keyboard, List, Toast, showToast, useNavigation } from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnections } from "../hooks/useConnections";
import { useSessionsFeed } from "../hooks/useSessionFeeds";
import { FeedConnection } from "../hooks/sessionFeeds";
import { Session } from "../api/sessions";
import { connectionStore, quickChatStore } from "../storage/raycast";
import { SessionFilter, visibleSessions, isStructured, sessionUrl } from "../domain/sessions";
import { LoadingView, SessionDetail, statusIcon } from "../components/SessionPresentation";
import { SessionActions } from "./SessionActions";
import { SessionManager } from "../hooks/sessionManager";
import { ManageServers } from "./ManageServers";
import { SignInForm } from "./ServerForm";
import { ConversationScreen } from "./Conversation";
import { QuickChat } from "./QuickChat";

export function SearchSessions() {
  const { state, error, refresh } = useConnections();
  const [serverId, setServerId] = useState<string>();
  const [query, setQuery] = useState("");
  if (!state && !error) return <LoadingView title="Loading saved servers…" />;
  const connection =
    state?.connections.find((item) => item.id === (serverId ?? state.activeId ?? state.defaultId)) ??
    state?.connections[0];
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
      <List navigationTitle="Waypoint · Sessions" searchBarAccessory={accessory}>
        <List.EmptyView
          title={
            error ? "Saved servers need attention" : connection ? "Sign in to browse sessions" : "Connect to Waypoint"
          }
          description={
            error ??
            (connection
              ? `Sign in to ${connection.name} to find its sessions.`
              : "Add a Waypoint API server using Manage Servers.")
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
    <SessionsBrowser
      key={connection.id}
      connection={{ ...connection, token: connection.token }}
      refreshConnections={refresh}
      query={query}
      onQueryChange={setQuery}
      accessory={accessory}
    />
  );
}

function SessionsBrowser({
  connection,
  refreshConnections,
  accessory,
  query,
  onQueryChange,
}: {
  connection: FeedConnection;
  refreshConnections: () => Promise<void>;
  accessory: React.ComponentProps<typeof List>["searchBarAccessory"];
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const [active, setActive] = useState(true);
  const [filter, setFilter] = useState<SessionFilter>("active");
  const { state, feed } = useSessionsFeed(connection, active);
  const { push } = useNavigation();
  const manager = useMemo(
    () => new SessionManager(connection, quickChatStore),
    [connection.id, connection.apiUrl, connection.token],
  );
  const [quickChat, setQuickChat] = useState<{ pointer?: string; pending: boolean }>({ pending: false });
  const readQuickChat = useCallback(() => {
    manager.quickChat().then(setQuickChat, () => setQuickChat({ pending: false }));
  }, [manager]);
  useEffect(() => {
    if (active) readQuickChat();
  }, [active, readQuickChat]);
  const pause = () => setActive(false);
  const resume = () => {
    setActive(true);
    void refreshConnections();
  };
  const handlers = {
    onChanged: (session: Session) => {
      feed.apply(session);
      readQuickChat();
    },
    onDeleted: (id: string) => {
      feed.remove(id);
      readQuickChat();
    },
    openQuickChat: () => {
      pause();
      push(<QuickChat connectionId={connection.id} resume />, resume);
    },
    afterTerminate:
      filter === "active"
        ? { title: "Show Exited Sessions", onAction: (toast: Toast) => (setFilter("all"), toast.hide()) }
        : undefined,
  };
  const sessions = useMemo(
    () => visibleSessions(state.sessions, query, filter, state.metadata),
    [state.sessions, query, filter, state.metadata],
  );
  const auth = state.error?.kind === "expired-token" || state.stream === "auth-error";
  const shared = (
    <>
      {auth && (
        <Action.Push
          title="Sign in Again"
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "l" },
            Windows: { modifiers: ["ctrl", "shift"], key: "l" },
          }}
          icon={Icon.Lock}
          target={<SignInForm connection={connection} onSaved={refreshConnections} />}
          onPush={() => setActive(false)}
          onPop={() => {
            setActive(true);
            void refreshConnections();
          }}
        />
      )}
      <Action
        title="Refresh Sessions"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={() => feed.retry()}
      />

      <Action
        title={filter === "active" ? "Show Exited Sessions" : "Show Active Sessions Only"}
        icon={Icon.Filter}
        shortcut={{
          macOS: { modifiers: ["cmd", "shift"], key: "e" },
          Windows: { modifiers: ["ctrl", "shift"], key: "e" },
        }}
        onAction={() => setFilter((value) => (value === "active" ? "all" : "active"))}
      />
      <Action title="Show Only Exited Sessions" icon={Icon.Stop} onAction={() => setFilter("exited")} />
      <Action.Push
        title="Manage Servers"
        icon={Icon.Network}
        target={<ManageServers />}
        onPush={() => setActive(false)}
        onPop={() => {
          setActive(true);
          void refreshConnections();
        }}
      />
    </>
  );
  return (
    <List
      navigationTitle={`Waypoint · ${connection.name}`}
      searchBarPlaceholder="Search sessions…"
      searchText={query}
      onSearchTextChange={onQueryChange}
      filtering={false}
      searchBarAccessory={accessory}
      isShowingDetail={!!sessions.length || !!state.error || state.stream === "reconnecting"}
      isLoading={state.loading}
    >
      {(state.error || state.stream === "reconnecting") && (
        <List.Section title="Connection">
          <List.Item
            id="connection-status"
            title={
              auth ? "Sign-in expired" : state.error ? "Could not refresh sessions" : "Reconnecting to live updates…"
            }
            subtitle="Saved connection is kept"
            icon={Icon.ExclamationMark}
            detail={
              <List.Item.Detail
                markdown={`## Connection status\n\n${state.error?.message ?? "The live connection is unavailable. Loaded sessions remain available; refresh to try again."}`}
              />
            }
            actions={<ActionPanel>{shared}</ActionPanel>}
          />
        </List.Section>
      )}
      {([true, false] as const).map((pinned) => (
        <List.Section
          key={String(pinned)}
          title={pinned ? "Pinned" : filter === "exited" ? "Exited Sessions" : "Recent Sessions"}
          subtitle={pinned ? undefined : filter === "active" ? "Active" : "Including exited"}
        >
          {sessions
            .filter((session) => !!session.pinnedAt === pinned)
            .map((session) => {
              const structured = isStructured(session, state.metadata);
              const url = sessionUrl(connection.frontendUrl, session.id);
              return (
                <List.Item
                  key={session.id}
                  id={session.id}
                  title={session.title || "Untitled session"}
                  keywords={[session.backend, session.status]}
                  icon={statusIcon(session.status)}
                  accessories={
                    quickChat.pointer === session.id
                      ? [{ tag: "Quick Chat", tooltip: "Quick Chat continues this session" }]
                      : undefined
                  }
                  detail={<SessionDetail session={session} structured={structured} />}
                  actions={
                    <ActionPanel>
                      {structured && state.metadata ? (
                        <Action.Push
                          title="Open Conversation"
                          icon={Icon.Message}
                          target={
                            <ConversationScreen
                              connectionId={connection.id}
                              sessionId={session.id}
                              metadata={state.metadata}
                              quickChat={() => <QuickChat connectionId={connection.id} resume />}
                              newChat={{
                                start: async (build) => {
                                  await quickChatStore.transaction(connection.id, async (saved, persist) => {
                                    saved.defaults = build(saved.defaults);
                                    await persist();
                                  });
                                  return <QuickChat forceNew connectionId={connection.id} />;
                                },
                              }}
                            />
                          }
                          onPush={() => setActive(false)}
                          onPop={() => {
                            setActive(true);
                            void refreshConnections();
                          }}
                        />
                      ) : url ? (
                        <Action.OpenInBrowser title="Open in Waypoint" url={url} />
                      ) : (
                        <Action.Push
                          title="Configure Frontend URL"
                          icon={Icon.Network}
                          target={<ManageServers />}
                          onPush={() => setActive(false)}
                          onPop={() => {
                            setActive(true);
                            void refreshConnections();
                          }}
                        />
                      )}
                      {structured && url && <Action.OpenInBrowser title="Open in Waypoint" url={url} />}
                      <SessionActions
                        session={session}
                        metadata={state.metadata}
                        quickChat={quickChat}
                        manager={manager}
                        handlers={handlers}
                      />
                      <ActionPanel.Section>{shared}</ActionPanel.Section>
                    </ActionPanel>
                  }
                />
              );
            })}
        </List.Section>
      ))}
      {!sessions.length && (
        <List.EmptyView
          title={
            state.loading
              ? "Loading sessions…"
              : auth
                ? "Sign in to reconnect"
                : query
                  ? "No matching sessions"
                  : "No sessions to show"
          }
          description={
            state.error?.message ??
            (query
              ? "Try another title, folder, branch, agent, or status."
              : "Choose Show Exited Sessions, switch servers, or start a session in Waypoint.")
          }
          icon={Icon.Message}
          actions={<ActionPanel>{shared}</ActionPanel>}
        />
      )}
    </List>
  );
}
