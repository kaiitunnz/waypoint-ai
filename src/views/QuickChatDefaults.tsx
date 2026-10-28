import { Action, ActionPanel, Form, Icon, Keyboard, Toast, showToast, useNavigation } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { ChatDefaults } from "../domain/quickChat";
import { ServerMetadata } from "../api/contracts";
import { FeedConnection } from "../hooks/sessionFeeds";
import { quickChatStore } from "../storage/raycast";
import { useLaunchFields } from "./LaunchFields";

export function QuickChatDefaults({
  connection,
  metadata,
  defaults,
  onSaved,
}: {
  connection: FeedConnection;
  metadata: ServerMetadata;
  defaults: ChatDefaults;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState(defaults);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const { pop } = useNavigation();
  const launch = useLaunchFields(
    connection,
    metadata,
    values,
    (update) => {
      setError(undefined);
      setValues(update);
    },
    defaults.model,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function save() {
    if (pending.current) return;
    if (!Number.isFinite(values.timeoutMinutes) || values.timeoutMinutes <= 0) {
      setError("Enter a positive timeout in minutes.");
      return;
    }
    const problem = launch.problem();
    if (problem) {
      setError(problem);
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      await quickChatStore.defaults(connection.id, values);
      if (!mounted.current) return;
      await onSaved();
      if (!mounted.current) return;
      await showToast({
        style: Toast.Style.Success,
        title: "Quick Chat defaults saved",
      });
      if (mounted.current) pop();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "Could not save defaults.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Form
      navigationTitle="Quick Chat Defaults"
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Defaults" icon={Icon.Checkmark} onSubmit={save} />
          {launch.modelError && (
            <Action
              title="Reload Models"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={launch.reloadModels}
            />
          )}
        </ActionPanel>
      }
    >
      <Form.Description text="Defaults for new conversations." />
      <Form.Dropdown
        id="reuse"
        title="Reuse"
        value={values.mode}
        onChange={(value) => {
          setError(undefined);
          setValues((current) => ({ ...current, mode: value as ChatDefaults["mode"] }));
        }}
      >
        <Form.Dropdown.Item value="timed" title="Continue within timeout" />
        <Form.Dropdown.Item value="continue" title="Always continue" />
        <Form.Dropdown.Item value="new" title="Always new" />
      </Form.Dropdown>
      {values.mode === "timed" && (
        <Form.TextField
          id="timeout"
          title="Timeout (Minutes)"
          value={String(values.timeoutMinutes)}
          onChange={(value) => {
            setError(undefined);
            setValues((current) => ({ ...current, timeoutMinutes: Number(value) }));
          }}
          info="Time since the last successful user send. Running work and unresolved interactions remain in the same conversation."
        />
      )}
      <Form.Separator />
      {launch.fields}
      {error && <Form.Description title="Check Defaults" text={error} />}
    </Form>
  );
}
