import { ServerMetadata } from "../api/contracts";
import { ModelCatalog } from "../api/models";
import { defaultEffort, defaultModelLabel, modelLabel } from "./modelOptions";
import { ChatDefaults, chosenPreset, launchContext } from "./quickChat";
import { interfaceName } from "./sessions";

// Display values never replace the stored overrides: empty inherits, __default__ bypasses the preset.
export function launchSettingsDisplay(
  values: ChatDefaults,
  metadata: ServerMetadata,
  catalog?: ModelCatalog,
  workspace?: string,
) {
  const context = launchContext(values, metadata, workspace);
  const preset = context.preset;
  const profiles = context.target?.profilesByAgent[context.backend] ?? context.agent?.profiles ?? [];
  // Waypoint falls back to local discovery for an unconnected password target; it isn't its remote default.
  const models = context.target?.auth === "password" && !context.target.connected ? undefined : catalog;
  const model =
    values.model === "__default__" ? models?.defaultModel : values.model || preset?.model || models?.defaultModel;
  const profile = values.profile === "__default__" ? "" : values.profile || preset?.profile || "";
  const inheritedProfile = preset?.profile;
  const defaultPreset = chosenPreset({ ...values, preset: "default" }, metadata);
  const permission = preset?.permission || "default";
  const inheritedAgent = launchContext({ ...values, agent: "" }, metadata, workspace);
  const inheritedTransport = launchContext({ ...values, transport: "" }, metadata, workspace).transport;
  return {
    context,
    profile,
    profiles,
    defaultPreset: defaultPreset ? `${defaultPreset.name} · Server default` : "No preset · Server default",
    agent: inheritedAgent.agent?.label || inheritedAgent.backend,
    transport: inheritedTransport ? interfaceName(metadata, inheritedTransport) : "Choose an interface",
    model: modelLabel(models, preset?.model) || defaultModelLabel(models) || "Agent default model",
    defaultModel: defaultModelLabel(models) || "Model",
    effort: preset?.effort || defaultEffort(models, model) || "Agent default effort",
    defaultEffort: defaultEffort(models, model) || "Effort",
    inheritedProfile: inheritedProfile
      ? profiles.find((entry) => entry.id === inheritedProfile)?.label || inheritedProfile
      : "No profile",
    permission: context.agent?.permissions.find((entry) => entry.id === permission)?.label || permission,
  };
}
