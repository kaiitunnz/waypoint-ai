import { PermissionMode, ServerMetadata, TransportCapabilities } from "../api/contracts";
import { ModelCatalog } from "../api/models";
import { Session, UsageSource } from "../api/sessions";
import { LaunchSettings, TransportOption, UsageProvider } from "../api/settings";
import { customModelValue, defaultEffort, defaultModelLabel, modelEfforts, modelLabel } from "./modelOptions";
import { interfaceName, structuredTransport } from "./sessions";

export interface Capabilities extends TransportCapabilities {
  permissions: PermissionMode[];
}

// An agent's capabilities on a transport: the agent's own entry, with the transport's entry deciding the transport axis.
export function capsFor(metadata: ServerMetadata, backend: string, transport: string): Capabilities | undefined {
  const agent = metadata.agents.find((entry) => entry.id === backend);
  const carrier = metadata.agents.find((entry) => entry.nativeTransport === transport);
  if (!agent || !carrier) return undefined;
  return { ...carrier.transportCapabilities, permissions: agent.permissions };
}

export interface SettingsBaseline {
  sessionId: string;
  status: string;
  backend: string;
  targetId: string;
  cwd: string;
  title: string;
  model: string | null;
  resolvedModel?: string;
  effort: string | null;
  permission: string | null;
  profileId: string | null;
  profileLabel?: string;
  transport: string;
  args: string[];
  config: string[];
  usage: UsageSource;
  launch?: LaunchSettings;
}

export function settingsBaseline(session: Session, launch?: LaunchSettings): SettingsBaseline {
  return {
    sessionId: session.id,
    status: session.status,
    backend: session.backend,
    targetId: session.targetId ?? "",
    cwd: session.cwd,
    title: session.title,
    model: session.modelSelection,
    resolvedModel: session.model,
    effort: session.effort,
    permission: session.permissionMode ?? null,
    profileId: launch ? (launch.profileId ?? null) : (session.profile?.id ?? null),
    profileLabel: session.profile?.label,
    transport: session.transport,
    // Arguments can carry private values, so they come only from launch settings, never from session listings.
    args: launch?.args ?? [],
    config: launch?.configOverrides ?? [],
    usage: session.usageSource,
    launch,
  };
}

export type EnvOp = "keep" | "replace" | "remove";

export interface SettingsDraft {
  title: string;
  model: string | null;
  effort: string | null;
  permission: string | null;
  profileId: string | null;
  transport: string;
  args: string;
  config: string;
  env: Record<string, { op: EnvOp; value: string }>;
  newEnv: { key: string; value: string }[];
  usage: UsageSource;
}

export function settingsDraft(baseline: SettingsBaseline): SettingsDraft {
  return {
    title: baseline.title,
    model: baseline.model,
    effort: baseline.effort,
    permission: baseline.permission,
    profileId: baseline.profileId,
    transport: baseline.transport,
    args: baseline.args.join("\n"),
    config: baseline.config.join("\n"),
    env: Object.fromEntries((baseline.launch?.envKeys ?? []).map((key) => [key, { op: "keep", value: "" }])),
    newEnv: withBlankEnvRow([]),
    usage: baseline.usage,
  };
}

export type EnvRow = SettingsDraft["newEnv"][number];
const blankRow = (row: EnvRow) => !row.key.trim() && !row.value;

// New variables end in exactly one blank row to type into. Rows are kept as they are, so a field being edited is
// never replaced under the cursor; only blank rows after the first trailing one go.
export function withBlankEnvRow(rows: EnvRow[]): EnvRow[] {
  let end = rows.length;
  while (end > 0 && blankRow(rows[end - 1])) end--;
  return end < rows.length ? rows.slice(0, end + 1) : [...rows, { key: "", value: "" }];
}

export function removeLastEnvRow(rows: EnvRow[]): EnvRow[] {
  const index = rows.findLastIndex((row) => !blankRow(row));
  return index < 0 ? withBlankEnvRow(rows) : withBlankEnvRow([...rows.slice(0, index), ...rows.slice(index + 1)]);
}

// The session's fixed settings, as the web app's context line shows them.
export function contextLine(baseline: SettingsBaseline, metadata: ServerMetadata): string {
  return [
    metadata.agents.find((agent) => agent.id === baseline.backend)?.label ?? baseline.backend,
    interfaceName(metadata, baseline.transport),
    baseline.targetId || "Local",
    baseline.cwd,
  ]
    .filter(Boolean)
    .join(" · ");
}

