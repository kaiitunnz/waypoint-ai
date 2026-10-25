import { Action, ActionPanel, Form, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import { useState, useSyncExternalStore } from "react";
import { ServerMetadata } from "../api/contracts";
import { QuickChatController } from "../hooks/quickChatController";

export function ConnectTarget({ controller, metadata }: { controller: QuickChatController; metadata: ServerMetadata }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const target = metadata.targets.find((entry) => entry.id === state.sshTarget);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { pop } = useNavigation();
  const connect = async () => {
    if (!password || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await controller.connectTarget(password);
      if (!result.connected) {
        setProblem(result.detail?.trim() || "The target rejected the password.");
        return;
      }
      setPassword("");
      await showToast({ style: Toast.Style.Success, title: `Connected ${target?.name ?? "target"}` });
      pop();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not connect the target.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Form
      navigationTitle={`Connect ${target?.name ?? "SSH Target"}`}
      isLoading={busy}
      actions={
        <ActionPanel>
          {target && <Action.SubmitForm title="Connect and Retry" icon={Icon.Lock} onSubmit={connect} />}
        </ActionPanel>
      }
    >
      <Form.Description
        title="Target"
        text={
          target
            ? `${target.name} needs its SSH password. Waypoint uses it once to connect and doesn't save it.`
            : "No target needs a connection."
        }
      />
      {problem && <Form.Description title="Not connected" text={problem} />}
      {target && (
        <Form.PasswordField id="password" title="Password" value={password} onChange={setPassword} autoFocus />
      )}
    </Form>
  );
}
