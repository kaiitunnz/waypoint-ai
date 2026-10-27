import { TranscriptRow } from "./transcript";
import { ToolActivity, summarizeRun, toolActivity } from "./toolActivity";

// A run of consecutive tool calls, collapsed to one summary line.
export interface ToolRun {
  id: string;
  rows: TranscriptRow[];
  activities: ToolActivity[];
  summary: string;
}

export type ExchangeEntry = { run: ToolRun } | { row: TranscriptRow };

export function entryId(entry: ExchangeEntry): string {
  return "run" in entry ? entry.run.id : entry.row.id;
}

export function entryKind(entry: ExchangeEntry): TranscriptRow["kind"] {
  return "run" in entry ? "tool" : entry.row.kind;
}

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

// Tools that carry their own card rather than folding into a run.
const standaloneTools = new Set(["askuserquestion", "senduserfile"]);

function isStandalone(row: TranscriptRow) {
  return (row.sources ?? []).some((event) => {
    const name = event.metadata.tool_name;
    return typeof name === "string" && standaloneTools.has(name.toLocaleLowerCase());
  });
}

// A run is a contiguous stretch of tool rows. Assistant text, a user turn, a plan, and an approval
// all break it; lifecycle notes fold in silently, as they do in Waypoint's own transcript.
export function groupRuns(rows: TranscriptRow[]): ExchangeEntry[] {
  const entries: ExchangeEntry[] = [];
  const run = { rows: [] as TranscriptRow[], activities: [] as ToolActivity[] };
  const flush = () => {
    if (!run.rows.length) return;
    entries.push({
      run: {
        id: `run:${run.rows[0].id}`,
        rows: run.rows,
        activities: run.activities,
        summary: summarizeRun(run.activities),
      },
    });
    run.rows = [];
    run.activities = [];
  };
  for (const row of rows) {
    if (row.kind === "tool" && !isStandalone(row)) {
      run.rows.push(row);
      run.activities.push(toolActivity(row.sources ?? [], row.text));
      continue;
    }
    // A quiet note joins the run it sits inside; outside one it stands alone.
    if (row.kind === "note" && run.rows.length) {
      run.rows.push(row);
      continue;
    }
    flush();
    entries.push({ row });
  }
  flush();
  return entries;
}

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

// Expanded, each call in a run shows its own target and change counts above its output.
export function runMarkdown(run: ToolRun, limit?: number): string {
  return [`**${run.summary}**`, ...run.rows.map((row) => runRowMarkdown(row, limit))].join("\n\n");
}

function runRowMarkdown(row: TranscriptRow, limit?: number): string {
  if (row.kind === "tool") return toolMarkdown(row, limit);
  // A note folded into the run is context, not a call.
  return `_${plainText(row.text)}_${more(row.text, limit)}`;
}

export function runCallCount(run: ToolRun): number {
  return run.rows.filter((row) => row.kind === "tool").length;
}

export function toolMarkdown(row: TranscriptRow, limit?: number): string {
  const activity = toolActivity(row.sources ?? [], row.text);
  const facts = [
    activity.target,
    activity.additions !== undefined ? `+${activity.additions} −${activity.deletions}` : "",
  ]
    .filter(Boolean)
    .map((line) => plainText(line!))
    .join(" · ");
  const body = `\`\`\`text\n${clip(row.text, limit).replaceAll("```", "` ` `")}\n\`\`\``;
  return `### ${plainText(row.title)}${facts ? `\n\n${facts}` : ""}\n\n${body}${more(row.text, limit)}`;
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
  for (const entry of groupRuns(exchange.rows)) {
    if ("run" in entry) {
      if (!entry.run.summary) continue;
      // The summary is built from counts and nouns, so it needs no escaping.
      parts.push(showActivity ? runMarkdown(entry.run, limit) : `_${entry.run.summary}_`);
      continue;
    }
    const row = entry.row;
    if (row.kind === "assistant") {
      if (!assistant) parts.push("**Waypoint**");
      parts.push(row.text ? `${clip(row.text, limit, true)}${more(row.text, limit)}` : "_Thinking…_");
      assistant = true;
    } else if (row.kind === "approval") {
      parts.push(`### Approval request\n\n${clip(row.text, limit, true)}${more(row.text, limit)}`);
    } else if (showActivity) {
      parts.push(`**${plainText(row.title)}**\n\n${clip(row.text, limit, true)}${more(row.text, limit)}`);
    }
  }
  if (waiting && !assistant && !exchange.rows.some((row) => row.kind === "approval"))
    parts.push("**Waypoint**\n\n_Waiting for a response…_");
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
