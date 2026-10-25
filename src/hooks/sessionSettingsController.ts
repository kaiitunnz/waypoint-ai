import { ApiError, WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { ModelCatalog } from "../api/models";
import { Session } from "../api/sessions";
import { UsageProvider } from "../api/settings";
import {
  Capabilities,
  SettingsBaseline,
  SettingsDraft,
  SettingsPlan,
  SettingsStep,
  StepOp,
  availability,
  capsFor,
  planSettings,
  rebaseDraft,
  settingsBaseline,
  settingsFingerprint,
  stepOps,
} from "../domain/sessionSettings";
import { FeedConnection } from "./sessionFeeds";

export interface SettingsSnapshot {
  loading: boolean;
  applying: boolean;
  restarting: boolean;
  metadata?: ServerMetadata;
  baseline?: SettingsBaseline;
  caps?: Capabilities;
  catalog?: ModelCatalog;
  providers: UsageProvider[];
  error?: string;
  notices: string[];
  // Outcome of the last apply that stopped early.
  result?: { applied: string[]; message: string };
  connectTarget?: string;
  reattach?: boolean;
}

export type PrepareResult =
  { status: "ready"; plan: SettingsPlan } | { status: "stale" | "changed"; draft: SettingsDraft; message: string };

export type ApplyResult =
  | { status: "done"; plan: SettingsPlan }
  | { status: "reconfirm"; plan: SettingsPlan }
  | { status: "failed"; draft: SettingsDraft; applied: string[]; message: string };

export const restartTimeoutMs = 120000;
const settleTimeoutMs = 60000;

const lifecycleBusy = "another lifecycle operation is in progress";
const stillStarting = "cannot change launch settings while the session is STARTING";
const restoreFailed = "restore failed after applying launch settings";

// `what` names the operation ("the model change"); `retry` is the verb each conflict message ends with.
export function settingsFailure(error: unknown, what: string, retry: string, targetName?: string): string {
  if (error instanceof ApiError) {
    if (error.kind === "expired-token") return "Your sign-in expired. Sign in again; your changes stay in this form.";
    if (error.kind === "not-found") return "This session is no longer available on this server.";
    if (error.kind === "rejected") {
      const detail = error.serverDetail ?? "";
      if (detail.startsWith(lifecycleBusy))
        return `Waypoint is restarting or reattaching this session. Wait for it to finish, then ${retry}.`;
      if (detail.startsWith(stillStarting))
        return `The session is still starting. Wait until it's ready, then ${retry}.`;
      if (detail === "ssh-master-required")
        return `Connect ${targetName ?? "the SSH target"} to restart this session, then ${retry}.`;
      if (detail.startsWith(restoreFailed))
        return "The launch settings were saved, but the session didn't restart. Reattach it to continue.";
      return `Waypoint rejected ${what}${detail ? `: ${detail}` : "."}`;
    }
  }
  return `Waypoint didn't confirm ${what}. It may have applied.`;
}

// The target to connect when Waypoint refused because its SSH connection is down.
const sshTarget = (error: unknown, targetId: string) =>
  error instanceof ApiError && error.serverDetail === "ssh-master-required" ? targetId || undefined : undefined;
// Launch settings are restart-scoped, so a confirmed restore failure still means they were saved.
const restoreFailure = (error: unknown) =>
  error instanceof ApiError && error.kind === "rejected" && !!error.serverDetail?.startsWith(restoreFailed);
const uncertain = (error: unknown) =>
  !(error instanceof ApiError) || !["rejected", "expired-token", "not-found"].includes(error.kind);

export class SessionSettingsController {
  private state: SettingsSnapshot = { loading: true, applying: false, restarting: false, providers: [], notices: [] };
  private listeners = new Set<() => void>();
  private active = true;
  private modelRequest = 0;
  constructor(
    private readonly connection: FeedConnection,
    private readonly sessionId: string,
    private readonly client = new WaypointClient(connection.apiUrl),
    private readonly sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    private readonly now = Date.now,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  attach() {
    this.active = true;
  }
  // An apply in flight keeps running after the form closes; it just stops publishing.
  stop() {
    this.active = false;
  }
  private publish(patch: Partial<SettingsSnapshot>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private async fetchState() {
    const token = this.connection.token;
    const notices: string[] = [];
    const [metadata, session, launch, providers] = await Promise.all([
      this.client.me(token),
      this.client.session(token, this.sessionId),
      this.client.launchSettings(token, this.sessionId).catch((error: unknown) => {
        if (error instanceof ApiError && error.kind === "expired-token") throw error;
        return undefined;
      }),
      this.client.usageProviders(token).catch((error: unknown) => {
        if (error instanceof ApiError && error.kind === "expired-token") throw error;
        notices.push("Usage sources couldn't be loaded.");
        return [] as UsageProvider[];
      }),
    ]);
    const baseline = settingsBaseline(session, launch);
    return { metadata, baseline, providers, notices, caps: capsFor(metadata, session.backend, session.transport) };
  }

  async load() {
    this.publish({ loading: true, error: undefined });
    try {
      const fresh = await this.fetchState();
      this.publish({ ...fresh, loading: false });
      return fresh.baseline;
    } catch (error) {
      this.publish({
        loading: false,
        error: error instanceof Error ? error.message : "Could not load this session's settings.",
      });
      return undefined;
    }
  }

  async loadModels(profileId: string | null) {
    const baseline = this.state.baseline;
    if (!baseline) return;
    const request = ++this.modelRequest;
    this.publish({ catalog: undefined });
    try {
      const catalog = await this.client.models(
        this.connection.token,
        baseline.backend,
        baseline.targetId,
        profileId ?? "",
      );
      if (request === this.modelRequest) this.publish({ catalog });
    } catch {
      if (request === this.modelRequest)
        this.publish({
          notices: [
            ...this.state.notices.filter((n) => !n.startsWith("Models")),
            "Models couldn't be loaded. The current model is kept.",
          ],
        });
    }
  }

  plan(draft: SettingsDraft, baseline = this.state.baseline, caps = this.state.caps): SettingsPlan | undefined {
    if (!baseline || !this.state.metadata) return undefined;
    return planSettings(
      baseline,
      draft,
      caps,
      availability(baseline, draft, caps, this.state.metadata, this.state.providers),
    );
  }

  // Re-reads the session before confirming, so the user confirms what will actually be sent.
  async prepare(draft: SettingsDraft, shown: SettingsPlan): Promise<PrepareResult> {
    const previous = this.state.baseline!;
    const fresh = await this.fetchState();
    if (settingsFingerprint(fresh.baseline, fresh.caps) !== settingsFingerprint(previous, this.state.caps)) {
      this.publish({ ...fresh, result: undefined });
      return {
        status: "stale",
        draft: rebaseDraft(draft, previous, fresh.baseline),
        message: "This session's settings changed since you opened it. Review the updated plan and apply again.",
      };
    }
    this.publish({ baseline: fresh.baseline, metadata: fresh.metadata, caps: fresh.caps });
    const plan = this.plan(draft, fresh.baseline, fresh.caps)!;
    if (plan.errors.length) return { status: "changed", draft, message: plan.errors[0] };
    if (stepOps(plan) !== stepOps(shown))
      return { status: "changed", draft, message: this.statusMessage(fresh.baseline.status) };
    return { status: "ready", plan };
  }

  private statusMessage(status: string) {
    return ["exited", "error"].includes(status)
      ? "The session exited. Reattach it to change model, effort, or permission. Review the updated plan and apply again."
      : `The session is now ${status.replaceAll("_", " ")}. Review the updated plan and apply again.`;
  }

  async apply(draft: SettingsDraft, confirmed: SettingsPlan): Promise<ApplyResult> {
    const token = this.connection.token;
    const previous = this.state.baseline!;
    this.publish({ applying: true, result: undefined, connectTarget: undefined, reattach: false });
    try {
      // A confirmation can stay open indefinitely, so the status is read again just before the first change.
      const session = await this.client.session(token, this.sessionId);
      const current = { ...previous, status: session.status };
      const plan = this.plan(draft, current)!;
      if (
        plan.errors.length > 0 ||
        stepOps(plan) !== stepOps(confirmed) ||
        plan.restartCount > confirmed.restartCount ||
        (plan.interruptsTurn && !confirmed.interruptsTurn)
      ) {
        this.publish({ baseline: current });
        return { status: "reconfirm", plan };
      }
      const succeeded: StepOp[] = [];
      for (const step of plan.steps) {
        this.publish({ restarting: step.restarts });
        try {
          await this.client.updateSetting(
            token,
            this.sessionId,
            step.endpoint,
            step.body,
            step.restarts ? restartTimeoutMs : undefined,
          );
          succeeded.push(step.op);
        } catch (error) {
          return { status: "failed", ...(await this.failed(draft, previous, plan, step, succeeded, error)) };
        }
      }
      await this.load();
      return { status: "done", plan };
    } finally {
      this.publish({ applying: false, restarting: false });
    }
  }

  private async failed(
    draft: SettingsDraft,
    previous: SettingsBaseline,
    plan: SettingsPlan,
    step: SettingsStep,
    succeeded: StepOp[],
    error: unknown,
  ) {
    const restored = restoreFailure(error);
    if (restored) succeeded = [...succeeded, step.op];
    const unsure = uncertain(error);
    if (unsure && step.restarts) await this.settle();
    const targetId = previous.targetId;
    const failure = settingsFailure(error, `the ${step.label} change`, "apply again", this.targetName(targetId));
    const applied = plan.steps.filter((entry) => succeeded.includes(entry.op)).map((entry) => entry.label);
    const next = await this.load();
    const notes = [
      failure,
      unsure && step.op === "launch"
        ? "Environment changes may have applied. Check them before adding them again."
        : "",
      unsure
        ? next
          ? "The form shows the session's current settings."
          : "Reload Settings before applying again."
        : "",
    ];
    const result = { applied, message: notes.filter(Boolean).join(" ") };
    this.publish({
      result,
      connectTarget: sshTarget(error, targetId),
      reattach: restored,
    });
    // Without fresh settings, the applied steps still leave the draft so they are never sent twice.
    return {
      ...result,
      draft: rebaseDraft(draft, previous, next ?? previous, succeeded, unsure && step.op === "launch"),
    };
  }

  // An unconfirmed restart may still be running; reading too early would show a half-restarted session.
  private async settle() {
    const deadline = this.now() + settleTimeoutMs;
    while (this.now() < deadline) {
      try {
        const session: Session = await this.client.session(this.connection.token, this.sessionId);
        if (session.status !== "starting") return;
      } catch {
        /* Keep waiting; the refresh after settling reports any lasting failure. */
      }
      await this.sleep(2000);
    }
  }

  private targetName(targetId: string) {
    return this.state.metadata?.targets.find((target) => target.id === targetId)?.name;
  }

  async reattach() {
    const targetId = this.state.baseline?.targetId ?? "";
    this.publish({ applying: true, restarting: true, connectTarget: undefined });
    try {
      await this.client.action(this.connection.token, this.sessionId, "reattach", restartTimeoutMs);
      this.publish({ reattach: false, result: undefined });
    } catch (error) {
      this.publish({
        result: { applied: [], message: settingsFailure(error, "reattaching", "reattach", this.targetName(targetId)) },
        connectTarget: sshTarget(error, targetId),
      });
    } finally {
      this.publish({ applying: false, restarting: false });
      await this.load();
    }
  }

  connectTarget(targetId: string, password: string) {
    return this.client.connectTarget(this.connection.token, targetId, password);
  }
}
