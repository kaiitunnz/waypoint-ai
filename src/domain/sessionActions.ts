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

export function titleProblem(title: string): string | undefined {
  const value = title.trim();
  if (!value) return "Enter a title.";
  if (value.length > maxTitleLength) return `Use ${maxTitleLength} characters or fewer.`;
  return undefined;
}

export const terminateMessage = "Any running command is stopped and pending requests are declined.";
export function deleteMessage(session: Session): string {
  return session.worktreePath
    ? `Its transcript, attachments, scheduled messages, board posts, and any manager backlog it owns are removed, and so is its worktree at ${session.worktreePath}, including uncommitted changes, with the worktree's branch if it is merged. This cannot be undone.`
    : "Its transcript, attachments, scheduled messages, board posts, and any manager backlog it owns are removed. This cannot be undone.";
}
