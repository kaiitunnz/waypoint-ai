import { Action, ActionPanel, Form, Icon, Keyboard, Toast, showToast, useNavigation } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { ServerMetadata } from "../api/contracts";
import { ChatDefaults, ChatLaunchFields, createRequest } from "../domain/quickChat";
import { QuickChatController } from "../hooks/quickChatController";
import { FeedConnection } from "../hooks/sessionFeeds";
import { draftKeys } from "../storage/drafts";
import { restoreLaunchDraft } from "../storage/quickChat";
import { quickChatStore } from "../storage/raycast";
import { ConnectTarget } from "./ConnectTarget";
import { useLaunchFields } from "./LaunchFields";

function launchFields(values: ChatDefaults): ChatLaunchFields {
  const settings: Partial<ChatDefaults> = { ...values };
  delete settings.mode;
  delete settings.timeoutMinutes;
  return settings as ChatLaunchFields;
}

// Starts a session from settings chosen here, without a message. The form starts from Quick Chat Defaults and keeps
// its values per server until a session starts or the draft is discarded.
type FormProps = {
  connection: FeedConnection;
  metadata: ServerMetadata;
  defaults: ChatDefaults;
  controller: QuickChatController;
};

export function NewSessionSettings(props: FormProps) {
  const [initial, setInitial] = useState<ChatDefaults>();
  useEffect(() => {
    let current = true;
    void quickChatStore.drafts.read(draftKeys.launch(props.connection.id)).then(
      (raw) => {
        if (current) setInitial(restoreLaunchDraft(props.defaults, raw));
      },
      () => {
        if (current) setInitial(props.defaults);
      },
    );
    return () => {
      current = false;
    };
  }, [props.connection.id]);
  // The fields mount once the draft is read, so the advanced section opens for a draft that uses it.
  return initial ? (
    <SettingsForm {...props} initial={initial} />
  ) : (
    <Form navigationTitle="New Session with Settings" isLoading />
  );
}

function SettingsForm({ connection, metadata, defaults, controller, initial }: FormProps & { initial: ChatDefaults }) {
  const key = draftKeys.launch(connection.id);
  const [values, setValues] = useState(initial);
  const [problem, setProblem] = useState<string>();
  const [connectTarget, setConnectTarget] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  // Set by an edit, so the draft is written only for values the user changed.
  const edited = useRef(false);
  const { pop } = useNavigation();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (edited.current)
      void quickChatStore.drafts.write(key, JSON.stringify(launchFields(values))).catch(() => undefined);
  }, [values]);
  const update = (change: (current: ChatDefaults) => ChatDefaults) => {
    setProblem(undefined);
    edited.current = true;
    setValues(change);
  };
  const launch = useLaunchFields(connection, metadata, values, update, defaults.model);
  async function start() {
    if (busy) return;
    const invalid = launch.problem();
    if (invalid) return setProblem(invalid);
    try {
      createRequest(values, metadata, "check", "check", { workspace: launch.workspace, source: "form" });
    } catch (error) {
      return setProblem(error instanceof Error ? error.message : "Check these settings.");
    }
    setBusy(true);
    setConnectTarget(undefined);
    try {
      const result = await controller.createSession(values, "launch-form");
      if (!mounted.current) return;
      if (result.kind === "created" || result.kind === "uncertain") {
        if (result.kind === "uncertain")
          await showToast({ style: Toast.Style.Failure, title: "New session unconfirmed", message: result.message });
        pop();
        return;
      }
      if (result.kind === "ssh") setConnectTarget(result.targetId);
      setProblem(result.message);
    } catch (error) {
      if (mounted.current) setProblem(error instanceof Error ? error.message : "Could not start the session.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Form
      navigationTitle="New Session with Settings"
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Session" icon={Icon.Play} onSubmit={start} />
          {connectTarget && (
            <Action.Push
              title="Connect SSH Target"
              icon={Icon.Lock}
              target={
                <ConnectTarget
                  target={metadata.targets.find((entry) => entry.id === connectTarget)}
                  connect={async (password) => {
                    const result = await controller.connectTargetOnly(connectTarget, password);
                    if (result.connected && mounted.current) {
                      setConnectTarget(undefined);
                      setProblem(undefined);
                    }
                    return result;
                  }}
                />
              }
            />
          )}
          {launch.modelError && (
            <Action
              title="Reload Models"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={launch.reloadModels}
            />
          )}
          <Action
            title="Discard Draft"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={Keyboard.Shortcut.Common.RemoveAll}
            onAction={() => {
              setProblem(undefined);
              edited.current = false;
              setValues(defaults);
              void quickChatStore.drafts.write(key, "").catch(() => undefined);
            }}
          />
        </ActionPanel>
      }
    >
      {launch.fields}
      {problem && <Form.Description title="Needs attention" text={problem} />}
    </Form>
  );
}
