import { TranscriptRow } from "./transcript";

export interface ChatExchange {
  id: string;
  prompt?: TranscriptRow;
  rows: TranscriptRow[];
}

const plainText = (text: string) =>
  text.replace(/[&\\`*_{}[\]()<>#+.!|~-]/g, (character) => `&#${character.charCodeAt(0)};`);

export function chatExchanges(rows: TranscriptRow[]): ChatExchange[] {
  const exchanges: ChatExchange[] = [];
  for (const row of rows) {
    if (row.kind === "user" || !exchanges.length)
      exchanges.push({ id: row.id, prompt: row.kind === "user" ? row : undefined, rows: [] });
    if (row.kind !== "user") exchanges.at(-1)!.rows.push(row);
  }
  return exchanges;
}

export function chatMarkdown(exchange: ChatExchange | undefined, showActivity = false, waiting = true): string {
  if (!exchange) return "";
  const parts: string[] = [];
  if (exchange.prompt) {
    parts.push(
      `**You**\n\n${plainText(exchange.prompt.text)
        .split("\n")
        // Trailing spaces make hard breaks, so multiline prompts keep their lines inside the quote.
        .map((line) => `> ${line}  `)
        .join("\n")}`,
    );
    parts.push("---");
  }
  let assistant = false;
  const activity = exchange.rows.filter((row) => row.kind === "tool");
  for (const row of exchange.rows) {
    if (row.kind === "assistant") {
      if (!assistant) parts.push("**Waypoint**");
      parts.push(row.text || "_Thinking…_");
      assistant = true;
    } else if (row.kind === "approval") {
      parts.push(`### Approval request\n\n${row.text}`);
    } else if (showActivity) {
      parts.push(
        `**${plainText(row.title)}**\n\n${row.kind === "tool" ? `\`\`\`text\n${row.text.replaceAll("```", "` ` `")}\n\`\`\`` : row.text}`,
      );
    }
  }
  if (waiting && !assistant && !exchange.rows.some((row) => row.kind === "approval"))
    parts.push("**Waypoint**\n\n_Waiting for a response…_");
  if (activity.length && !showActivity)
    parts.push(`---\n\n_${activity.length} ${activity.length === 1 ? "activity item" : "activity items"}_`);
  return parts.join("\n\n");
}

export function conversationMarkdown(exchanges: ChatExchange[], showActivity = false, waiting = false): string {
  return exchanges
    .map((exchange, index) => chatMarkdown(exchange, showActivity, waiting && index === exchanges.length - 1))
    .filter(Boolean)
    .join("\n\n---\n\n");
}
