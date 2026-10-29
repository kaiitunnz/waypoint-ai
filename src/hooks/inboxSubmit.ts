import { ApiError, WaypointClient } from "../api/client";
import { InboxBlock, InboxItem } from "../api/inbox";

export interface BlockSubmit {
  answer?: { selected: string[]; other: string | null } | { decision: string };
  reply?: { notes: string | null; attachments: { session_id: string; attachment_id: string }[] };
}
export type SubmitOutcome =
  | { kind: "saved"; item: InboxItem }
  | { kind: "rejected"; message: string }
  | { kind: "deleted"; message: string }
  | { kind: "expired"; message: string }
  // Waypoint didn't confirm and the item shows it wasn't recorded, so sending again is safe.
  | { kind: "not-saved"; message: string }
  // Neither the submit nor a re-read settled whether it was recorded.
  | { kind: "unknown"; message: string };

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((value) => b.includes(value));

// Whether the item already holds what was sent: the answer, and the reply's notes and new attachments.
export function holds(block: InboxBlock, body: BlockSubmit): boolean {
  if (body.answer) {
    if ("decision" in body.answer) {
      if (block.type !== "approval" || block.answer?.decision !== body.answer.decision) return false;
    } else if (
      block.type !== "question" ||
      !block.answer ||
      !sameSet(block.answer.selected, body.answer.selected) ||
      (block.answer.other ?? null) !== body.answer.other
    )
      return false;
  }
  if (body.reply) {
    if (!block.reply || (block.reply.notes ?? null) !== body.reply.notes) return false;
    const held = block.reply.attachments.map((ref) => ref.attachmentId);
    if (!body.reply.attachments.every((ref) => held.includes(ref.attachment_id))) return false;
  }
  return true;
}

function failure(error: unknown): SubmitOutcome | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.kind === "not-found") return { kind: "deleted", message: error.message };
  if (error.kind === "expired-token") return { kind: "expired", message: error.message };
  if (error.kind === "rejected") return { kind: "rejected", message: error.message };
  return undefined;
}

// Answers and replies overwrite on Waypoint, so an unconfirmed submit is settled by reading the item back.
export async function submitBlock(
  client: WaypointClient,
  token: string,
  itemId: string,
  blockId: string,
  body: BlockSubmit,
): Promise<SubmitOutcome> {
  try {
    return { kind: "saved", item: await client.answerInboxBlock(token, itemId, blockId, { ...body }) };
  } catch (error) {
    const definite = failure(error);
    if (definite) return definite;
  }
  try {
    const item = await client.inboxItem(token, itemId);
    const block = item.blocks.find((entry) => entry.id === blockId);
    if (!block) return { kind: "deleted", message: "This part of the item is no longer available. Refresh the inbox." };
    return holds(block, body)
      ? { kind: "saved", item }
      : { kind: "not-saved", message: "Waypoint didn't record it. Send again." };
  } catch (error) {
    if (error instanceof ApiError && error.kind === "not-found") return { kind: "deleted", message: error.message };
    return { kind: "unknown", message: "Waypoint didn't confirm it. Check the item, then send again." };
  }
}