export const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);
const sameUsage = (a: UsageSource, b: UsageSource) =>
  a.kind === b.kind &&
  (a.providerId ?? null) === (b.providerId ?? null) &&
  (a.accountKey ?? null) === (b.accountKey ?? null);

const live = (status: string) => !["exited", "error"].includes(status);

export interface Availability {
  tuning: boolean;
  tuningNote?: string;
  permission: boolean;
  model: boolean;
  effort: boolean;
  launch: boolean;
  launchNote?: string;
  profile: boolean;
  args: boolean;
  config: boolean;
  transports: string[];
  terminalHidden: boolean;
  usage: boolean;
}

export function availability(
  baseline: SettingsBaseline,
  draft: SettingsDraft,
  caps: Capabilities | undefined,
  metadata: ServerMetadata,
  usageProviders: UsageProvider[],
): Availability {
  const launch = baseline.launch;
  const offered = launch?.transportSwitch ? launch.transportOptions.map((option) => option.id) : [];
  const transports = offered.filter((id) => id === baseline.transport || structuredTransport(metadata, id));
  const switching = draft.transport !== baseline.transport;
  const option: TransportOption | undefined = switching
    ? launch?.transportOptions.find((entry) => entry.id === draft.transport)
    : undefined;
  const launchAvailable = !!launch && (switching ? !!option?.launchRestart : launch.launchRestart);
  // Agents apply these through the running process, which doesn't exist yet while starting or after exiting.
  const tuning = !switching && live(baseline.status) && baseline.status !== "starting" && !!caps;
  return {
    tuning,
    tuningNote: switching
      ? "Apply the interface change first, then adjust model, effort, and permission."
      : !live(baseline.status)
        ? "Reattach this session to change model, effort, or permission."
        : baseline.status === "starting"
          ? "The session is still starting. Reload when it's ready to change model, effort, or permission."
          : undefined,
    permission: tuning && !!caps && (caps.permissionInline || caps.permissionRestart) && caps.permissions.length > 0,
    model: tuning && !!caps && (caps.modelInline || caps.modelRestart),
    effort: tuning && !!caps && (caps.effortInline || caps.effortRestart),
    launch: launchAvailable,
    launchNote: !launch
      ? "Launch settings couldn't be loaded. Reload to change profile, interface, arguments, or environment."
      : !launchAvailable
        ? `${baseline.backend} doesn't support restart-applied launch settings.`
        : undefined,
    profile:
      launchAvailable &&
      !!launch &&
      launch.profiles.length > 0 &&
      (option ? option.profileRestart : launch.profileRestart),
    args: launchAvailable && (option ? option.customArgs : !!launch?.customArgs),
    config: launchAvailable && (option ? option.configOverrides : !!launch?.configOverridesSupported),
    transports: transports.length > 1 ? transports : [],
    terminalHidden: transports.length < offered.length,
    usage: usageProviders.length > 0 || baseline.usage.kind === "usage_provider",
  };
}

export function protectedEnvKeys(baseline: SettingsBaseline, draft: SettingsDraft): Set<string> {
  const keys = new Set(baseline.launch?.protectedEnvKeys ?? ["WAYPOINT_SESSION_ID"]);
  keys.add("WAYPOINT_SESSION_ID");
  // The profile owns its config directory, so the key is hidden while one is staged.
  if (draft.profileId && baseline.launch?.configDirVariable) keys.add(baseline.launch.configDirVariable);
  return keys;
}

export function editableEnvKeys(baseline: SettingsBaseline, draft: SettingsDraft): string[] {
  const hidden = protectedEnvKeys(baseline, draft);
  return (baseline.launch?.envKeys ?? []).filter((key) => !hidden.has(key));
}

export function envPatch(baseline: SettingsBaseline, draft: SettingsDraft) {
  const hidden = protectedEnvKeys(baseline, draft);
  const existing = new Set(baseline.launch?.envKeys ?? []);
  const set: Record<string, string> = {};
  const unset: string[] = [];
  const errors: string[] = [];
  for (const key of editableEnvKeys(baseline, draft)) {
    const entry = draft.env[key];
    // An empty replacement keeps the stored value rather than blanking a secret.
    if (entry?.op === "replace" && entry.value) set[key] = entry.value;
    else if (entry?.op === "remove") unset.push(key);
  }
  const added = new Set<string>();
  for (const row of draft.newEnv) {
    const key = row.key.trim();
    if (!key) continue;
    if (/[=\0]/.test(key)) errors.push(`${key} isn't a valid variable name.`);
    else if (hidden.has(key)) errors.push(`${key} is managed by Waypoint.`);
    else if (existing.has(key)) errors.push(`${key} is already set. Replace it instead.`);
    else if (added.has(key)) errors.push(`${key} is listed twice.`);
    else {
      added.add(key);
      set[key] = row.value;
    }
  }
  return { set, unset, errors };
}

