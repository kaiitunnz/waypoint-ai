import { Action, ActionPanel, Icon, Keyboard, List, Toast, useNavigation } from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSessionsFeed } from "../hooks/useSessionFeeds";
import { FeedConnection } from "../hooks/sessionFeeds";
import { Session } from "../api/sessions";
import { quickChatStore } from "../storage/raycast";
import { SessionFilter, visibleSessions, isStructured, sessionUrl } from "../domain/sessions";
import { SessionDetail, statusIcon } from "../components/SessionPresentation";
import { ServerAccessory, ServerGate } from "../components/ServerGate";
import { SessionActions } from "./SessionActions";
import { SessionManager } from "../hooks/sessionManager";
import { ManageServers } from "./ManageServers";
import { SignInForm } from "./ServerForm";
import { ConversationScreen } from "./SessionChat";
import { QuickChat } from "./QuickChat";

export function BrowseSessions() {
  const [query, setQuery] = useState("");
  return (
    <ServerGate
      navigationTitle="Waypoint · Sessions"
      signInTitle="Sign in to browse sessions"
      signInDescription={(server) => `Sign in to ${server} to find its sessions.`}
    >
      {(connection, accessory, refresh) => (
        <SessionsBrowser
          connection={connection}
          refreshConnections={refresh}
          query={query}
          onQueryChange={setQuery}
          accessory={accessory}
        />
      )}
    </ServerGate>
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
  accessory: ServerAccessory;
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
          shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
          icon={Icon.Lock}
          target={<SignInForm connection={connection} onSaved={refreshConnections} />}
          onPush={() => setActive(false)}
          onPop={() => {
            setActive(true);
            void refreshConnections();
          }}
        />
      )}
      <Action.Push
        title="New Chat"
        icon={Icon.Plus}
        shortcut={Keyboard.Shortcut.Common.New}
        target={<QuickChat forceNew connectionId={connection.id} />}
        onPush={pause}
        onPop={resume}
      />
      <Action
        title="Refresh Sessions"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={() => feed.retry()}
      />

      <Action
        title={filter === "active" ? "Show Exited Sessions" : "Show Active Sessions Only"}
        icon={Icon.Filter}
        shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
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
                      ? [{ tag: "Quick Chat", tooltip: "Quick Chat's destination on this server" }]
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
