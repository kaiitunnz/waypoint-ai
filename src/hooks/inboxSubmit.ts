import { ApiError, WaypointClient } from "../api/client";
import { BlockSubmit, InboxItem } from "../api/inbox";
import { holds } from "../domain/inbox";

export type SubmitOutcome =
  | { kind: "saved"; item: InboxItem }
  | { kind: "rejected"; message: string }
  | { kind: "deleted"; message: string }
  | { kind: "expired"; message: string }
  // Waypoint didn't confirm and the item shows it wasn't recorded, so sending again is safe.
  | { kind: "not-saved"; message: string }
  // Neither the submit nor a re-read settled whether it was recorded.
  | { kind: "unknown"; message: string };

const blockGone = "This part of the item is no longer available. Refresh the inbox.";

function failure(error: unknown): SubmitOutcome | undefined {
  if (!(error instanceof ApiError)) return undefined;
  // A missing block leaves the item in place, so only a missing item counts as deleted.
  if (error.kind === "not-found")
    return error.detail === "block"
      ? { kind: "rejected", message: blockGone }
      : { kind: "deleted", message: error.message };
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
    return { kind: "saved", item: await client.answerInboxBlock(token, itemId, blockId, body) };
  } catch (error) {
    const definite = failure(error);
    if (definite) return definite;
  }
  try {
    const item = await client.inboxItem(token, itemId);
    const block = item.blocks.find((entry) => entry.id === blockId);
    if (!block) return { kind: "rejected", message: blockGone };
    return holds(block, body)
      ? { kind: "saved", item }
      : { kind: "not-saved", message: "Waypoint didn't record it. Send again." };
  } catch (error) {
    if (error instanceof ApiError && error.kind === "not-found") return { kind: "deleted", message: error.message };
    return { kind: "unknown", message: "Waypoint didn't confirm it. Check the item, then send again." };
  }
}
