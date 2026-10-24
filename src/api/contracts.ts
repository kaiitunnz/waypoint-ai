import { isRecord } from "../domain/connections";

export interface Profile {
  id: string;
  label: string;
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
  permissions: Profile[];
  efforts: string[];
  customArgs: boolean;
  configOverrides: boolean;
  reattach: boolean;
  planApproval: boolean;
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
      structured: isRecord(item.transport_capabilities)
        ? item.transport_capabilities.is_structured === true
        : isRecord(item.capabilities) && item.capabilities.is_structured === true,
      modelSource:
        isRecord(item.agent_capabilities) && typeof item.agent_capabilities.model_source === "string"
          ? item.agent_capabilities.model_source
          : "unknown",
      profiles: profiles(item.account_profiles),
      permissions: profiles(isRecord(item.agent_capabilities) ? item.agent_capabilities.permission_modes : undefined),
      efforts:
        isRecord(item.agent_capabilities) && Array.isArray(item.agent_capabilities.effort_levels)
          ? strings(item.agent_capabilities.effort_levels)
          : [],
      customArgs: isRecord(item.agent_capabilities) && item.agent_capabilities.supports_custom_cli_args === true,
      configOverrides: isRecord(item.agent_capabilities) && item.agent_capabilities.supports_config_overrides === true,
      planApproval: isRecord(item.agent_capabilities) && item.agent_capabilities.supports_plan_approval === true,
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
