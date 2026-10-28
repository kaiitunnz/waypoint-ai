import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import { canReattach } from "./quickChat";
import { isStructured } from "./sessions";

export interface SessionActionSet {
  rename: boolean;
  pin: boolean;
  unpin: boolean;
  interrupt: boolean;
  reattach: boolean;
  terminate: boolean;
  delete: boolean;
  useForQuickChat: boolean;
  openInQuickChat: boolean;
}
export const maxTitleLength = 500;
const none: SessionActionSet = {
  rename: false,
  pin: false,
  unpin: false,
  interrupt: false,
  reattach: false,
  terminate: false,
  delete: false,
  useForQuickChat: false,
  openInQuickChat: false,
};
const finished = (session: Session) => ["exited", "error"].includes(session.status);

// `quickChat` describes the server's Quick Chat: its destination and whether an operation awaits confirmation.
export function sessionActions(
  session: Session,
  metadata: ServerMetadata | undefined,
  quickChat: { pointer?: string; pending: boolean },
): SessionActionSet {
  if (["assistant", "telemetry"].includes(session.source)) return none;
  const structured = isStructured(session, metadata);
  const reattachable = !!metadata && canReattach(session, metadata);
  const resumable = structured && (!finished(session) || reattachable);
  const destination = quickChat.pointer === session.id;
  return {
    rename: true,
    pin: !session.pinnedAt,
    unpin: !!session.pinnedAt,
    // A terminal interface would receive Ctrl-C in its pane, which may be the user's own shell.
    interrupt: structured && ["starting", "running", "waiting_input"].includes(session.status),
    reattach: finished(session) && reattachable,
    terminate: session.status !== "exited",
    delete: finished(session),
    useForQuickChat: resumable && !destination && !quickChat.pending,
    openInQuickChat: resumable && destination,
  };
}

// Why a chat bound to this session can't send to it.
export function sessionProblem(session: Session, metadata: ServerMetadata): string | undefined {
  if (!isStructured(session, metadata)) return "This session's interface needs Waypoint. Open it in Waypoint.";
  if (finished(session) && !canReattach(session, metadata))
    return "This session ended and its interface can't resume it, so it can't take messages.";
  return undefined;
}

export function titleProblem(title: string): string | undefined {
  const value = title.trim();
  if (!value) return "Enter a title.";
  if (value.length > maxTitleLength) return `Use ${maxTitleLength} characters or fewer.`;
  return undefined;
}

export const terminateMessage = "Stops any running work.";
export const quickChatMovesOn = "Quick Chat starts a new chat.";
// A worktree can hold uncommitted changes, so it is named.
export function deleteMessage(session: Session, live = false): string {
  const removed = session.worktreePath
    ? `its transcript and its worktree at ${session.worktreePath}, including uncommitted changes`
    : "its transcript and attachments";
  return `${live ? "Stops it and removes" : "Removes"} ${removed}. This can't be undone.`;
}
