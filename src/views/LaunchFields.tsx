import { Form } from "@raycast/api";
import { useEffect, useState } from "react";
import { customModelValue, defaultsModelChoice, defaultsModelChoices, modelEfforts } from "../domain/modelOptions";
import { launchSettingsDisplay } from "../domain/launchSettings";
import { interfaceName, structuredTransport } from "../domain/sessions";
import { ChatDefaults, launchContext } from "../domain/quickChat";
import { ServerMetadata } from "../api/contracts";
import { ModelCatalog } from "../api/models";
import { WaypointClient } from "../api/client";
import { FeedConnection } from "../hooks/sessionFeeds";
import { localWorkspace } from "../storage/workspace";

type Setter = (update: (current: ChatDefaults) => ChatDefaults) => void;

// `baselineModel` is the saved model, kept as a choice while discovery doesn't list it.
export function useLaunchFields(
  connection: FeedConnection,
  metadata: ServerMetadata,
  values: ChatDefaults,
  setValues: Setter,
  baselineModel: string,
) {
  const [advanced, setAdvanced] = useState(
    !!(values.transport || values.profile || values.permission || values.args || values.config),
  );
  const [discovery, setDiscovery] = useState<{ key: string; catalog?: ModelCatalog; error?: string }>();
  const [modelLoad, setModelLoad] = useState(0);
  const workspace = localWorkspace(connection.apiUrl)?.dir;
  const context = launchContext(values, metadata, workspace);
  const profile = values.profile === "__default__" ? "" : values.profile || context.preset?.profile || "";
  const discoveryKey = JSON.stringify([connection.apiUrl, connection.token, context.backend, values.target, profile]);
  const remoteBlocked = context.target?.auth === "password" && !context.target.connected;
  const models = !remoteBlocked && discovery?.key === discoveryKey ? discovery.catalog : undefined;
  const modelError = discovery?.key === discoveryKey ? discovery.error : undefined;
  const display = launchSettingsDisplay(values, metadata, models, workspace);
  const profiles = display.profiles;
  const efforts = modelEfforts(models, values.model, context.preset?.model);
  const modelChoice = defaultsModelChoice(models, values.model, baselineModel);
  useEffect(() => {
    const controller = new AbortController();
    setDiscovery(undefined);
    if (!context.backend) return;
    void new WaypointClient(connection.apiUrl)
      .models(connection.token, context.backend, values.target, profile, controller.signal)
      .then((catalog) => {
        if (!controller.signal.aborted) setDiscovery({ key: discoveryKey, catalog });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setDiscovery({ key: discoveryKey, error: "Could not load models. Reload them to retry." });
      });
    return () => controller.abort();
  }, [connection.apiUrl, connection.token, context.backend, values.target, profile, modelLoad]);
  function set<K extends keyof ChatDefaults>(key: K, value: ChatDefaults[K]) {
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
  }
  function problem(): string | undefined {
    if (!context.transport || !context.transports.includes(context.transport))
      return "Choose an agent and structured interface.";
    if (values.target && (!context.target || !context.target.agents.includes(context.backend)))
      return "Choose an agent supported by this execution target.";
    if (values.profile && values.profile !== "__default__" && !profiles.some((entry) => entry.id === values.profile))
      return "Choose an available account profile.";
    if (models && values.effort && values.effort !== "__default__" && !efforts.includes(values.effort))
      return "Choose an effort supported by this model.";
    return undefined;
  }
  const fields = (
    <>
      <Form.Dropdown
        id="preset"
        title="Server Preset"
        value={values.preset}
        onChange={(value) => reset("preset", value)}
      >
        <Form.Dropdown.Item value="default" title={display.defaultPreset} />
        <Form.Dropdown.Item value="none" title="No preset" />
        {metadata.presets.map((preset) => (
          <Form.Dropdown.Item key={preset.id} value={preset.id} title={preset.name} />
        ))}
        {!["default", "none"].includes(values.preset) && !context.preset && (
          <Form.Dropdown.Item value={values.preset} title={`Unavailable · ${values.preset}`} />
        )}
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
      <Form.Dropdown
        id="agent"
        title="Agent"
        value={values.agent}
        onChange={(value) => reset("agent", value)}
        info="The first option follows the preset, target, or server default. Choose an agent to override it."
      >
        <Form.Dropdown.Item value="" title={display.agent} />
        {values.agent && !context.agent && (
          <Form.Dropdown.Item value={values.agent} title={`Unavailable · ${values.agent}`} />
        )}
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
        info="The first option follows the preset or server. Agent default bypasses the preset; other models override it."
        onChange={(value) => {
          if (value !== customModelValue && value !== values.model)
            setValues((current) => ({ ...current, model: value, effort: "" }));
        }}
      >
        {defaultsModelChoices(models, values.model, baselineModel, display.model).map((choice) => (
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
        <Form.Dropdown
          id="effort"
          title="Effort"
          value={values.effort}
          onChange={(value) => set("effort", value)}
          info="The first option follows the preset or server. Agent default bypasses the preset effort."
        >
          <Form.Dropdown.Item value="" title={display.effort} />
          <Form.Dropdown.Item value="__default__" title={`${display.defaultEffort} · Agent default`} />
          {values.effort && values.effort !== "__default__" && !efforts.includes(values.effort) && (
            <Form.Dropdown.Item value={values.effort} title={values.effort} />
          )}
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
            <Form.Dropdown.Item value="" title={display.transport} />
            {values.transport && !context.transports.includes(values.transport) && (
              <Form.Dropdown.Item value={values.transport} title={`Unavailable · ${values.transport}`} />
            )}
            {context.transports.map((transport) => (
              <Form.Dropdown.Item key={transport} value={transport} title={interfaceName(metadata, transport)} />
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
            <Form.Dropdown.Item value="" title={display.inheritedProfile} />
            <Form.Dropdown.Item value="__default__" title="No profile · Agent default" />
            {values.profile &&
              values.profile !== "__default__" &&
              !profiles.some((entry) => entry.id === values.profile) && (
                <Form.Dropdown.Item value={values.profile} title={`Unavailable · ${values.profile}`} />
              )}
            {profiles.map((entry) => (
              <Form.Dropdown.Item key={entry.id} value={entry.id} title={entry.label} />
            ))}
          </Form.Dropdown>
          <Form.Dropdown
            id="permission"
            title="Permission Mode"
            value={values.permission}
            onChange={(value) => set("permission", value)}
          >
            <Form.Dropdown.Item value="" title={display.permission} />
            {values.permission && !context.agent?.permissions.some((entry) => entry.id === values.permission) && (
              <Form.Dropdown.Item value={values.permission} title={values.permission} />
            )}
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
      {remoteBlocked && (
        <Form.Description
          title="Model Discovery"
          text="Connect this SSH target to discover its default model and effort."
        />
      )}
    </>
  );
  return { fields, problem, modelError, reloadModels: () => setModelLoad((value) => value + 1), workspace };
}
