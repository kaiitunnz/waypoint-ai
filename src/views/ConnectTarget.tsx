import { Action, ActionPanel, Form, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import { useState } from "react";
import { ExecutionTarget } from "../api/contracts";

export function ConnectTarget({
  target,
  connect,
  submitTitle = "Connect",
}: {
  target?: ExecutionTarget;
  connect: (password: string) => Promise<{ connected: boolean; detail?: string }>;
  submitTitle?: string;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { pop } = useNavigation();
  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await connect(password);
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
          {target && <Action.SubmitForm title={submitTitle} icon={Icon.Lock} onSubmit={submit} />}
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
