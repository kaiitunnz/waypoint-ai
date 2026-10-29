import { Action, ActionPanel, Detail, Icon, useNavigation } from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ServerMetadata } from "../api/contracts";
import { checkpointOffer, reattachSource } from "../domain/sessionActions";
import { sessionUrl } from "../domain/sessions";
import { QuickChatController } from "../hooks/quickChatController";
import { FeedConnection } from "../hooks/sessionFeeds";
import { SessionManager } from "../hooks/sessionManager";
import { useConnections } from "../hooks/useConnections";
import { useQuickChat } from "../hooks/useQuickChat";
import { quickChatStore } from "../storage/raycast";
import { LoadingView } from "../components/SessionPresentation";
import { ChatConversation, SessionActionContext } from "./ChatConversation";
import { CheckpointActions, ComposeActions, SessionReattachAction, TargetActions } from "./ChatActions";
import { ManageServers } from "./ManageServers";
import { SignInForm } from "./ServerForm";
import { SessionActions } from "./SessionActions";

export function ConversationScreen({
  connectionId,
  sessionId,
  metadata,
  quickChat,
}: {
  connectionId: string;
  sessionId: string;
  metadata: ServerMetadata;
  // Quick Chat opened on this server's chosen session.
  quickChat?: () => React.ReactElement;
}) {
  const { state, error, refresh } = useConnections();
  if (!state && !error) return <LoadingView title="Loading connection…" />;
  const connection = state?.connections.find((item) => item.id === connectionId);
  if (!connection?.token)
    return (
      <Detail
        markdown={`## ${error ? "Saved connection unavailable" : "Sign in to view this conversation"}\n\n${error ?? "The connection was changed or removed. Open Manage Servers to reconnect."}`}
        actions={
          <ActionPanel>
            {connection && (
              <Action.Push
                title="Sign in"
                icon={Icon.Lock}
                target={<SignInForm connection={connection} onSaved={refresh} />}
              />
            )}
            <Action.Push title="Manage Servers" icon={Icon.Network} target={<ManageServers />} onPop={refresh} />
          </ActionPanel>
        }
      />
    );
  return (
    <SessionChat
      connection={{ ...connection, token: connection.token }}
      sessionId={sessionId}
      metadata={metadata}
      quickChat={quickChat}
      refreshConnections={refresh}
    />
  );
}

// A chat bound to one session: it sends only there and never changes Quick Chat's destination.
function SessionChat({
  connection,
  sessionId,
  metadata,
  quickChat,
  refreshConnections,
}: {
  connection: FeedConnection;
  sessionId: string;
  metadata: ServerMetadata;
  quickChat?: () => React.ReactElement;
  refreshConnections: () => Promise<void>;
}) {
  const { state, controller } = useQuickChat(connection, { kind: "session", sessionId });
  const checkpoint = checkpointOffer(state.pending, state.pendingOwned, sessionId) !== "none";
  const status = [
    state.error,
    state.blocked !== state.error && state.blocked,
    checkpoint && (state.notice || "Previous attempt unconfirmed."),
  ]
    .filter(Boolean)
    .join("\n");
  const reattach = reattachSource(state.busy, state.pending, sessionId);
  const refresh = () => {
    void controller.syncPending();
    void controller.refreshSession();
  };
  return (
    <ChatConversation
      connection={connection}
      sessionId={sessionId}
      metadata={metadata}
      refreshConnections={refreshConnections}
      composer={{
        text: state.draft,
        onChange: (text) => controller.changeDraft(text),
        onSend: () => {
          void controller.send();
        },
        canSend: controller.canSend(),
      }}
      status={status || undefined}
      busy={state.busy}
      revision={state.revision}
      onPendingChange={() => void controller.syncPending()}
      onMissing={(id) => controller.markMissing(id)}
      onSession={() => void controller.refreshSession()}
      onReturn={refresh}
      hasDraft={state.hasDraft}
      settings={{ available: !state.busy && state.pending?.sessionId !== sessionId }}
      actions={({ setActive, browser }) => (
        <SessionChatActions
          controller={controller}
          connection={connection}
          sessionId={sessionId}
          metadata={metadata}
          refreshConnections={refreshConnections}
          setActive={setActive}
          browser={browser}
          reattach={reattach === "chat"}
        />
      )}
      sessionActions={(context) => (
        <ConversationSessionActions
          {...context}
          connection={connection}
          metadata={metadata}
          quickChat={quickChat}
          omitReattach={reattach !== "direct"}
          onReturn={refresh}
        />
      )}
    />
  );
}

function SessionChatActions({
  controller,
  connection,
  sessionId,
  metadata,
  refreshConnections,
  setActive,
  browser,
  reattach,
}: {
  controller: QuickChatController;
  connection: FeedConnection;
  sessionId: string;
  metadata: ServerMetadata;
  refreshConnections: () => Promise<void>;
  setActive: (active: boolean) => void;
  browser: boolean;
  reattach: boolean;
}) {
  const url = sessionUrl(connection.frontendUrl, sessionId);
  const returned = () => {
    setActive(true);
    void refreshConnections();
    void controller.syncPending();
  };
  return (
    <>
      <ComposeActions controller={controller} metadata={metadata} />
      <TargetActions controller={controller} metadata={metadata} />
      <CheckpointActions controller={controller} sessionId={sessionId} />
      {reattach && <SessionReattachAction controller={controller} metadata={metadata} />}
      <Action
        title="Reconnect Chat"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
        onAction={() => controller.start()}
      />
      <Action.Push
        title="Sign in Again"
        icon={Icon.Lock}
        target={<SignInForm connection={connection} onSaved={refreshConnections} />}
        onPush={() => setActive(false)}
        onPop={returned}
      />
      {browser && url && <Action.OpenInBrowser title="Open in Waypoint" url={url} />}
      <Action.Push
        title="Manage Servers"
        icon={Icon.Network}
        target={<ManageServers />}
        onPush={() => setActive(false)}
        onPop={returned}
      />
    </>
  );
}

function ConversationSessionActions({
  connection,
  metadata,
  session,
  feed,
  setActive,
  quickChat,
  omitReattach,
  onReturn,
}: SessionActionContext & {
  connection: FeedConnection;
  metadata: ServerMetadata;
  quickChat?: () => React.ReactElement;
  omitReattach: boolean;
  onReturn: () => void;
}) {
  const { push, pop } = useNavigation();
  const manager = useMemo(
    () => new SessionManager(connection, quickChatStore),
    [connection.id, connection.apiUrl, connection.token],
  );
  const [state, setState] = useState<{ pointer?: string; pending: boolean }>({ pending: false });
  const read = useCallback(() => {
    manager.quickChat().then(setState, () => setState({ pending: false }));
  }, [manager]);
  useEffect(read, [read]);
  return (
    <SessionActions
      session={session}
      metadata={metadata}
      quickChat={state}
      manager={manager}
      omitReattach={omitReattach}
      handlers={{
        onChanged: () => {
          feed.retry();
          read();
          onReturn();
        },
        onDeleted: () => pop(),
        openQuickChat: () => {
          if (!quickChat) return;
          setActive(false);
          push(quickChat(), () => {
            setActive(true);
            read();
            onReturn();
          });
        },
      }}
    />
  );
}
