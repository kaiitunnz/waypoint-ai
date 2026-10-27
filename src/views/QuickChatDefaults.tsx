import { Action, ActionPanel, Form, Icon, Keyboard, Toast, showToast, useNavigation } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { customModelValue, defaultsModelChoice, defaultsModelChoices, modelEfforts } from "../domain/modelOptions";
import { structuredTransport } from "../domain/sessions";
import { ChatDefaults, launchContext } from "../domain/quickChat";
import { ServerMetadata } from "../api/contracts";
import { ModelCatalog } from "../api/models";
import { WaypointClient } from "../api/client";
import { FeedConnection } from "../hooks/sessionFeeds";
import { quickChatStore } from "../storage/raycast";
import { localWorkspace } from "../storage/workspace";

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
  const [advanced, setAdvanced] = useState(
    !!(defaults.transport || defaults.profile || defaults.permission || defaults.args || defaults.config),
  );
  const [models, setModels] = useState<ModelCatalog>();
  const [modelLoad, setModelLoad] = useState(0);
  const [error, setError] = useState<string>();
  const [modelError, setModelError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const { pop } = useNavigation();
  const workspace = localWorkspace(connection.apiUrl)?.dir;
  const context = launchContext(values, metadata, workspace);
  const profile = values.profile === "__default__" ? "" : values.profile || context.preset?.profile || "";
  const profiles = context.target?.profilesByAgent[context.backend] ?? context.agent?.profiles ?? [];
  const efforts = modelEfforts(models, values.model, context.preset?.model);
  const modelChoice = defaultsModelChoice(models, values.model, defaults.model);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setModels(undefined);
    setModelError(undefined);
    if (!context.backend) return;
    void new WaypointClient(connection.apiUrl)
      .models(connection.token, context.backend, values.target, profile, controller.signal)
      .then((catalog) => {
        if (!controller.signal.aborted) setModels(catalog);
      })
      .catch(() => {
        if (!controller.signal.aborted) setModelError("Could not load models. Reload them to retry.");
      });
    return () => controller.abort();
  }, [connection.apiUrl, connection.token, context.backend, values.target, profile, modelLoad]);
  function set<K extends keyof ChatDefaults>(key: K, value: ChatDefaults[K]) {
    setError(undefined);
    setValues((current) => ({ ...current, [key]: value }));
  }
  function reset(key: "agent" | "target" | "preset", value: string) {
    setValues((current) => ({
      ...current,
      [key]: value,
      model: "",
      effort: "",
      profile: "",
      transport: "",
      permission: "",
      args: undefined,
      config: undefined,
    }));
    setError(undefined);
  }
  async function save() {
    if (pending.current) return;
    if (!Number.isFinite(values.timeoutMinutes) || values.timeoutMinutes <= 0) {
      setError("Enter a positive timeout in minutes.");
      return;
    }
    if (!context.transport || !context.transports.includes(context.transport)) {
      setError("Choose an agent and structured interface for Quick Chat.");
      return;
    }
    if (values.target && (!context.target || !context.target.agents.includes(context.backend))) {
      setError("Choose an agent supported by this execution target.");
      return;
    }
    if (
      values.profile &&
      values.profile !== "__default__" &&
      !profiles.some((profile) => profile.id === values.profile)
    ) {
      setError("Choose an available account profile.");
      return;
    }
    if (models && values.effort && values.effort !== "__default__" && !efforts.includes(values.effort)) {
      setError("Choose an effort supported by this model.");
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
          {modelError && (
            <Action
              title="Reload Models"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={() => setModelLoad((value) => value + 1)}
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
        onChange={(value) => set("mode", value as ChatDefaults["mode"])}
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
          onChange={(value) => set("timeoutMinutes", Number(value))}
          info="Time since the last successful user send. Running work and unresolved interactions remain in the same conversation."
        />
      )}
      <Form.Separator />
      <Form.Dropdown
        id="preset"
        title="Server Preset"
        value={values.preset}
        onChange={(value) => reset("preset", value)}
      >
        <Form.Dropdown.Item value="default" title="Server default preset" />
        <Form.Dropdown.Item value="none" title="No preset" />
        {metadata.presets.map((preset) => (
          <Form.Dropdown.Item key={preset.id} value={preset.id} title={preset.name} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="target"
        title="Execution Target"
        value={values.target}
        onChange={(value) => reset("target", value)}
      >
        <Form.Dropdown.Item value="" title="Local · API server" />
        {metadata.targets.map((target) => (
          <Form.Dropdown.Item key={target.id} value={target.id} title={`${target.name} · SSH`} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="cwd"
        title="Working Directory"
        value={values.cwd}
        onChange={(value) => set("cwd", value)}
        placeholder={context.cwd || "Path on the execution target"}
        info={
          workspace
            ? "Leave empty to use Quick Chat's workspace on this Mac for Local, or the target's default. This path is on Waypoint's execution target."
            : "Leave empty to use the target or server default. This path is on Waypoint's execution target."
        }
      />
      <Form.Dropdown id="agent" title="Agent" value={values.agent} onChange={(value) => reset("agent", value)}>
        <Form.Dropdown.Item value="" title={`Inherit · ${context.backend}`} />
        {metadata.agents
          .filter(
            (agent) =>
              (!context.target || context.target.agents.includes(agent.id)) &&
              agent.transports.some((transport) => structuredTransport(metadata, transport)),
          )
          .map((agent) => (
            <Form.Dropdown.Item key={agent.id} value={agent.id} title={agent.label} />
          ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="model"
        title="Model"
        value={modelChoice}
        onChange={(value) => {
          if (value !== customModelValue && value !== values.model)
            setValues((current) => ({ ...current, model: value, effort: "" }));
        }}
      >
        {defaultsModelChoices(models, values.model, defaults.model).map((choice) => (
          <Form.Dropdown.Item key={choice.value} value={choice.value} title={choice.title} />
        ))}
      </Form.Dropdown>
      {models?.freeText && (
        <Form.TextField
          id="customModel"
          title="Custom Model"
          placeholder="Optional model ID"
          value={values.model === "__default__" ? "" : values.model}
          onChange={(value) => {
            setValues((current) => ({ ...current, model: value, effort: "" }));
          }}
        />
      )}
      {!!efforts.length && (
        <Form.Dropdown id="effort" title="Effort" value={values.effort} onChange={(value) => set("effort", value)}>
          <Form.Dropdown.Item value="" title="Inherit from preset or server" />
          <Form.Dropdown.Item value="__default__" title="Agent default effort" />
          {efforts.map((effort) => (
            <Form.Dropdown.Item key={effort} value={effort} title={effort} />
          ))}
        </Form.Dropdown>
      )}
      <Form.Separator />
      <Form.Checkbox id="advanced" label="Show advanced launch settings" value={advanced} onChange={setAdvanced} />
      {advanced && (
        <>
          <Form.Dropdown
            id="transport"
            title="Interface"
            value={values.transport}
            onChange={(value) => set("transport", value)}
          >
            <Form.Dropdown.Item
              value=""
              title={`Inherit structured interface${context.transport ? ` · ${context.transport}` : ""}`}
            />
            {context.transports.map((transport) => (
              <Form.Dropdown.Item
                key={transport}
                value={transport}
                title={metadata.agents.find((agent) => agent.nativeTransport === transport)?.label ?? transport}
              />
            ))}
          </Form.Dropdown>
          <Form.Dropdown
            id="profile"
            title="Account Profile"
            value={values.profile}
            onChange={(value) => {
              setValues((current) => ({ ...current, profile: value, model: "", effort: "" }));
            }}
          >
            <Form.Dropdown.Item value="" title="Inherit from preset or server" />
            <Form.Dropdown.Item value="__default__" title="Agent default profile" />
            {profiles.map((profile) => (
              <Form.Dropdown.Item key={profile.id} value={profile.id} title={profile.label} />
            ))}
          </Form.Dropdown>
          <Form.Dropdown
            id="permission"
            title="Permission Mode"
            value={values.permission}
            onChange={(value) => set("permission", value)}
          >
            <Form.Dropdown.Item value="" title="Inherit from preset or server" />
            {context.agent?.permissions.map((permission) => (
              <Form.Dropdown.Item key={permission.id} value={permission.id} title={permission.label} />
            ))}
          </Form.Dropdown>
          {context.agent?.customArgs && (
            <>
              <Form.Checkbox
                id="overrideArgs"
                title="Arguments"
                label="Override inherited arguments"
                value={values.args !== undefined}
                onChange={(value) => set("args", value ? [] : undefined)}
              />
              {values.args !== undefined && (
                <Form.TextArea
                  id="args"
                  title="Custom Arguments"
                  placeholder="One argument per line"
                  value={values.args.join("\n")}
                  onChange={(value) => set("args", value ? value.split("\n") : [])}
                />
              )}
            </>
          )}
          {context.agent?.configOverrides && (
            <>
              <Form.Checkbox
                id="overrideConfig"
                title="Configuration"
                label="Override inherited configuration entries"
                value={values.config !== undefined}
                onChange={(value) => set("config", value ? [] : undefined)}
              />
              {values.config !== undefined && (
                <Form.TextArea
                  id="config"
                  title="Config Overrides"
                  placeholder="One override per line"
                  value={values.config.join("\n")}
                  onChange={(value) => set("config", value ? value.split("\n") : [])}
                />
              )}
            </>
          )}
        </>
      )}
      {modelError && <Form.Description title="Model Discovery" text={modelError} />}
      {error && <Form.Description title="Check Defaults" text={error} />}
    </Form>
  );
}
