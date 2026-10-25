import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Form,
  Icon,
  Keyboard,
  Toast,
  confirmAlert,
  getSelectedText,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ServerMetadata } from "../api/contracts";
import { ContextKind, attachmentPolicy, contextTitle, formatBytes } from "../domain/compose";
import { QuickChatController } from "../hooks/quickChatController";
import { ConnectTarget } from "./ConnectTarget";

const preview = (text: string) => {
  const lines = text.trim().split("\n");
  const shown = lines.slice(0, 3).join("\n");
  return lines.length > 3 ? `${shown}\n…` : shown;
};

// Reads the selection or clipboard once, on an explicit action, and stages it for review.
export async function includeContext(controller: QuickChatController, kind: ContextKind): Promise<boolean> {
  let text: string | undefined;
  try {
    text = kind === "selection" ? await getSelectedText() : await Clipboard.readText();
  } catch {
    text = undefined;
  }
  if (!text?.trim()) {
    await showToast({
      style: Toast.Style.Failure,
      title: kind === "selection" ? "No selected text" : "The clipboard has no text",
    });
    return false;
  }
  await controller.stageContext(kind, text);
  return !controller.getSnapshot().error;
}

export function ComposeMessage({
  controller,
  metadata,
}: {
  controller: QuickChatController;
  metadata: ServerMetadata;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { pop } = useNavigation();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void controller.openCompose();
    return () => {
      mounted.current = false;
    };
  }, [controller]);
  const draft = state.compose;
  const session = state.session;
  const agentId = session?.backend ?? (state.defaults ? state.defaults.agent || metadata.defaultAgent : "");
  const agent = metadata.agents.find((entry) => entry.id === agentId);
  const targetId = session ? session.targetId : state.defaults?.target || undefined;
  const policy = attachmentPolicy(
    agentId,
    agent?.attachments === true,
    !!targetId && metadata.targets.some((target) => target.id === targetId),
  );
  const canAttach = policy.images || policy.files;
  const ready = !state.busy && !state.loading && !state.pending;
  const send = async () => {
    if ((await controller.send(true)) && mounted.current) pop();
  };
  const include = async (kind: ContextKind) => {
    await includeContext(controller, kind);
  };
  const destination = session
    ? `${session.title || "Conversation"} · ${agent?.label ?? session.backend}`
    : `New conversation · ${agent?.label ?? "Waypoint"}`;
  const elsewhere = draft.files.some((file) => file.upload && file.upload.sessionId !== session?.id);
  const uploaded =
    !!session && draft.files.length > 0 && draft.files.every((file) => file.upload?.sessionId === session.id);
  return (
    <Form
      navigationTitle="Compose Message"
      isLoading={state.busy || state.loading}
      actions={
        <ActionPanel>
          {ready && <Action.SubmitForm title="Send Message" icon={Icon.ArrowUp} onSubmit={send} />}
          {state.sshTarget && (
            <Action.Push
              title="Connect SSH Target"
              icon={Icon.Lock}
              target={<ConnectTarget controller={controller} metadata={metadata} />}
            />
          )}
          {!state.busy && (
            <ActionPanel.Section>
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
            </ActionPanel.Section>
          )}
          {!state.busy && draft.context.length > 0 && (
            <ActionPanel.Section title="Remove Context">
              {draft.context.map((item, index) => (
                <Action
                  key={item.id}
                  title={`Remove ${contextTitle(item.kind)}${draft.context.length > 1 ? ` ${index + 1}` : ""}`}
                  icon={Icon.MinusCircle}
                  onAction={() => controller.removeContext(item.id)}
                />
              ))}
            </ActionPanel.Section>
          )}
          {!state.busy && (
            <Action
              title="Discard Draft"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.RemoveAll}
              onAction={async () => {
                if (
                  await confirmAlert({
                    title: "Discard this draft?",
                    message: "Its text, context, and uploaded files are removed.",
                    primaryAction: { title: "Discard", style: Alert.ActionStyle.Destructive },
                  })
                ) {
                  await controller.discardCompose();
                  if (mounted.current) pop();
                }
              }}
            />
          )}
        </ActionPanel>
      }
    >
      <Form.Description title="To" text={destination} />
      {state.upload && <Form.Description title="Sending" text={state.upload} />}
      {state.error && <Form.Description title="Needs attention" text={state.error} />}
      {state.pending && (
        <Form.Description
          title="Unconfirmed"
          text="An earlier operation is unconfirmed. Check it in Quick Chat first."
        />
      )}
      <Form.TextArea
        id="message"
        title="Message"
        placeholder="Write a message"
        value={draft.text}
        onChange={(text) => void controller.changeCompose({ text })}
      />
      {draft.context.map((item) => (
        <Form.Description key={item.id} title={contextTitle(item.kind)} text={preview(item.text)} />
      ))}
      {canAttach ? (
        <Form.FilePicker
          id="files"
          title="Files"
          value={draft.files.map((file) => file.path)}
          onChange={async (paths) => {
            if (state.busy) return;
            // Picking again replaces the picker's selection, so a pick only adds; removal is a pure subset.
            const added = paths.filter((path) => !draft.files.some((file) => file.path === path));
            if (!added.length) {
              const removed = draft.files.filter((file) => !paths.includes(file.path)).map((file) => file.id);
              if (removed.length) await controller.removeFiles(removed);
              return;
            }
            const problems = await controller.addFiles(added);
            if (problems.length)
              await showToast({
                style: Toast.Style.Failure,
                title: "Some files were not added",
                message: problems.join("\n"),
              });
          }}
          info={policy.reason}
        />
      ) : (
        <Form.Description title="Files" text={policy.reason ?? "Attachments are not available."} />
      )}
      {draft.files.length > 0 && (
        <Form.Description
          title=""
          text={[
            `${draft.files.length} ${draft.files.length === 1 ? "file" : "files"} · ${formatBytes(draft.files.reduce((total, file) => total + file.size, 0))}`,
            elsewhere ? "Will upload again for this conversation" : uploaded ? "Uploaded" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      )}
    </Form>
  );
}
