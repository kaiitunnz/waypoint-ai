import { ApiError, WaypointClient } from "../api/client";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import { SessionActionSet, sessionActions, titleProblem } from "../domain/sessionActions";
import { createTag, failedStart } from "../domain/quickChat";
import { QuickChatState, QuickChatStore, setPointer } from "../storage/quickChat";
import { restartTimeoutMs } from "./sessionSettingsController";
import { FeedConnection } from "./sessionFeeds";

export type ManageOutcome =
  // `releasedQuickChat` means Quick Chat stopped using the session, so its next send starts a new one.
  | { kind: "done"; session?: Session; deleted?: string; releasedQuickChat?: boolean }
  // The session changed since it was shown, so the action no longer applies; nothing was sent.
  | { kind: "stale"; session: Session; message: string }
  // A password-auth SSH target must be connected before reattaching.
  | { kind: "ssh"; targetId: string; message: string }
  // `uncertain` means the request was sent but Waypoint's answer didn't say whether it applied; `gone` means
  // the session no longer exists.
  | { kind: "failed"; message: string; session?: Session; uncertain?: boolean; gone?: boolean };

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
const isGone = (error: unknown) => error instanceof ApiError && error.kind === "not-found";
const quickChatOf = (saved: QuickChatState) => ({ pointer: saved.pointer, pending: !!saved.pending });
// Quick Chat's unconfirmed operation still needs this session to be checked.
const checkpointFor = (saved: QuickChatState, session: Session) =>
  !!saved.pending &&
  (saved.pending.sessionId === session.id ||
    (saved.pending.kind === "create" &&
      (session.tags[createTag] === saved.pending.operationId ||
        failedStart(saved.pending, session, saved.failedStartAt))));

// What Quick Chat gave up when a session it uses ended, so a definite refusal can put it back.
export interface Released {
  pointer?: boolean;
  chosen?: number;
  bindings: Record<string, string | undefined>;
}
const references = (saved: QuickChatState, id: string) =>
  saved.pointer === id || Object.values(saved.compose ?? {}).some((draft) => draft.sessionId === id);
