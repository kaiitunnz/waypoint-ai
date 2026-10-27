import { TranscriptRow } from "./transcript";

export interface ChatExchange {
  id: string;
  prompt?: TranscriptRow;
  rows: TranscriptRow[];
  // The first exchange after activity that isn't loaded.
  afterGap?: boolean;
}

// Raycast lays out the side panel's markdown again on every render, so the preview collapses oversized messages.
export const previewMessageLimit = 4000;

// The fence a markdown snippet leaves open, if any.
function openFence(text: string) {
  let open: string | undefined;
  for (const [, marker] of text.matchAll(/^ {0,3}(`{3,}|~{3,})/gm)) {
    if (!open) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = undefined;
  }
  return open;
}

function clip(text: string, limit?: number, markdown = false) {
  if (limit === undefined || text.length <= limit) return text;
  const shown = text.slice(0, limit);
  // An unclosed fence would swallow the rest of the preview.
  const fence = markdown ? openFence(shown) : undefined;
  return fence ? `${shown}\n${fence}` : shown;
}
const more = (text: string, limit?: number) =>
  limit !== undefined && text.length > limit
    ? `\n\n_… ${(text.length - limit).toLocaleString("en-US")} more characters. Read Conversation at Full Width to see all of it._`
    : "";

const plainText = (text: string) =>
  text.replace(/[&\\`*_{}[\]()<>#+.!|~-]/g, (character) => `&#${character.charCodeAt(0)};`);

// Activity resuming after each of `gaps` starts its own exchange rather than answering an earlier prompt.
export function chatExchanges(rows: TranscriptRow[], gaps: number[] = []): ChatExchange[] {
  const exchanges: ChatExchange[] = [];
  let next = 0;
  for (const row of rows) {
    const afterGap = next < gaps.length && row.sequence >= gaps[next];
    while (next < gaps.length && row.sequence >= gaps[next]) next++;
    if (row.kind === "user" || !exchanges.length || afterGap)
      exchanges.push({
        id: row.id,
        prompt: row.kind === "user" ? row : undefined,
        rows: [],
        ...(afterGap && exchanges.length ? { afterGap } : {}),
      });
    if (row.kind !== "user") exchanges.at(-1)!.rows.push(row);
  }
  return exchanges;
}

export function chatMarkdown(
  exchange: ChatExchange | undefined,
  showActivity = false,
  waiting = true,
  limit?: number,
): string {
  if (!exchange) return "";
  const parts: string[] = [];
  if (exchange.prompt) {
    parts.push(
      `**You**\n\n${plainText(clip(exchange.prompt.text, limit))
        .split("\n")
        // Trailing spaces make hard breaks, so multiline prompts keep their lines inside the quote.
        .map((line) => `> ${line}  `)
        .join("\n")}${more(exchange.prompt.text, limit)}`,
    );
    parts.push("---");
  }
  let assistant = false;
  const activity = exchange.rows.filter((row) => row.kind === "tool");
  for (const row of exchange.rows) {
    if (row.kind === "assistant") {
      if (!assistant) parts.push("**Waypoint**");
      parts.push(row.text ? `${clip(row.text, limit, true)}${more(row.text, limit)}` : "_Thinking…_");
      assistant = true;
    } else if (row.kind === "approval") {
      parts.push(`### Approval request\n\n${clip(row.text, limit, true)}${more(row.text, limit)}`);
    } else if (showActivity) {
      parts.push(
        `**${plainText(row.title)}**\n\n${row.kind === "tool" ? `\`\`\`text\n${clip(row.text, limit).replaceAll("```", "` ` `")}\n\`\`\`` : clip(row.text, limit, true)}${more(row.text, limit)}`,
      );
    }
  }
  if (waiting && !assistant && !exchange.rows.some((row) => row.kind === "approval"))
    parts.push("**Waypoint**\n\n_Waiting for a response…_");
  if (activity.length && !showActivity)
    parts.push(`---\n\n_${activity.length} ${activity.length === 1 ? "activity item" : "activity items"}_`);
  return parts.join("\n\n");
}

export function conversationMarkdown(
  exchanges: ChatExchange[],
  showActivity = false,
  waiting = false,
  limit?: number,
): string {
  return exchanges
    .map((exchange, index) =>
      [
        exchange.afterGap ? "_Earlier activity isn't loaded._" : "",
        chatMarkdown(exchange, showActivity, waiting && index === exchanges.length - 1, limit),
      ]
        .filter(Boolean)
        .join("\n\n---\n\n"),
    )
    .filter(Boolean)
    .join("\n\n---\n\n");
}