export type StepOp = "title" | "launch" | "permission" | "model" | "effort" | "usage";
export type SettingEndpoint = "title" | "launch-settings" | "mode" | "model" | "effort" | "usage-limit-source";

export interface SettingsStep {
  op: StepOp;
  label: string;
  endpoint: SettingEndpoint;
  body: Record<string, unknown>;
  restarts: boolean;
}

export interface SettingsPlan {
  kind: "none" | "inline" | "restart-resume";
  steps: SettingsStep[];
  restartCount: number;
  interruptsTurn: boolean;
  transportChanged: boolean;
  profileChanged: boolean;
  warnings: string[];
  errors: string[];
}

export const stepLabels: Record<StepOp, string> = {
  title: "title",
  launch: "launch settings",
  permission: "permission mode",
  model: "model",
  effort: "effort",
  usage: "usage source",
};

export function planSettings(
  baseline: SettingsBaseline,
  draft: SettingsDraft,
  caps: Capabilities | undefined,
  available: Availability,
): SettingsPlan {
  const errors: string[] = [];
  const steps: SettingsStep[] = [];
  const title = draft.title.trim();
  if (!title) errors.push("Enter a title.");
  else if (title.length > 500) errors.push("Use a title of 500 characters or fewer.");
  else if (title !== baseline.title)
    steps.push({ op: "title", label: stepLabels.title, endpoint: "title", body: { title }, restarts: false });

  const transportChanged = available.transports.length > 0 && draft.transport !== baseline.transport;
  const profileChanged = available.profile && draft.profileId !== baseline.profileId;
  const args = lines(draft.args);
  const config = lines(draft.config);
  const argsChanged = available.args && !sameList(args, baseline.args);
  const configChanged = available.config && !sameList(config, baseline.config);
  const env = available.launch ? envPatch(baseline, draft) : { set: {}, unset: [], errors: [] };
  errors.push(...env.errors);
  const envChanged = Object.keys(env.set).length > 0 || env.unset.length > 0;
  if (transportChanged || (available.launch && (profileChanged || argsChanged || configChanged || envChanged))) {
    const body: Record<string, unknown> = { restart: true };
    if (transportChanged) body.transport = draft.transport;
    if (profileChanged) body.account_profile_id = draft.profileId;
    if (argsChanged) body.args = args;
    if (configChanged) body.config_overrides = config;
    if (Object.keys(env.set).length) body.env_set = env.set;
    if (env.unset.length) body.env_unset = env.unset;
    steps.push({ op: "launch", label: stepLabels.launch, endpoint: "launch-settings", body, restarts: true });
  }

  let tuneRestarts = 0;
  const tune = (
    op: "permission" | "model" | "effort",
    endpoint: SettingEndpoint,
    field: string,
    value: string | null,
    inline: boolean,
    restart: boolean,
    extra = false,
  ) => {
    const restarts = !!caps && (caps.interruptsTurn || (restart && !inline) || extra);
    if (restarts) tuneRestarts++;
    steps.push({ op, label: stepLabels[op], endpoint, body: { [field]: value }, restarts });
  };
  if (caps && available.permission && draft.permission !== null && draft.permission !== baseline.permission)
    tune(
      "permission",
      "mode",
      "mode",
      draft.permission,
      caps.permissionInline,
      caps.permissionRestart,
      caps.permissions.find((mode) => mode.id === draft.permission)?.requiresRestart === true,
    );
  if (caps && available.model && draft.model !== baseline.model)
    tune("model", "model", "model", draft.model, caps.modelInline, caps.modelRestart);
  if (caps && available.effort && draft.effort !== baseline.effort)
    tune("effort", "effort", "effort", draft.effort, caps.effortInline, caps.effortRestart);
  if (available.usage && !sameUsage(draft.usage, baseline.usage)) {
    if (draft.usage.kind === "usage_provider" && (!draft.usage.providerId || !draft.usage.accountKey))
      errors.push("Choose a usage provider account.");
    else
      steps.push({
        op: "usage",
        label: stepLabels.usage,
        endpoint: "usage-limit-source",
        body:
          draft.usage.kind === "plugin"
            ? { usage_limit_source: "plugin", usage_provider_id: null, usage_provider_account_key: null }
            : {
                usage_limit_source: "usage_provider",
                usage_provider_id: draft.usage.providerId,
                usage_provider_account_key: draft.usage.accountKey,
              },
        restarts: false,
      });
  }

  const launchStep = steps.some((step) => step.op === "launch");
  const restartCount = (launchStep ? 1 : 0) + tuneRestarts;
  const interruptsTurn = restartCount > 0 && ["running", "waiting_input"].includes(baseline.status);
  if (launchStep && baseline.status === "starting")
    errors.push("The session is still starting. Wait until it's ready, then apply.");
  const warnings: string[] = [];
  if (launchStep && !live(baseline.status)) warnings.push("Applying these changes starts the session again.");
  if (transportChanged) warnings.push("The session will be restarted, keeping its conversation.");
  else if (restartCount > 1)
    warnings.push(`Applying these changes will restart the session ${restartCount} times and resume it.`);
  else if (restartCount === 1) warnings.push("The session process will restart and resume.");
  if (interruptsTurn) warnings.push("The current turn will be interrupted.");
  if (profileChanged)
    warnings.push(
      "Switching account profile restarts the session under the new profile. For Codex, a thread with no persisted transcript starts fresh.",
    );
  return {
    kind: !steps.length ? "none" : restartCount > 0 ? "restart-resume" : "inline",
    steps,
    restartCount,
    interruptsTurn,
    transportChanged,
    profileChanged,
    warnings,
    errors,
  };
}

