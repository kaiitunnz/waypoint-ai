import { ApiError, WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import { SessionActionSet, sessionActions, titleProblem } from "../domain/sessionActions";
import { createTag, failedStart } from "../domain/quickChat";
import { QuickChatState, QuickChatStore, setPointer } from "../storage/quickChat";
import { restartTimeoutMs } from "./sessionSettingsController";
import { FeedConnection } from "./sessionFeeds";

export type ManageOutcome =
  | { kind: "done"; session?: Session; deleted?: string }
  // The session changed since it was shown, so the action no longer applies; nothing was sent.
  | { kind: "stale"; session: Session; message: string }
  // A password-auth SSH target must be connected before reattaching.
  | { kind: "ssh"; targetId: string; message: string }
  | { kind: "failed"; message: string; session?: Session };

export function manageFailure(error: unknown, what: string): string {
  if (error instanceof ApiError) {
    if (error.kind === "expired-token") return "Your sign-in expired. Sign in again, then retry.";
    if (error.kind === "not-found") return "This session is no longer on this server.";
    if (error.kind === "rejected")
      return error.status === 403
        ? error.message
        : error.serverDetail
          ? `Waypoint: ${error.serverDetail}`
          : `Waypoint refused to ${what}.`;
    if (error.kind === "unreachable") return error.message;
  }
  return `Waypoint didn't confirm that it could ${what}. Check the session before trying again.`;
}
// Before anything is sent, a failure is local, such as another command holding the server lock, so it says so.
const localFailure = (error: unknown, what: string) =>
  error instanceof ApiError || !(error instanceof Error) ? manageFailure(error, what) : error.message;
const quickChatOf = (saved: QuickChatState) => ({ pointer: saved.pointer, pending: !!saved.pending });
// Quick Chat's unconfirmed operation still needs this session to be checked.
const checkpointFor = (saved: QuickChatState, session: Session) =>
  !!saved.pending &&
  (saved.pending.sessionId === session.id ||
    (saved.pending.kind === "create" &&
      (session.tags[createTag] === saved.pending.operationId ||
        failedStart(saved.pending, session, saved.failedStartAt))));

export class SessionManager {
  constructor(
    private readonly connection: FeedConnection,
    private readonly store: QuickChatStore,
    private readonly client = new WaypointClient(connection.apiUrl),
    private readonly now = Date.now,
  ) {}
  quickChat() {
    return this.store.read(this.connection.id).then(quickChatOf);
  }
  // Every action rereads the session and checks it still qualifies, so a stale row can't restart a live session.
  private async run(
    id: string,
    metadata: ServerMetadata | undefined,
    action: keyof SessionActionSet,
    what: string,
    mutate: (session: Session) => Promise<Session>,
  ): Promise<ManageOutcome> {
    let session: Session;
    try {
      session = await this.client.session(this.connection.token, id);
      if (!sessionActions(session, metadata, await this.quickChat())[action])
        return { kind: "stale", session, message: `This session changed, so it can't ${what} now.` };
    } catch (error) {
      return { kind: "failed", message: localFailure(error, what) };
    }
    try {
      return { kind: "done", session: await mutate(session) };
    } catch (error) {
      const fresh = await this.client.session(this.connection.token, id).catch(() => undefined);
      return { kind: "failed", message: manageFailure(error, what), session: fresh };
    }
  }
  rename(id: string, title: string, metadata?: ServerMetadata) {
    const problem = titleProblem(title);
    if (problem) return Promise.resolve<ManageOutcome>({ kind: "failed", message: problem });
    return this.run(id, metadata, "rename", "rename it", () =>
      this.client.updateSetting(this.connection.token, id, "title", { title: title.trim() }),
    );
  }
  setPinned(id: string, pinned: boolean, metadata?: ServerMetadata) {
    return this.run(id, metadata, pinned ? "pin" : "unpin", pinned ? "pin it" : "unpin it", () =>
      this.client.pin(this.connection.token, id, pinned),
    );
  }
  interrupt(id: string, metadata: ServerMetadata) {
    return this.run(id, metadata, "interrupt", "interrupt it", () =>
      this.client.action(this.connection.token, id, "interrupt"),
    );
  }
  terminate(id: string, metadata?: ServerMetadata) {
    return this.run(id, metadata, "terminate", "terminate it", () =>
      this.client.action(this.connection.token, id, "terminate", restartTimeoutMs),
    );
  }
  async reattach(id: string, metadata: ServerMetadata): Promise<ManageOutcome> {
    let targetId: string | undefined;
    let sshRequired = false;
    const outcome = await this.run(id, metadata, "reattach", "reattach it", async (session) => {
      targetId = session.targetId;
      try {
        return await this.client.action(this.connection.token, id, "reattach", restartTimeoutMs);
      } catch (error) {
        sshRequired = error instanceof ApiError && error.serverDetail === "ssh-master-required";
        throw error;
      }
    });
    const target = metadata.targets.find((entry) => entry.id === targetId);
    if (outcome.kind === "failed" && sshRequired && target?.auth === "password")
      return { kind: "ssh", targetId: target.id, message: `Connect ${target.name} to reattach this session.` };
    return outcome;
  }
  connectTarget(targetId: string, password: string) {
    return this.client.connectTarget(this.connection.token, targetId, password);
  }
  // Waypoint removes the transcript and any session worktree. Quick Chat's references to the session go with it.
  async remove(id: string, metadata?: ServerMetadata): Promise<ManageOutcome> {
    let session: Session;
    try {
      // The session is checked under the server lock, so a Quick Chat send that was reattaching it has finished;
      // the delete itself runs outside the lock, since it can take longer than other commands wait for it.
      const checked = await this.store.transaction(this.connection.id, async (saved) => {
        const current = await this.client.session(this.connection.token, id);
        if (checkpointFor(saved, current))
          return {
            session: current,
            refusal: "Quick Chat has an unconfirmed operation for this session. Check it in Quick Chat first.",
          };
        if (!sessionActions(current, metadata, quickChatOf(saved)).delete)
          return { session: current, refusal: "This session changed, so it can't be deleted now." };
        return { session: current };
      });
      session = checked.session;
      if (checked.refusal) return { kind: "stale", session, message: checked.refusal };
    } catch (error) {
      return { kind: "failed", message: localFailure(error, "delete it") };
    }
    try {
      await this.client.deleteSession(this.connection.token, id, restartTimeoutMs);
    } catch (error) {
      const check = await this.client.session(this.connection.token, id).then(
        (current) => ({ gone: false, current }),
        (failure) => ({ gone: failure instanceof ApiError && failure.kind === "not-found", current: undefined }),
      );
      if (!check.gone) return { kind: "failed", message: manageFailure(error, "delete it"), session: check.current };
    }
    await this.forget(id).catch(() => undefined);
    return { kind: "done", deleted: id };
  }
  private async forget(id: string) {
    await this.store.transaction(this.connection.id, async (saved, persist) => {
      if (saved.pending?.sessionId === id) return;
      if (saved.pointer === id) setPointer(saved, undefined);
      delete saved.sentAt[id];
      for (const draft of Object.values(saved.compose ?? {})) {
        if (draft.sessionId === id) draft.sessionId = draft.launch = undefined;
        for (const file of draft.files) if (file.upload?.sessionId === id) file.upload = undefined;
      }
      await persist();
    });
  }
  // An explicit choice: Quick Chat continues this session until another one replaces it.
  async useForQuickChat(id: string, metadata: ServerMetadata): Promise<ManageOutcome> {
    try {
      return await this.store.transaction(this.connection.id, async (saved, persist): Promise<ManageOutcome> => {
        if (saved.pending)
          return {
            kind: "failed",
            message: "Quick Chat has an unconfirmed operation. Check it in Quick Chat first.",
          };
        const session = await this.client.session(this.connection.token, id);
        if (!sessionActions(session, metadata, quickChatOf(saved)).useForQuickChat)
          return {
            kind: "stale",
            session,
            message:
              saved.pointer === id
                ? "Quick Chat already continues this session."
                : "Quick Chat can't continue this session.",
          };
        setPointer(saved, id, this.now());
        await persist();
        return { kind: "done", session };
      });
    } catch (error) {
      return { kind: "failed", message: localFailure(error, "use it for Quick Chat") };
    }
  }
}