// Quick Chat stops using the session: it is no longer the destination, and drafts are no longer bound to it.
export function release(saved: QuickChatState, id: string): Released {
  const released: Released = { chosen: saved.chosen?.sessionId === id ? saved.chosen.at : undefined, bindings: {} };
  if (saved.pointer === id) {
    released.pointer = true;
    setPointer(saved, undefined);
  }
  for (const [key, draft] of Object.entries(saved.compose ?? {}))
    if (draft.sessionId === id) {
      released.bindings[key] = draft.launch;
      draft.sessionId = draft.launch = undefined;
    }
  return released;
}
// A definite refusal that didn't end the session; an uncertain result may still end it. A session that had already
// exited counts as not ended by the request.
export function refused(outcome: ManageOutcome, exitedBefore = false): boolean {
  if (outcome.kind === "done" || (outcome.kind === "failed" && (outcome.uncertain || outcome.gone))) return false;
  return exitedBefore || (outcome.kind === "ssh" ? undefined : outcome.session)?.status !== "exited";
}

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
      return { kind: "failed", message: localFailure(error, what), gone: isGone(error) };
    }
    try {
      return { kind: "done", session: await mutate(session) };
    } catch (error) {
      const fresh = await this.client.session(this.connection.token, id).catch(() => undefined);
      const uncertain = !(error instanceof ApiError) || error.kind === "uncertain";
      return { kind: "failed", message: manageFailure(error, what), session: fresh, uncertain, gone: isGone(error) };
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
  // Quick Chat stops using the session first, under the server lock, unless an unconfirmed operation still needs
  // it. Terminate itself is never held up: sessions Quick Chat doesn't use skip the lock, and a lock held by
  // another command only means Quick Chat keeps the session.
  async terminate(id: string, metadata?: ServerMetadata): Promise<ManageOutcome> {
    const saved = await this.store.read(this.connection.id).catch(() => undefined);
    let released: Released | undefined;
    if (saved && references(saved, id))
      released = await this.store
        .transaction(this.connection.id, async (state, persist) => {
          if (state.pending || !references(state, id)) return undefined;
          const released = release(state, id);
          await persist();
          return released;
        })
        .catch(() => undefined);
    const outcome = await this.run(id, metadata, "terminate", "terminate it", () =>
      this.client.action(this.connection.token, id, "terminate", restartTimeoutMs),
    );
    if (released && refused(outcome)) await this.restore(id, released).catch(() => undefined);
    return outcome.kind === "done" && released?.pointer ? { ...outcome, releasedQuickChat: true } : outcome;
  }
  restore(id: string, released: Released) {
    return this.store.transaction(this.connection.id, async (saved, persist) => {
      if (saved.pending) return;
      if (released.pointer && saved.pointer === undefined) setPointer(saved, id, released.chosen);
      for (const [key, launch] of Object.entries(released.bindings)) {
        const draft = saved.compose?.[key];
        if (draft && draft.sessionId === undefined) Object.assign(draft, { sessionId: id, launch });
      }
      await persist();
    });
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
  remove(id: string, metadata?: ServerMetadata) {
    return this.removeWith(id, metadata, false);
  }
  // Waypoint terminates a live session before deleting it. Quick Chat stops using it first, as for terminate.
  terminateAndRemove(id: string, metadata?: ServerMetadata) {
    return this.removeWith(id, metadata, true);
  }
  private async removeWith(id: string, metadata: ServerMetadata | undefined, live: boolean): Promise<ManageOutcome> {
    let session: Session;
    let released: Released | undefined;
    try {
      // The session is checked under the server lock, so a Quick Chat send that was reattaching it has finished;
      // the delete itself runs outside the lock, since it can take longer than other commands wait for it.
      const checked = await this.store.transaction(this.connection.id, async (saved, persist) => {
        const current = await this.client.session(this.connection.token, id);
        if (checkpointFor(saved, current))
          return {
            session: current,
            refusal: "Quick Chat has an unconfirmed operation for this session. Check it in Quick Chat first.",
          };
        const allowed = sessionActions(current, metadata, quickChatOf(saved));
        if (!allowed.delete && !(live && allowed.terminate))
          return { session: current, refusal: "This session changed, so it can't be deleted now." };
        if (live && !saved.pending && references(saved, id)) {
          released = release(saved, id);
          await persist();
        }
        return { session: current };
      });
      session = checked.session;
      if (checked.refusal) return { kind: "stale", session, message: checked.refusal };
    } catch (error) {
      if (!isGone(error)) return { kind: "failed", message: localFailure(error, "delete it") };
      await this.forget(id).catch(() => undefined);
      return { kind: "failed", message: manageFailure(error, "delete it"), gone: true };
    }
    try {
      await this.client.deleteSession(this.connection.token, id, restartTimeoutMs);
    } catch (error) {
      const check = await this.client.session(this.connection.token, id).then(
        (current) => ({ gone: false, current }),
        (failure) => ({ gone: failure instanceof ApiError && failure.kind === "not-found", current: undefined }),
      );
      if (!check.gone) {
        // Waypoint deletes after terminating, so an unanswered request may still be deleting an exited session.
        const outcome: ManageOutcome = {
          kind: "failed",
          message: manageFailure(error, "delete it"),
          session: check.current,
          uncertain: !(error instanceof ApiError) || error.kind === "uncertain",
        };
        if (released && refused(outcome, session.status === "exited"))
          await this.restore(id, released).catch(() => undefined);
        return outcome;
      }
    }
    await this.forget(id).catch(() => undefined);
    return { kind: "done", deleted: id, ...(released?.pointer ? { releasedQuickChat: true } : {}) };
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
  // An explicit choice: the session stays Quick Chat's destination until another one replaces it.
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
                ? "This is already Quick Chat's destination."
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
