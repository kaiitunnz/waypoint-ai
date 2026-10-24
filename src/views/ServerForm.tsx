import { Action, ActionPanel, Form, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import { useState, useRef } from "react";
import { Connection, normalizeConnection } from "../domain/connections";
import { connectionStore } from "../storage/raycast";
import { useServerSignIn } from "../hooks/useServerSignIn";

export function ServerForm({ connection, onSaved }: { connection?: Connection; onSaved: () => Promise<void> }) {
  const { pop } = useNavigation();
  const [name, setName] = useState(connection?.name ?? "");
  const [apiUrl, setApiUrl] = useState(connection?.apiUrl ?? "");
  const [frontendUrl, setFrontendUrl] = useState(connection?.frontendUrl ?? "");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);

  async function submit() {
    if (busy.current) return;
    let normalized;
    try {
      normalized = normalizeConnection({ name, apiUrl, frontendUrl });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Check the server details.");
      return;
    }
    busy.current = true;
    setLoading(true);
    try {
      await connectionStore.save(normalized, connection?.id);
      await onSaved();
      await showToast({
        style: Toast.Style.Success,
        title: "Server saved",
        message: "Sign in to check its available agents and targets.",
      });
      pop();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save this server. Retry.");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }

  return (
    <Form
      navigationTitle={connection ? "Edit Server" : "Add Server"}
      isLoading={loading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Server" icon={Icon.Checkmark} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Connection"
        text="Connect Raycast to a Waypoint API. Execution targets belong to that server and are discovered after sign-in."
      />
      <Form.TextField id="name" title="Name" placeholder="Personal, Work, or Lab" value={name} onChange={setName} />
      <Form.TextField
        id="apiUrl"
        title="API URL"
        placeholder="https://waypoint.example.com"
        value={apiUrl}
        onChange={(value) => {
          setApiUrl(value);
          setError(undefined);
        }}
      />
      <Form.TextField
        id="frontendUrl"
        title="Frontend URL"
        placeholder="Optional browser address"
        info="Used for Open in Waypoint. It can differ from your API URL."
        value={frontendUrl}
        onChange={setFrontendUrl}
      />
      {connection && (
        <Form.Description
          title="API Changes"
          text="Changing the API URL creates a fresh connection. Sign in again; credentials and session state stay with their original server."
        />
      )}
      {error && <Form.Description title="Check Connection" text={error} />}
      <Form.Description
        title="Security"
        text="Bearer tokens are saved in Raycast's encrypted local storage. Your Waypoint password is used only to sign in."
      />
    </Form>
  );
}

export function SignInForm({ connection, onSaved }: { connection: Connection; onSaved: () => Promise<void> }) {
  const { pop } = useNavigation();
  const { password, error, loading, submit, changePassword } = useServerSignIn(connection, async () => {
    await onSaved();
    await showToast({ style: Toast.Style.Success, title: "Connected", message: connection.name });
    pop();
  });

  return (
    <Form
      navigationTitle={`Sign In · ${connection.name}`}
      isLoading={loading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Sign in" icon={Icon.Lock} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description title="Server" text={`${connection.name}\n${connection.apiUrl}`} />
      <Form.PasswordField
        id="password"
        title="Password"
        placeholder="Waypoint server password"
        value={password}
        onChange={changePassword}
      />
      {error && <Form.Description title="Sign-in Failed" text={error} />}
      <Form.Description
        title="Private Storage"
        text="Only the bearer token is saved in Raycast's encrypted local storage. Reauthentication preserves this connection's setup."
      />
    </Form>
  );
}
