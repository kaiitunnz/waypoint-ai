import { isRecord } from "../domain/connections";
import { Profile } from "./contracts";

export interface TransportOption {
  id: string;
  launchRestart: boolean;
  profileRestart: boolean;
  customArgs: boolean;
  configOverrides: boolean;
}

// Restart-scoped settings of one session. Environment values never leave the server; only keys are listed.
export interface LaunchSettings {
  backend: string;
  transport: string;
  targetId?: string;
  profileId?: string;
  profiles: Profile[];
  args: string[];
  configOverrides: string[];
  envKeys: string[];
  protectedEnvKeys: string[];
  configDirVariable?: string;
  customArgs: boolean;
  configOverridesSupported: boolean;
  profileRestart: boolean;
  launchRestart: boolean;
  transportOptions: TransportOption[];
  transportSwitch: boolean;
}

export interface UsageProvider {
  id: string;
  label: string;
  accounts: { key: string; label: string }[];
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid launch settings field");
  return value;
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("Invalid launch settings list");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Invalid launch settings entries");
  return value;
}

export function parseLaunchSettings(value: unknown): LaunchSettings {
  if (!isRecord(value)) throw new Error("Invalid launch settings");
  return {
    backend: string(value.backend),
    transport: string(value.transport),
    targetId: optional(value.launch_target_id),
    profileId: optional(value.account_profile_id),
    profiles: records(value.account_profiles ?? []).map((item) => ({ id: string(item.id), label: string(item.label) })),
    args: strings(value.args ?? []),
    configOverrides: strings(value.config_overrides ?? []),
    envKeys: strings(value.launch_env_keys ?? []),
    protectedEnvKeys: strings(value.protected_launch_env_keys ?? []),
    configDirVariable: optional(value.config_dir_env_var),
    customArgs: value.supports_custom_args === true,
    configOverridesSupported: value.supports_config_overrides === true,
    profileRestart: value.supports_account_profile_with_restart === true,
    launchRestart: value.supports_launch_settings_with_restart === true,
    transportOptions: records(value.transport_options ?? []).map((item) => ({
      id: string(item.id),
      launchRestart: item.supports_launch_settings_with_restart === true,
      profileRestart: item.supports_account_profile_with_restart === true,
      customArgs: item.supports_custom_args === true,
      configOverrides: item.supports_config_overrides === true,
    })),
    transportSwitch: value.supports_transport_switch_with_restart === true,
  };
}

export function parseUsageProviders(value: unknown): UsageProvider[] {
  if (!isRecord(value)) throw new Error("Invalid usage providers");
  return records(value.usage_provider_options ?? []).map((item) => ({
    id: string(item.id),
    label: string(item.label),
    accounts: records(item.accounts ?? []).map((account) => ({
      key: string(account.account_key),
      label: optional(account.account_label) ?? string(account.account_key),
    })),
  }));
}
