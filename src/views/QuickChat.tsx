import { Action, ActionPanel, Alert, Icon, Keyboard, List, Toast, confirmAlert, showToast } from "@raycast/api";
import { useState, useSyncExternalStore } from "react";
import { useConnections } from "../hooks/useConnections";
import { useQuickChat } from "../hooks/useQuickChat";
import { FeedConnection } from "../hooks/sessionFeeds";
import { connectionStore } from "../storage/raycast";
import { localWorkspace } from "../storage/workspace";
import { launchContext, resumeFor } from "../domain/quickChat";
import { sessionUrl } from "../domain/sessions";
import { checkpointOffer, deleteMessage, quickChatMovesOn, terminateMessage } from "../domain/sessionActions";
import { ChatConversation } from "./ChatConversation";
import { QuickChatController } from "../hooks/quickChatController";
import { QuickChatDefaults } from "./QuickChatDefaults";
import { NewSessionSettings } from "./NewSessionSettings";
import { CheckpointActions, ComposeActions, SessionReattachAction, TargetActions } from "./ChatActions";
import { SignInForm } from "./ServerForm";
import { ManageServers } from "./ManageServers";
import { LoadingView } from "../components/SessionPresentation";

// A pinned connection opens that server without changing the saved server selection. `resume` opens that
// server's saved destination, such as a session chosen with Use for Quick Chat, whatever the reuse mode.
export function QuickChat({
  forceNew = false,
  connectionId,
  resume = false,
}: {
  forceNew?: boolean;
  connectionId?: string;
  resume?: boolean;
}) {
  const { state, error, refresh } = useConnections();
  const [selected, setSelected] = useState(connectionId);
  if (!state && !error) return <LoadingView title="Loading Quick Chat…" />;
  const connection =
    state?.connections.find((item) => item.id === (selected ?? state.activeId ?? state.defaultId)) ??
    state?.connections[0];
  async function selectServer(id: string) {
    setSelected(id);
    try {
      await connectionStore.select(id);
      await refresh();
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "Could not save server selection" });
    }
  }
  const accessory = connection ? (
    <List.Dropdown tooltip="Waypoint server" value={connection.id} onChange={selectServer}>
      {state?.connections.map((server) => (
        <List.Dropdown.Item key={server.id} value={server.id} title={server.name} icon={Icon.Network} />
      ))}
    </List.Dropdown>
  ) : undefined;
  if (!connection?.token)
    return (
      <List navigationTitle={forceNew ? "New Chat" : "Quick Chat"} searchBarAccessory={accessory}>
        <List.EmptyView
          icon={Icon.Message}
          title={
            error ? "Saved servers need attention" : connection ? "Sign in to start chatting" : "Connect to Waypoint"
          }
          description={
            error ??
            (connection ? `Sign in to ${connection.name} to chat.` : "Add a Waypoint API server using Manage Servers.")
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
  const resumed = resumeFor(connection.id, connectionId, resume);
  return (
    <QuickChatView
      key={`${connection.id}:${forceNew}:${resumed}`}
      connection={{ ...connection, token: connection.token }}
      forceNew={forceNew}
      resume={resumed}
      refreshConnections={refresh}
      accessory={accessory}
    />
  );
}

function QuickChatView({
  connection,
  forceNew,
  resume,
  refreshConnections,
  accessory,
}: {
  connection: FeedConnection;
  forceNew: boolean;
  resume: boolean;
  refreshConnections: () => Promise<void>;
  accessory?: React.ComponentProps<typeof List>["searchBarAccessory"];
}) {
  const { state, controller } = useQuickChat(connection, { kind: forceNew ? "new" : "quick", resume });
  const metadata = state.metadata;
  const context =
    metadata && state.defaults
      ? launchContext(state.defaults, metadata, localWorkspace(connection.apiUrl)?.dir)
      : undefined;
  const actions = ({ setActive, browser }: { setActive: (value: boolean) => void; browser: boolean }) => (
    <QuickChatActions
      controller={controller}
      connection={connection}
      refreshConnections={refreshConnections}
      setActive={setActive}
      browser={browser}
    />
  );
  if (state.loading && !state.session) return <LoadingView title="Preparing your chat…" />;
  const checkpoint = checkpointOffer(state.pending, state.pendingOwned, state.session?.id) !== "none";
  const status = state.error || (checkpoint ? state.notice || "Previous attempt unconfirmed." : undefined);
  if (metadata)
    return (
      <ChatConversation
        connection={connection}
        sessionId={state.session?.id}
        metadata={metadata}
        emptyMarkdown={
          context
            ? `## New conversation\n\n**${context.agent?.label ?? "Waypoint"}** · ${context.target?.name ?? "Local server"}\n\n${context.cwd}`
            : ""
        }
        refreshConnections={refreshConnections}
        composer={{
          text: state.draft,
          onChange: (text) => controller.changeDraft(text),
          onSend: () => {
            void controller.send();
          },
          canSend: controller.canSend(),
          accessory,
        }}
        actions={actions}
        status={status || undefined}
        busy={state.busy}
        revision={state.revision}
        onPendingChange={() => void controller.syncPending()}
        onReturn={() => void controller.syncPending()}
        onMissing={(id) => controller.markMissing(id)}
        hasDraft={state.hasDraft}
        settings={{ available: !state.busy && !state.pending }}
      />
    );
  return (
    <List
      navigationTitle={`${forceNew ? "New Chat" : "Quick Chat"} · ${connection.name}`}
      searchBarPlaceholder="Message Waypoint…"
      searchText={state.draft}
      onSearchTextChange={(text) => controller.changeDraft(text)}
      filtering={false}
      searchBarAccessory={accessory}
      isLoading={state.loading || state.busy}
      isShowingDetail
    >
      <List.Item
        id="new-chat"
        title={state.pending ? "Check previous attempt" : "New conversation"}
        icon={Icon.Message}
        detail={
          <List.Item.Detail
            markdown={[
              status
                ? `> **Needs attention**\n>\n${status
                    .split("\n")
                    .map((line) => `> ${line}`)
                    .join("\n")}`
                : "",
              "## New conversation",
              context
                ? `**${context.agent?.label ?? context.backend}** · ${context.target?.name ?? "Local server"}\n\n${context.cwd}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n")}
          />
        }
        actions={
          <ActionPanel>
            {state.draft.trim() && controller.canSend() && (
              <Action title="Send Message" icon={Icon.ArrowUp} onAction={() => controller.send()} />
            )}
            {actions({ setActive: () => undefined, browser: true })}
          </ActionPanel>
        }
      />
    </List>
  );
}

function QuickChatActions({
  controller,
  connection,
  refreshConnections,
  setActive,
  browser,
}: {
  controller: QuickChatController;
  connection: FeedConnection;
  refreshConnections: () => Promise<void>;
  setActive: (active: boolean) => void;
  browser: boolean;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const metadata = state.metadata;
  const url = state.session ? sessionUrl(connection.frontendUrl, state.session.id) : connection.frontendUrl;
  const end = async (kind: "terminate" | "delete") => {
    const session = state.session;
    if (!session) return;
    const live = session.status !== "exited";
    const deleting = kind === "delete";
    if (
      !(await confirmAlert({
        title: !deleting
          ? "Terminate this session?"
          : live
            ? "Terminate and delete this session?"
            : "Delete this session?",
        message: `${deleting ? deleteMessage(session, live) : terminateMessage} ${quickChatMovesOn}`,
        primaryAction: { title: deleting ? "Delete" : "Terminate", style: Alert.ActionStyle.Destructive },
      }))
    )
      return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: deleting ? "Deleting session…" : "Terminating session…",
    });
    const result = deleting ? await controller.terminateAndDelete() : await controller.terminate();
    if (!result) return toast.hide();
    const kept = "Your draft is kept.";
    Object.assign(
      toast,
      !result.ended
        ? {
            style: Toast.Style.Failure,
            title: deleting ? "Couldn't delete session" : "Couldn't terminate session",
            message: result.message,
          }
        : result.outcome === "partial"
          ? {
              style: Toast.Style.Failure,
              title: "Session terminated but not deleted",
              message: "Delete it from Browse Sessions.",
            }
          : result.outcome === "unconfirmed"
            ? { style: Toast.Style.Failure, title: "Quick Chat moved to a new chat", message: result.message }
            : { style: Toast.Style.Success, title: deleting ? "Session deleted" : "Session terminated", message: kept },
    );
  };
  return (
    <>
      {metadata && <ComposeActions controller={controller} metadata={metadata} />}
      {metadata && <TargetActions controller={controller} metadata={metadata} />}
      <CheckpointActions controller={controller} />
      {metadata && state.defaults && !state.busy && !state.pending && (
        <Action.Push
          title="New Session with Settings"
          icon={Icon.PlusCircle}
          shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
          onPush={() => setActive(false)}
          onPop={() => setActive(true)}
          target={
            <NewSessionSettings
              connection={connection}
              metadata={metadata}
              defaults={state.defaults}
              controller={controller}
            />
          }
        />
      )}
      {metadata && state.defaults && (
        <Action.Push
          title="Quick Chat Defaults"
          icon={Icon.Gear}
          shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
          onPush={() => setActive(false)}
          onPop={() => setActive(true)}
          target={
            <QuickChatDefaults
              connection={connection}
              metadata={metadata}
              defaults={state.defaults}
              onSaved={() => controller.start()}
            />
          }
        />
      )}
      <Action
        title="Start New Chat"
        icon={Icon.Plus}
        shortcut={Keyboard.Shortcut.Common.New}
        onAction={() => controller.newChat()}
      />
      <Action
        title="Reconnect Chat"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
        onAction={() => controller.start()}
      />
      {state.session && (
        <Action
          title="Interrupt Session"
          icon={Icon.Stop}
          shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
          onAction={() => controller.action("interrupt")}
        />
      )}
      {metadata && <SessionReattachAction controller={controller} metadata={metadata} />}
      {state.session && state.session.status !== "exited" && !state.busy && !state.pending && (
        <Action
          title="Terminate Session"
          icon={Icon.XMarkCircle}
          style={Action.Style.Destructive}
          shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
          onAction={() => end("terminate")}
        />
      )}
      {state.session && !state.busy && !state.pending && (
        <Action
          title={state.session.status === "exited" ? "Delete Session" : "Terminate and Delete Session"}
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={Keyboard.Shortcut.Common.Remove}
          onAction={() => end("delete")}
        />
      )}
      <Action.Push
        title="Sign in Again"
        icon={Icon.Lock}
        target={<SignInForm connection={connection} onSaved={refreshConnections} />}
        onPush={() => setActive(false)}
        onPop={() => {
          setActive(true);
          void refreshConnections();
          void controller.syncPending();
        }}
      />
      {browser && url && <Action.OpenInBrowser title="Open in Waypoint" url={url} />}
      <Action.Push
        title="Manage Servers"
        icon={Icon.Network}
        target={<ManageServers />}
        onPush={() => setActive(false)}
        onPop={() => {
          setActive(true);
          void refreshConnections();
          void controller.syncPending();
        }}
      />
    </>
  );
}
