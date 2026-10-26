import {
  Action,
  ActionPanel,
  Alert,
  Icon,
  Keyboard,
  List,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useState, useSyncExternalStore } from "react";
import { useConnections } from "../hooks/useConnections";
import { useQuickChat } from "../hooks/useQuickChat";
import { FeedConnection } from "../hooks/sessionFeeds";
import { connectionStore } from "../storage/raycast";
import { canReattach, launchContext, resumeFor } from "../domain/quickChat";
import { sessionUrl } from "../domain/sessions";
import { ChatConversation } from "./ChatConversation";
import { QuickChatController } from "../hooks/quickChatController";
import { QuickChatDefaults } from "./QuickChatDefaults";
import { ComposeMessage, includeContext } from "./ComposeMessage";
import { ConnectTarget } from "./ConnectTarget";
import { ContextKind } from "../domain/compose";
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
        <List.Item
          id="prepared-chat"
          title={
            error ? "Saved servers need attention" : connection ? "Sign in to start chatting" : "Connect to Waypoint"
          }
          subtitle={error ?? "Choose a server and sign in using Manage Servers."}
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
  const { state, controller } = useQuickChat(connection, forceNew, resume);
  const metadata = state.metadata;
  const actions = (setActive: (value: boolean) => void = () => undefined) => (
    <QuickChatActions
      controller={controller}
      connection={connection}
      refreshConnections={refreshConnections}
      setActive={setActive}
    />
  );
  if (state.loading && !state.session) return <LoadingView title="Preparing your chat…" />;
  // The conversation's own Needs Attention section covers a checkpoint for one of its requests.
  const ownInteraction = state.pending?.kind === "interaction" && state.pending.sessionId === state.session?.id;
  const status =
    state.error || (state.pending && !ownInteraction ? state.notice || "Previous attempt unconfirmed." : undefined);
  if (metadata)
    return (
      <ChatConversation
        connection={connection}
        sessionId={state.session?.id}
        metadata={metadata}
        emptyMarkdown={
          state.defaults
            ? `## New conversation\n\n**${launchContext(state.defaults, metadata).agent?.label ?? "Waypoint"}** · ${launchContext(state.defaults, metadata).target?.name ?? "Local server"}\n\n${launchContext(state.defaults, metadata).cwd}`
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
        hasDraft={state.hasDraft}
        settings={{
          available: !state.busy && !state.pending,
          newChat: state.defaults
            ? { start: (build) => controller.startNewChatWith(build(state.defaults!)) }
            : undefined,
        }}
      />
    );
  const context = metadata && state.defaults ? launchContext(state.defaults, metadata) : undefined;
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
            {actions()}
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
}: {
  controller: QuickChatController;
  connection: FeedConnection;
  refreshConnections: () => Promise<void>;
  setActive: (active: boolean) => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const metadata = state.metadata;
  const url = state.session ? sessionUrl(connection.frontendUrl, state.session.id) : connection.frontendUrl;
  const interaction = state.pending?.kind === "interaction";
  const { push } = useNavigation();
  const compose = metadata && <ComposeMessage controller={controller} metadata={metadata} />;
  const include = async (kind: ContextKind) => {
    if (compose && (await includeContext(controller, kind))) push(compose);
  };
  return (
    <>
      {compose && (
        <ActionPanel.Section>
          <Action.Push
            title="Compose Message"
            icon={Icon.Pencil}
            shortcut={{
              macOS: { modifiers: ["cmd", "shift"], key: "m" },
              Windows: { modifiers: ["ctrl", "shift"], key: "m" },
            }}
            target={compose}
          />
          {!state.busy && (
            <>
              <Action
                title="Include Selected Text"
                icon={Icon.Text}
                shortcut={{
                  macOS: { modifiers: ["cmd", "shift"], key: "e" },
                  Windows: { modifiers: ["ctrl", "shift"], key: "e" },
                }}
                onAction={() => include("selection")}
              />
              <Action
                title="Include Clipboard"
                icon={Icon.Clipboard}
                shortcut={{
                  macOS: { modifiers: ["cmd", "shift"], key: "v" },
                  Windows: { modifiers: ["ctrl", "shift"], key: "v" },
                }}
                onAction={() => include("clipboard")}
              />
            </>
          )}
        </ActionPanel.Section>
      )}
      {state.sshTarget && metadata && (
        <Action.Push
          title="Connect SSH Target"
          icon={Icon.Lock}
          target={
            <ConnectTarget
              target={metadata.targets.find((entry) => entry.id === state.sshTarget)}
              connect={(password) => controller.connectTarget(password)}
              submitTitle="Connect and Retry"
            />
          }
        />
      )}
      {interaction && state.pending?.sessionId !== state.session?.id && (
        <>
          <Action
            title="Check Previous Outcome"
            icon={Icon.MagnifyingGlass}
            shortcut={Keyboard.Shortcut.Common.OpenWith}
            onAction={() => controller.reconcile()}
          />
          <Action
            title="Clear Unconfirmed Response"
            icon={Icon.ArrowClockwise}
            onAction={async () => {
              if (
                await confirmAlert({
                  title: "Clear the unconfirmed response?",
                  message:
                    "It may already have reached the agent. Responding again can repeat its effect. Nothing is resent automatically.",
                  primaryAction: { title: "Clear", style: Alert.ActionStyle.Destructive },
                })
              )
                await controller.abandonPending();
            }}
          />
        </>
      )}
      {state.pending && !interaction && (
        <>
          <Action
            title="Check Previous Outcome"
            icon={Icon.MagnifyingGlass}
            shortcut={Keyboard.Shortcut.Common.OpenWith}
            onAction={() => controller.reconcile()}
          />
          <Action
            title="Allow Explicit Retry"
            shortcut={{
              macOS: { modifiers: ["cmd", "shift"], key: "y" },
              Windows: { modifiers: ["ctrl", "shift"], key: "y" },
            }}
            icon={Icon.ArrowClockwise}
            onAction={async () => {
              if (
                await confirmAlert({
                  title: "Allow another attempt?",
                  message:
                    "The previous operation may already have reached Waypoint. A new attempt can create another session or duplicate a message. Check the outcome first. Nothing is resent until you press Send.",
                  primaryAction: { title: "Check and Allow Retry", style: Alert.ActionStyle.Destructive },
                })
              )
                await controller.allowRetry();
            }}
          />
          <Action
            title="Abandon Attempt and Start New Chat"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            onAction={async () => {
              if (
                await confirmAlert({
                  title: "Abandon this attempt?",
                  message:
                    "It may already have reached Waypoint. A new chat can duplicate work. Existing sessions keep running.",
                  primaryAction: { title: "Abandon and Start New", style: Alert.ActionStyle.Destructive },
                })
              )
                await controller.abandonPending();
            }}
          />
        </>
      )}
      {metadata && state.defaults && (
        <Action.Push
          title="Quick Chat Defaults"
          icon={Icon.Gear}
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "d" },
            Windows: { modifiers: ["ctrl", "shift"], key: "d" },
          }}
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
        shortcut={{
          macOS: { modifiers: ["cmd", "shift"], key: "r" },
          Windows: { modifiers: ["ctrl", "shift"], key: "r" },
        }}
        onAction={() => controller.start()}
      />
      {state.session && (
        <Action
          title="Interrupt Session"
          icon={Icon.Stop}
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "i" },
            Windows: { modifiers: ["ctrl", "shift"], key: "i" },
          }}
          onAction={() => controller.action("interrupt")}
        />
      )}
      {state.session &&
        metadata &&
        ["exited", "error"].includes(state.session.status) &&
        canReattach(state.session, metadata) && (
          <Action
            title="Reattach Session"
            icon={Icon.Link}
            shortcut={{
              macOS: { modifiers: ["cmd", "shift"], key: "t" },
              Windows: { modifiers: ["ctrl", "shift"], key: "t" },
            }}
            onAction={() => controller.action("reattach")}
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
        }}
      />
      {url && <Action.OpenInBrowser title="Open in Waypoint" url={url} />}
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
}
