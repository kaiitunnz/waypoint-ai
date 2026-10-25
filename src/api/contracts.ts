import { isRecord } from "../domain/connections";

export interface Profile {
  id: string;
  label: string;
}

export interface PermissionMode extends Profile {
  requiresRestart: boolean;
}

// Capabilities of a transport, read from the catalog entry whose native transport it is.
export interface TransportCapabilities {
  structured: boolean;
  liveTerminal: boolean;
  modelInline: boolean;
  modelRestart: boolean;
  effortInline: boolean;
  effortRestart: boolean;
  permissionInline: boolean;
  permissionRestart: boolean;
  interruptsTurn: boolean;
}

export interface Agent {
  id: string;
  label: string;
  transport: string;
  nativeTransport: string;
  transports: string[];
  structured: boolean;
  profiles: Profile[];
  modelSource: string;
  permissions: PermissionMode[];
  efforts: string[];
  transportCapabilities: TransportCapabilities;
  customArgs: boolean;
  configOverrides: boolean;
  reattach: boolean;
  planApproval: boolean;
  attachments: boolean;
  approvalDecisions: string[];
  approvalNote: boolean;
}

export interface ExecutionTarget {
  id: string;
  name: string;
  connected: boolean;
  auth: "key" | "password";
  profiles: Profile[];
  profilesByAgent: Record<string, Profile[]>;
  agents: string[];
  defaultAgent?: string;
  defaultCwd?: string;
}

export interface Preset {
  id: string;
  name: string;
  isDefault: boolean;
  backend?: string;
  transport?: string;
  model?: string;
  effort?: string;
  permission?: string;
  profile?: string;
  tags: Record<string, string>;
}

export interface ServerMetadata {
  defaultAgent: string;
  defaultCwd: string;
  defaultPreset?: string;
  agents: Agent[];
  targets: ExecutionTarget[];
  presets: Preset[];
  usageSources: Profile[];
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Invalid catalog");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid catalog field");
  return value;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("Invalid catalog choices");
  return value;
}

function profiles(value: unknown): Profile[] {
  return records(value).map((item) => ({ id: string(item.id), label: string(item.label) }));
}

function transportCapabilities(item: Record<string, unknown>): TransportCapabilities {
  const caps = isRecord(item.transport_capabilities)
    ? item.transport_capabilities
    : isRecord(item.capabilities)
      ? item.capabilities
      : {};
  return {
    structured: caps.is_structured === true,
    liveTerminal: caps.live_terminal === true,
    modelInline: caps.supports_set_model_inline === true,
    modelRestart: caps.supports_set_model_with_restart === true,
    effortInline: caps.supports_set_effort_inline === true,
    effortRestart: caps.supports_set_effort_with_restart === true,
    permissionInline: caps.supports_set_permission_mode_inline === true,
    permissionRestart: caps.supports_set_permission_mode_with_restart === true,
    interruptsTurn: caps.settings_change_interrupts_turn === true,
  };
}

export function parseMetadata(value: unknown): ServerMetadata {
  if (!isRecord(value) || value.authenticated !== true) throw new Error("Invalid authenticated response");
  return {
    defaultAgent: string(value.default_backend),
    defaultCwd: typeof value.default_cwd === "string" ? value.default_cwd : "",
    defaultPreset: optionalString(value.default_preset_id),
    agents: records(value.backends).map((item) => ({
      id: string(item.id),
      label: string(item.label),
      transport: string(item.default_transport ?? item.transport_id),
      nativeTransport: string(item.transport_id ?? item.default_transport),
      transports: strings(item.supported_transports ?? [item.transport_id]),
      // Raycast renders structured events only; a live terminal pane needs Waypoint.
      structured: transportCapabilities(item).structured && !transportCapabilities(item).liveTerminal,
      modelSource:
        isRecord(item.agent_capabilities) && typeof item.agent_capabilities.model_source === "string"
          ? item.agent_capabilities.model_source
          : "unknown",
      profiles: profiles(item.account_profiles),
      permissions: records(
        isRecord(item.agent_capabilities) ? item.agent_capabilities.permission_modes : undefined,
      ).map((mode) => ({
        id: string(mode.id),
        label: string(mode.label),
        requiresRestart: mode.requires_session_restart === true,
      })),
      transportCapabilities: transportCapabilities(item),
      efforts:
        isRecord(item.agent_capabilities) && Array.isArray(item.agent_capabilities.effort_levels)
          ? strings(item.agent_capabilities.effort_levels)
          : [],
      customArgs: isRecord(item.agent_capabilities) && item.agent_capabilities.supports_custom_cli_args === true,
      configOverrides: isRecord(item.agent_capabilities) && item.agent_capabilities.supports_config_overrides === true,
      approvalDecisions:
        isRecord(item.agent_capabilities) && Array.isArray(item.agent_capabilities.approval_decisions)
          ? strings(item.agent_capabilities.approval_decisions)
          : [],
      approvalNote: isRecord(item.agent_capabilities) && item.agent_capabilities.supports_approval_note === true,
      planApproval: isRecord(item.agent_capabilities) && item.agent_capabilities.supports_plan_approval === true,
      attachments:
        (isRecord(item.agent_capabilities) && item.agent_capabilities.supports_attachments === true) ||
        (isRecord(item.capabilities) && item.capabilities.supports_attachments === true),
      reattach:
        isRecord(item.transport_capabilities) && item.transport_capabilities.supports_reattach_after_exit === true,
    })),
    targets: records(value.launch_targets).map((item) => ({
      id: string(item.id),
      name: string(item.name),
      connected: item.connected === true,
      auth: item.auth === "password" ? "password" : "key",
      agents: Array.isArray(item.supported_backends) ? strings(item.supported_backends) : [],
      defaultAgent: optionalString(item.default_backend),
      defaultCwd: optionalString(item.default_cwd),
      profilesByAgent: isRecord(item.account_profiles_by_backend)
        ? Object.fromEntries(
            Object.entries(item.account_profiles_by_backend).map(([agent, entries]) => [agent, profiles(entries)]),
          )
        : {},
      profiles: isRecord(item.account_profiles_by_backend)
        ? Object.values(item.account_profiles_by_backend).flatMap(profiles)
        : [],
    })),
    presets: records(value.session_presets).map((item) => ({
      id: string(item.id),
      name: string(item.name),
      isDefault: item.is_default === true,
      backend: isRecord(item.spec) ? optionalString(item.spec.backend) : undefined,
      transport: isRecord(item.spec) ? optionalString(item.spec.transport) : undefined,
      model: isRecord(item.spec) ? optionalString(item.spec.model) : undefined,
      effort: isRecord(item.spec) ? optionalString(item.spec.effort) : undefined,
      permission: isRecord(item.spec) ? optionalString(item.spec.permission_mode) : undefined,
      profile: isRecord(item.spec) ? optionalString(item.spec.account_profile_id) : undefined,
      tags:
        isRecord(item.spec) && isRecord(item.spec.tags)
          ? Object.fromEntries(
              Object.entries(item.spec.tags).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            )
          : {},
    })),
    usageSources: profiles(value.usage_provider_options),
  };
}
