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
export type ChatLaunchFields = Omit<ChatDefaults, "mode" | "timeoutMinutes">;
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
// `workspace` is the folder Quick Chat uses on the server's own machine when no directory is chosen.
export function launchContext(defaults: ChatDefaults, metadata: ServerMetadata, workspace?: string) {
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
    cwd: defaults.cwd || (!defaults.target && workspace) || target?.defaultCwd || metadata.defaultCwd,
  };
}
export const legacyTitle = "Quick Chat";
// Minute precision in the Mac's local time tells apart chats started on the same day.
export function quickChatTitle(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${legacyTitle} ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
export interface LaunchOptions {
  workspace?: string;
  createdAt?: Date;
  // Where the settings came from, so validation errors point at the right place.
  source?: "defaults" | "form";
}
// The `launch` of a draft binding to a session started from chosen settings rather than the defaults.
export const customLaunch = "custom";
export function createRequest(
  defaults: ChatDefaults,
  metadata: ServerMetadata,
  installation: string,
  operation: string,
  options: LaunchOptions = {},
): Record<string, unknown> {
  const context = launchContext(defaults, metadata, options.workspace);
  const form = options.source === "form";
  const where = form ? "" : " in Quick Chat Defaults";
  const update = form ? "" : " Update Quick Chat Defaults.";
  if (!context.agent || !context.transport || !context.transports.includes(context.transport))
    throw new Error(`Choose an agent with a structured interface${where}.`);
  if (defaults.target && (!context.target || !context.target.agents.includes(context.backend)))
    throw new Error(`This execution target does not support the selected agent.${update}`);
  if (!context.cwd.trim()) throw new Error(`Set a working directory${where}.`);
  if (!["default", "none"].includes(defaults.preset) && !context.preset)
    throw new Error(`The selected preset was removed.${update}`);
  const request: Record<string, unknown> = {
    cwd: context.cwd,
    launch_target_id: defaults.target || null,
    transport: context.transport,
    source_mode: "managed",
    title: quickChatTitle(options.createdAt ?? new Date()),
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
// Launch settings without the per-attempt title and tags, for telling whether defaults changed since a session was created.
export function launchFingerprint(request: Record<string, unknown>): string {
  const settings = Object.fromEntries(Object.entries(request).filter(([key]) => !["tags", "title"].includes(key)));
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
// Server and Mac clocks may differ; a larger skew makes failed starts unrecognizable.
export const clockToleranceMs = 5 * 60000;
// Where a create was launched, to recognize a session that Waypoint created but could not start.
export interface AttemptLaunch {
  backend: string;
  target: string;
  cwd: string;
  // Absent for attempts saved before titles carried their creation time.
  title?: string;
}
export interface CreateAttempt {
  kind: string;
  startedAt: number;
  launch?: AttemptLaunch;
}
// Waypoint stores a session before starting its agent and adds tags only after the start succeeds, so an
// untagged session with the attempt's title from the same launch may belong to a create whose outcome is unconfirmed.
// `after` is the creation time of a failure already recognized, which can't be a later attempt's outcome.
function untaggedAttempt(pending: CreateAttempt, session: Session, after = -Infinity): boolean {
  const launch = pending.launch;
  const created = session.createdAt ? Date.parse(session.createdAt) : NaN;
  return (
    pending.kind === "create" &&
    !!launch &&
    !session.tags[createTag] &&
    session.title === (launch.title ?? legacyTitle) &&
    session.backend === launch.backend &&
    (session.targetId ?? "") === launch.target &&
    // Waypoint normalizes local working directories, so only a remote one is compared.
    (!launch.target || session.cwd === launch.cwd) &&
    created >= pending.startedAt - clockToleranceMs &&
    created > after
  );
}
export function failedStart(pending: CreateAttempt, session: Session, after?: number): boolean {
  return untaggedAttempt(pending, session, after) && session.status === "error";
}
// The creation time of the failed session that settles this create. One still starting may be this create's
// own, so an earlier failed attempt is not taken as its outcome while it exists.
export function failedStartAt(pending: CreateAttempt, sessions: Session[], after?: number): number | undefined {
  if (sessions.some((session) => untaggedAttempt(pending, session, after) && session.status === "starting"))
    return undefined;
  const times = sessions
    .filter((session) => failedStart(pending, session, after))
    .map((session) => Date.parse(session.createdAt!));
  return times.length ? Math.max(...times) : undefined;
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
