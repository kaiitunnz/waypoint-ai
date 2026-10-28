import { Action, ActionPanel, Alert, Icon, Keyboard, confirmAlert, useNavigation } from "@raycast/api";
import { useSyncExternalStore } from "react";
import { ServerMetadata } from "../api/contracts";
import { ContextKind } from "../domain/compose";
import { checkpointOffer, sessionActions } from "../domain/sessionActions";
import { QuickChatController } from "../hooks/quickChatController";
import { ComposeMessage, includeContext } from "./ComposeMessage";
import { ConnectTarget } from "./ConnectTarget";

const useChat = (controller: QuickChatController) => useSyncExternalStore(controller.subscribe, controller.getSnapshot);

export function ComposeActions({
  controller,
  metadata,
}: {
  controller: QuickChatController;
  metadata: ServerMetadata;
}) {
  const state = useChat(controller);
  const { push } = useNavigation();
  const compose = <ComposeMessage controller={controller} metadata={metadata} />;
  const include = async (kind: ContextKind) => {
    if (await includeContext(controller, kind)) push(compose);
  };
  return (
    <ActionPanel.Section>
      <Action.Push
        title="Compose Message"
        icon={Icon.Pencil}
        shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
        target={compose}
      />
      {!state.busy && (
        <>
          <Action
            title="Include Selected Text"
            icon={Icon.Text}
            shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
            onAction={() => include("selection")}
          />
          <Action
            title="Include Clipboard"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
            onAction={() => include("clipboard")}
          />
        </>
      )}
    </ActionPanel.Section>
  );
}

export function TargetActions({ controller, metadata }: { controller: QuickChatController; metadata: ServerMetadata }) {
  const state = useChat(controller);
  if (!state.sshTarget) return null;
  return (
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
  );
}

// `sessionChat` is a chat bound to one session, which never starts a new chat.
export function CheckpointActions({
  controller,
  sessionChat = false,
}: {
  controller: QuickChatController;
  sessionChat?: boolean;
}) {
  const state = useChat(controller);
  const offer = checkpointOffer(state.pending, state.pendingOwned, state.session?.id);
  if (offer === "none") return null;
  const check = (
    <Action
      title="Check Previous Outcome"
      icon={Icon.MagnifyingGlass}
      shortcut={Keyboard.Shortcut.Common.OpenWith}
      onAction={() => controller.reconcile()}
    />
  );
  if (offer === "response")
    return (
      <>
        {check}
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
    );
  const clear = (
    <Action
      title="Clear Unconfirmed Attempt"
      icon={Icon.ArrowClockwise}
      onAction={async () => {
        if (
          await confirmAlert({
            title: "Clear the unconfirmed attempt?",
            message:
              "It may already have reached Waypoint. Sending again can duplicate it. Nothing is resent automatically.",
            primaryAction: { title: "Clear", style: Alert.ActionStyle.Destructive },
          })
        )
          await controller.abandonPending();
      }}
    />
  );
  if (offer === "elsewhere")
    return (
      <>
        {check}
        {clear}
      </>
    );
  return (
    <>
      {check}
      <Action
        title="Allow Explicit Retry"
        shortcut={{ modifiers: ["cmd", "shift"], key: "y" }}
        icon={Icon.ArrowClockwise}
        onAction={async () => {
          if (
            await confirmAlert({
              title: "Allow another attempt?",
              message: state.pending?.origin
                ? "The new session may already have been created. Another attempt can create a second one. Check the outcome first, then start the session again from the form you used."
                : sessionChat
                  ? "The previous operation may already have reached Waypoint. Another attempt can duplicate a message. Check the outcome first. Nothing is resent until you press Send."
                  : "The previous operation may already have reached Waypoint. A new attempt can create another session or duplicate a message. Check the outcome first. Nothing is resent until you press Send.",
              primaryAction: { title: "Check and Allow Retry", style: Alert.ActionStyle.Destructive },
            })
          )
            await controller.allowRetry();
        }}
      />
      {sessionChat ? (
        clear
      ) : (
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
      )}
    </>
  );
}

// Reattaches under the server lock with a checkpoint, so an unanswered request blocks a duplicate. Offered only while
// nothing is unsettled, since the chat refuses otherwise.
export function SessionReattachAction({
  controller,
  metadata,
}: {
  controller: QuickChatController;
  metadata: ServerMetadata;
}) {
  const state = useChat(controller);
  if (!state.session || !sessionActions(state.session, metadata, { pending: false }).reattach) return null;
  return (
    <Action
      title="Reattach Session"
      icon={Icon.Link}
      shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
      onAction={() => controller.action("reattach")}
    />
  );
}
