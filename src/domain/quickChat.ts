import { ServerMetadata, Preset } from "../api/contracts";
import { Session, PendingQuestions, SessionEvent } from "../api/sessions";
import { latestPlan, pendingApprovals, plansDecisions } from "./interactions";
import { structuredTransport } from "./sessions";

export interface ChatDefaults {
  mode: "timed" | "continue" | "new";
  timeoutMinutes: number;
  preset: string;
  target: string;
  cwd: string;
  agent: string;
  transport: string;
  model: string;
  effort: string;
  permission: string;
  profile: string;
  args?: string[];
  config?: string[];
}
export const initialDefaults = (): ChatDefaults => ({
  mode: "timed",
  timeoutMinutes: 30,
  preset: "default",
  target: "",
  cwd: "",
  agent: "",
  transport: "",
  model: "",
  effort: "",
  permission: "",
  profile: "",
});
export const ownerTag = "raycast_installation";
export const createTag = "raycast_create";
export const roleTag = "raycast_role";
export function chosenPreset(defaults: ChatDefaults, metadata: ServerMetadata): Preset | undefined {
  const id =
    defaults.preset === "default"
      ? (metadata.defaultPreset ?? metadata.presets.find((preset) => preset.isDefault)?.id)
      : defaults.preset === "none"
        ? undefined
        : defaults.preset;
  return metadata.presets.find((preset) => preset.id === id);
}
export function launchContext(defaults: ChatDefaults, metadata: ServerMetadata) {
  const preset = chosenPreset(defaults, metadata);
  const target = metadata.targets.find((target) => target.id === defaults.target);
  const backend = defaults.agent || preset?.backend || target?.defaultAgent || metadata.defaultAgent;
  const agent = metadata.agents.find((agent) => agent.id === backend);
  const transports = metadata.agents
    .filter(
      (descriptor) =>
        agent?.transports.includes(descriptor.nativeTransport) &&
        structuredTransport(metadata, descriptor.nativeTransport),
    )
    .map((descriptor) => descriptor.nativeTransport);
  const transport =
    defaults.transport ||
    preset?.transport ||
    (agent?.transport && transports.includes(agent.transport) ? agent.transport : transports[0]);
  return {
    backend,
    agent,
    preset,
    target,
    transport,
    transports,
    cwd: defaults.cwd || target?.defaultCwd || metadata.defaultCwd,
  };
}
export function createRequest(
  defaults: ChatDefaults,
  metadata: ServerMetadata,
  installation: string,
  operation: string,
): Record<string, unknown> {
  const context = launchContext(defaults, metadata);
  if (!context.agent || !context.transport || !context.transports.includes(context.transport))
    throw new Error("Choose an agent with a structured interface in Quick Chat Defaults.");
  if (defaults.target && (!context.target || !context.target.agents.includes(context.backend)))
    throw new Error("This execution target does not support the selected agent. Update Quick Chat Defaults.");
  if (!context.cwd.trim()) throw new Error("Set a working directory in Quick Chat Defaults.");
  if (!["default", "none"].includes(defaults.preset) && !context.preset)
    throw new Error("The selected preset was removed. Update Quick Chat Defaults.");
  const request: Record<string, unknown> = {
    cwd: context.cwd,
    launch_target_id: defaults.target || null,
    transport: context.transport,
    source_mode: "managed",
    title: "Quick Chat",
    tags: { ...context.preset?.tags, [ownerTag]: installation, [createTag]: operation, [roleTag]: "quick-chat" },
  };
  if (defaults.preset === "default") request.use_default_preset = true;
  else if (defaults.preset !== "none") request.preset_id = defaults.preset;
  if (defaults.agent || !context.preset?.backend) request.backend = context.backend;
  for (const [field, value] of [
    ["model", defaults.model],
    ["effort", defaults.effort],
    ["permission_mode", defaults.permission],
    ["account_profile_id", defaults.profile],
  ] as const)
    if (value) request[field] = value === "__default__" ? null : value;
  if (defaults.args !== undefined) {
    if (!context.agent.customArgs) throw new Error("This agent does not support custom arguments.");
    request.args = defaults.args;
  }
  if (defaults.config !== undefined) {
    if (!context.agent.configOverrides) throw new Error("This agent does not support configuration overrides.");
    request.config_overrides = defaults.config;
  }
  return request;
}
// Launch settings without per-attempt tags, for telling whether defaults changed since a session was created.
export function launchFingerprint(request: Record<string, unknown>): string {
  const settings = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "tags"));
  return JSON.stringify(
    Object.keys(settings)
      .sort()
      .map((key) => [key, settings[key]]),
  );
}
export function canReattach(session: Session, metadata: ServerMetadata): boolean {
  return metadata.agents.find((agent) => agent.nativeTransport === session.transport)?.reattach === true;
}
export function ongoing(
  session: Session,
  questions?: PendingQuestions,
  events: SessionEvent[] = [],
  metadata?: ServerMetadata,
): boolean {
  if (["starting", "running"].includes(session.status) || questions?.questions.length) return true;
  return pendingApprovals(events).length > 0 || (plansDecisions(session, metadata) && !!latestPlan(events));
}
// A Quick Chat opened on a chosen session resumes it only on the server it was opened for.
export const resumeFor = (connectionId: string, pinnedConnectionId: string | undefined, resume: boolean) =>
  resume && connectionId === pinnedConnectionId;
export function reuseDecision(
  defaults: ChatDefaults,
  session: Session | undefined,
  lastSent: number | undefined,
  now: number,
  hasOngoing: boolean,
  forceNew: boolean,
): "new" | "continue" {
  if (forceNew || defaults.mode === "new" || !session) return "new";
  if (defaults.mode === "continue" || lastSent === undefined || hasOngoing) return "continue";
  return lastSent !== undefined && now - lastSent < defaults.timeoutMinutes * 60000 ? "continue" : "new";
}