export const stepOps = (plan: SettingsPlan) => plan.steps.map((step) => step.op).join(",");

export interface Choice {
  value: string;
  title: string;
}

export const defaultValue = "__default__";
export const toChoice = (value: string | null) => value ?? defaultValue;
export const fromChoice = (value: string) => (value === defaultValue ? null : value);

const listed = (catalog: ModelCatalog | undefined, id: string) => !!catalog?.models.some((model) => model.id === id);

export function modelChoice(catalog: ModelCatalog | undefined, baseline: SettingsBaseline, draft: SettingsDraft) {
  if (draft.model === null) return defaultValue;
  return listed(catalog, draft.model) || draft.model === baseline.model ? draft.model : customModelValue;
}

// Every option list includes the baseline, so a controlled dropdown never falls back to its first item.
export function modelChoices(catalog: ModelCatalog | undefined, baseline: SettingsBaseline, draft: SettingsDraft) {
  const currentDefault = sessionDefaultModel(baseline, draft);
  const label = modelLabel(catalog, currentDefault) || defaultModelLabel(catalog);
  const choices: Choice[] = [{ value: defaultValue, title: label ? `${label} · Default` : "Agent default model" }];
  if (baseline.model && !listed(catalog, baseline.model))
    choices.push({ value: baseline.model, title: `Custom · ${baseline.model}` });
  // Kept while free text is allowed, so typing through a listed ID doesn't remove the selected item.
  const custom = modelChoice(catalog, baseline, draft) === customModelValue;
  if (custom || catalog?.freeText)
    choices.push({ value: customModelValue, title: custom ? `Custom · ${draft.model}` : "Custom model (type below)" });
  for (const model of catalog?.models ?? []) choices.push({ value: model.id, title: model.label });
  return choices;
}

function sessionDefaultModel(baseline: SettingsBaseline, draft: SettingsDraft): string | undefined {
  return baseline.model === null &&
    draft.model === null &&
    draft.profileId === baseline.profileId &&
    draft.transport === baseline.transport
    ? baseline.resolvedModel
    : undefined;
}

export function effortChoices(catalog: ModelCatalog | undefined, baseline: SettingsBaseline, draft: SettingsDraft) {
  const model = draft.model ?? sessionDefaultModel(baseline, draft);
  const efforts = modelEfforts(catalog, model || defaultValue);
  // Resetting an existing session clears the adapter's effort; it doesn't reapply launch configuration.
  const effort = defaultEffort(catalog, model, false);
  const choices: Choice[] = [{ value: defaultValue, title: effort ? `${effort} · Default` : "Agent default effort" }];
  for (const value of [baseline.effort, draft.effort])
    if (value && !efforts.includes(value) && !choices.some((c) => c.value === value))
      choices.push({ value, title: value });
  return { choices: [...choices, ...efforts.map((effort) => ({ value: effort, title: effort }))], efforts };
}

// A model change keeps the staged effort only when the new model accepts it.
export function effortForModel(catalog: ModelCatalog | undefined, model: string | null, effort: string | null) {
  if (!catalog || effort === null) return effort;
  return modelEfforts(catalog, model ?? defaultValue).includes(effort) ? effort : null;
}

