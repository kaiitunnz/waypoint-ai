import { isRecord } from "../domain/connections";

export interface Profile {
  id: string;
  label: string;
}

export interface Agent {
  id: string;
  label: string;
  transport: string;
  transports: string[];
  structured: boolean;
  profiles: Profile[];
  modelSource: string;
}

export interface ExecutionTarget {
  id: string;
  name: string;
  connected: boolean;
  profiles: Profile[];
}

export interface ServerMetadata {
  defaultAgent: string;
  agents: Agent[];
  targets: ExecutionTarget[];
  presets: { id: string; name: string; isDefault: boolean }[];
  usageSources: Profile[];
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
    agents: records(value.backends).map((item) => ({
      id: string(item.id),
      label: string(item.label),
      transport: string(item.default_transport ?? item.transport_id),
      transports: strings(item.supported_transports ?? [item.transport_id]),
      structured: isRecord(item.transport_capabilities)
        ? item.transport_capabilities.is_structured === true
        : isRecord(item.capabilities) && item.capabilities.is_structured === true,
      modelSource:
        isRecord(item.agent_capabilities) && typeof item.agent_capabilities.model_source === "string"
          ? item.agent_capabilities.model_source
          : "unknown",
      profiles: profiles(item.account_profiles),
    })),
    targets: records(value.launch_targets).map((item) => ({
      id: string(item.id),
      name: string(item.name),
      connected: item.connected === true,
      profiles: isRecord(item.account_profiles_by_backend)
        ? Object.values(item.account_profiles_by_backend).flatMap(profiles)
        : [],
    })),
    presets: records(value.session_presets).map((item) => ({
      id: string(item.id),
      name: string(item.name),
      isDefault: item.is_default === true,
    })),
    usageSources: profiles(value.usage_provider_options),
  };
}
