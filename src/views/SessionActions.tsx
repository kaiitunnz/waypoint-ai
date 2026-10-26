import {
  Action,
  ActionPanel,
  Alert,
  Form,
  Icon,
  Keyboard,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import { deleteMessage, sessionActions, terminateMessage, titleProblem } from "../domain/sessionActions";
import { ManageOutcome, SessionManager } from "../hooks/sessionManager";
import { ConnectTarget } from "./ConnectTarget";

export interface SessionActionHandlers {
  onChanged: (session: Session) => void;
  onDeleted: (id: string) => void;
  openQuickChat: () => void;
  // Offered on the success toast, such as revealing a terminated session the list now hides.
  afterTerminate?: Toast.ActionOptions;
}

// `titles` names the outcome: what was done, and what couldn't be.
export async function reportOutcome(
  outcome: ManageOutcome,
  titles: [string, string],
  handlers: Pick<SessionActionHandlers, "onChanged" | "onDeleted">,
  toast?: Toast,
  primaryAction?: Toast.ActionOptions,
): Promise<boolean> {
  const show = (style: Toast.Style, title: string, message?: string, action?: Toast.ActionOptions) =>
    toast
      ? Object.assign(toast, { style, title, message, primaryAction: action })
      : showToast({ style, title, message, primaryAction: action });
  if (outcome.kind === "done") {
    if (outcome.deleted) handlers.onDeleted(outcome.deleted);
    else if (outcome.session) handlers.onChanged(outcome.session);
    await show(Toast.Style.Success, titles[0], undefined, primaryAction);
    return true;
  }
  if (outcome.kind !== "ssh" && outcome.session) handlers.onChanged(outcome.session);
  await show(Toast.Style.Failure, outcome.kind === "stale" ? "Nothing changed" : titles[1], outcome.message);
  return false;
}

export function SessionActions({
  session,
  metadata,
  quickChat,
  manager,
  handlers,
}: {
  session: Session;
  metadata?: ServerMetadata;
  quickChat: { pointer?: string; pending: boolean };
  manager: SessionManager;
  handlers: SessionActionHandlers;
}) {
  const { push } = useNavigation();
  const allowed = sessionActions(session, metadata, quickChat);
  const run = async (
    progress: string,
    titles: [string, string],
    operation: () => Promise<ManageOutcome>,
    primaryAction?: Toast.ActionOptions,
  ) => {
    const toast = await showToast({ style: Toast.Style.Animated, title: progress });
    return reportOutcome(await operation(), titles, handlers, toast, primaryAction);
  };
  const reattach = async () => {
    if (!metadata) return;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Reattaching session…" });
    const outcome = await manager.reattach(session.id, metadata);
    if (outcome.kind !== "ssh")
      return reportOutcome(outcome, ["Session reattached", "Couldn't reattach session"], handlers, toast);
    toast.hide();
    let connected = false;
    // Reattaching after the form closes lets its outcome toast follow the form's own.
    push(
      <ConnectTarget
        target={metadata.targets.find((target) => target.id === outcome.targetId)}
        connect={async (password) => {
          const result = await manager.connectTarget(outcome.targetId, password);
          connected = result.connected;
          return result;
        }}
        submitTitle="Connect and Reattach"
      />,
      () => {
        if (connected) void reattach();
      },
    );
  };
  return (
    <ActionPanel.Section title="Session">
      {/* Rename leads because it only opens a form, so a row's secondary action never changes the session. */}
      {allowed.rename && (
        <Action.Push
          title="Rename Session"
          icon={Icon.Pencil}
          shortcut={Keyboard.Shortcut.Common.Edit}
          target={<RenameSession session={session} metadata={metadata} manager={manager} handlers={handlers} />}
        />
      )}
      {allowed.useForQuickChat && metadata && (
        <Action
          title="Use for Quick Chat"
          icon={Icon.Message}
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "u" },
            Windows: { modifiers: ["ctrl", "shift"], key: "u" },
          }}
          onAction={async () => {
            if (
              await run("Choosing for Quick Chat…", ["Quick Chat destination set", "Couldn't use for Quick Chat"], () =>
                manager.useForQuickChat(session.id, metadata),
              )
            )
              handlers.openQuickChat();
          }}
        />
      )}
      {allowed.openInQuickChat && (
        <Action
          title="Open in Quick Chat"
          icon={Icon.Message}
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "u" },
            Windows: { modifiers: ["ctrl", "shift"], key: "u" },
          }}
          onAction={handlers.openQuickChat}
        />
      )}
      {(allowed.pin || allowed.unpin) && (
        <Action
          title={allowed.pin ? "Pin Session" : "Unpin Session"}
          icon={allowed.pin ? Icon.Pin : Icon.PinDisabled}
          shortcut={Keyboard.Shortcut.Common.Pin}
          onAction={() =>
            run(
              allowed.pin ? "Pinning session…" : "Unpinning session…",
              allowed.pin ? ["Session pinned", "Couldn't pin session"] : ["Session unpinned", "Couldn't unpin session"],
              () => manager.setPinned(session.id, allowed.pin, metadata),
            )
          }
        />
      )}
      {allowed.interrupt && metadata && (
        <Action
          title="Interrupt Session"
          icon={Icon.Stop}
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "i" },
            Windows: { modifiers: ["ctrl", "shift"], key: "i" },
          }}
          onAction={() =>
            run("Interrupting session…", ["Session interrupted", "Couldn't interrupt session"], () =>
              manager.interrupt(session.id, metadata),
            )
          }
        />
      )}
      {allowed.reattach && metadata && (
        <Action
          title="Reattach Session"
          icon={Icon.Link}
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "t" },
            Windows: { modifiers: ["ctrl", "shift"], key: "t" },
          }}
          onAction={reattach}
        />
      )}
      {allowed.terminate && (
        <Action
          title="Terminate Session"
          icon={Icon.XMarkCircle}
          style={Action.Style.Destructive}
          onAction={async () => {
            if (
              await confirmAlert({
                title: "Terminate this session?",
                message: terminateMessage,
                primaryAction: { title: "Terminate", style: Alert.ActionStyle.Destructive },
              })
            )
              await run(
                "Terminating session…",
                ["Session terminated", "Couldn't terminate session"],
                () => manager.terminate(session.id, metadata),
                handlers.afterTerminate,
              );
          }}
        />
      )}
      {allowed.delete && (
        <Action
          title="Delete Session"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={Keyboard.Shortcut.Common.Remove}
          onAction={async () => {
            if (
              await confirmAlert({
                title: "Delete this session?",
                message: deleteMessage(session),
                primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
              })
            )
              await run("Deleting session…", ["Session deleted", "Couldn't delete session"], () =>
                manager.remove(session.id, metadata),
              );
          }}
        />
      )}
    </ActionPanel.Section>
  );
}

function RenameSession({
  session,
  metadata,
  manager,
  handlers,
}: {
  session: Session;
  metadata?: ServerMetadata;
  manager: SessionManager;
  handlers: Pick<SessionActionHandlers, "onChanged" | "onDeleted">;
}) {
  const { pop } = useNavigation();
  const [title, setTitle] = useState(session.title);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  return (
    <Form
      navigationTitle="Rename Session"
      isLoading={saving}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Rename Session"
            icon={Icon.Pencil}
            onSubmit={async () => {
              const problem = titleProblem(title);
              if (problem) return setError(problem);
              if (saving) return;
              setSaving(true);
              const toast = await showToast({ style: Toast.Style.Animated, title: "Renaming session…" });
              const outcome = await manager.rename(session.id, title, metadata);
              setSaving(false);
              if (await reportOutcome(outcome, ["Session renamed", "Couldn't rename session"], handlers, toast)) pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Title"
        value={title}
        error={error}
        onChange={(value) => {
          setTitle(value);
          setError(undefined);
        }}
      />
    </Form>
  );
}