export function permissionChoices(caps: Capabilities | undefined, baseline: SettingsBaseline) {
  const choices: Choice[] = (caps?.permissions ?? []).map((mode) => ({ value: mode.id, title: mode.label }));
  if (!choices.some((choice) => choice.value === toChoice(baseline.permission)))
    choices.unshift({
      value: toChoice(baseline.permission),
      title: baseline.permission ? `Current · ${baseline.permission}` : "Not set",
    });
  return choices;
}

export function profileChoices(baseline: SettingsBaseline) {
  const choices: Choice[] = [{ value: defaultValue, title: "No profile (agent default)" }];
  for (const profile of baseline.launch?.profiles ?? []) choices.push({ value: profile.id, title: profile.label });
  if (baseline.profileId && !choices.some((choice) => choice.value === baseline.profileId))
    choices.push({ value: baseline.profileId, title: `Unavailable · ${baseline.profileLabel ?? baseline.profileId}` });
  return choices;
}

export const usageValue = (usage: UsageSource) =>
  usage.kind === "plugin" ? "plugin" : `${usage.providerId ?? ""}\n${usage.accountKey ?? ""}`;

export function usageChoices(providers: UsageProvider[], baseline: SettingsBaseline) {
  const choices: Choice[] = [{ value: "plugin", title: "Agent plugin" }];
  for (const provider of providers)
    for (const account of provider.accounts)
      choices.push({ value: `${provider.id}\n${account.key}`, title: `${provider.label} · ${account.label}` });
  const current = usageValue(baseline.usage);
  if (!choices.some((choice) => choice.value === current))
    choices.push({ value: current, title: `Unavailable · ${baseline.usage.providerId ?? "usage provider"}` });
  return choices;
}

export function usageFromValue(value: string): UsageSource {
  if (value === "plugin") return { kind: "plugin" };
  const [providerId, accountKey] = value.split("\n");
  return { kind: "usage_provider", providerId, accountKey };
}

// Settings identity for detecting changes made elsewhere. Status is excluded so a busy session doesn't look stale.
export function settingsFingerprint(baseline: SettingsBaseline, caps: Capabilities | undefined): string {
  const launch = baseline.launch;
  return JSON.stringify([
    baseline.backend,
    baseline.targetId,
    baseline.title,
    baseline.model,
    baseline.effort,
    baseline.permission,
    baseline.profileId,
    usageValue(baseline.usage),
    baseline.args,
    baseline.config,
    baseline.transport,
    launch
      ? [
          launch.customArgs,
          launch.configOverridesSupported,
          launch.profileRestart,
          launch.launchRestart,
          launch.transportSwitch,
          launch.transportOptions,
          launch.protectedEnvKeys,
          [...launch.envKeys].sort(),
          launch.profiles,
        ]
      : null,
    caps ?? null,
  ]);
}

// Carries the user's edits onto refreshed state. Succeeded steps take the server's values; untouched fields follow
// the server; edited fields keep the user's value.
export function rebaseDraft(
  draft: SettingsDraft,
  previous: SettingsBaseline,
  next: SettingsBaseline,
  succeeded: StepOp[] = [],
  uncertainLaunch = false,
): SettingsDraft {
  const fresh = settingsDraft(next);
  const old = settingsDraft(previous);
  const done = new Set(succeeded);
  const pick = <K extends keyof SettingsDraft>(key: K, op?: StepOp, launch = false): SettingsDraft[K] =>
    (op && done.has(op)) || (launch && done.has("launch")) || JSON.stringify(draft[key]) === JSON.stringify(old[key])
      ? fresh[key]
      : draft[key];
  const env = done.has("launch") || uncertainLaunch ? fresh.env : { ...fresh.env };
  if (!done.has("launch") && !uncertainLaunch)
    for (const key of Object.keys(fresh.env)) if (draft.env[key]) env[key] = draft.env[key];
  const newEnv = withBlankEnvRow(
    done.has("launch") || uncertainLaunch
      ? []
      : draft.newEnv.flatMap((row) => {
          const key = row.key.trim();
          if (key && fresh.env[key]) {
            env[key] = { op: row.value ? "replace" : "keep", value: row.value };
            return [];
          }
          return [row];
        }),
  );
  return {
    title: pick("title", "title"),
    model: pick("model", "model"),
    effort: pick("effort", "effort"),
    permission: pick("permission", "permission"),
    profileId: pick("profileId", undefined, true),
    transport: pick("transport", undefined, true),
    args: pick("args", undefined, true),
    config: pick("config", undefined, true),
    env,
    newEnv,
    usage: pick("usage", "usage"),
  };
}
