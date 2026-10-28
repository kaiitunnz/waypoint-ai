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
// Thinking stays one line until activity is shown, as Waypoint collapses it: bold markers stripped, whitespace
// collapsed, and the first 140 characters kept.
export function thinkingPreview(text: string, max = 140): string {
  const collapsed = text
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

// Names the action that shows a clipped message whole; the chat views read it at full width.
const fullWidth = "Read Conversation at Full Width";
const more = (text: string, limit?: number, fullView = fullWidth) =>
  limit !== undefined && text.length > limit
    ? `\n\n_… ${(text.length - limit).toLocaleString("en-US")} more characters. ${fullView} to see all of it._`
    : "";

// Raycast links URLs from the raw markdown, so an escape inside or right after one shows in the link. A preview
// is one line that never starts a block, so it escapes only inline markers, and none inside a URL.
const inlineText = (text: string) =>
  text
    .split(/(https?:\/\/[^\s<>]*[^\s<>.,;:!?)])/)
    .map((part, index) => (index % 2 ? part : part.replace(/[\\`*_[\]<>~&]/g, "\\$&")))
    .join("");

const plainText = (text: string) =>
  text.replace(/[&\\`*_{}[\]()<>#+.!|~-]/g, (character) => `&#${character.charCodeAt(0)};`);

// Tools that stand on their own rather than folding into a run, with the line the collapsed chat shows.
const standaloneTools: Record<string, string> = {
  askuserquestion: "Asked a question",
  senduserfile: "Shared a file",
};

function standaloneLine(row: TranscriptRow): string | undefined {
  for (const event of row.sources ?? []) {
    const name = event.metadata.tool_name;
    if (typeof name === "string" && standaloneTools[name.toLocaleLowerCase()])
      return standaloneTools[name.toLocaleLowerCase()];
  }
  return undefined;
}

// A run is a contiguous stretch of tool rows, matching Waypoint's own transcript. Assistant text, thinking,
// a user turn, a plan, and an approval all break it. Lifecycle notes between two calls fold into the run;
// after a run's last call they stay their own rows.
export function groupRuns(rows: TranscriptRow[]): ExchangeEntry[] {
  const entries: ExchangeEntry[] = [];
  const run = { rows: [] as TranscriptRow[], activities: [] as ToolActivity[] };
  let held: TranscriptRow[] = [];
  const flush = () => {
    if (run.rows.length)
      entries.push({
        run: {
          id: `run:${run.rows[0].id}`,
          rows: run.rows,
          activities: run.activities,
          summary: summarizeRun(run.activities),
        },
      });
    entries.push(...held.map((row) => ({ row })));
    run.rows = [];
    run.activities = [];
    held = [];
  };
  for (const row of rows) {
    if (row.kind === "tool" && !standaloneLine(row)) {
      run.rows.push(...held, row);
      held = [];
      run.activities.push(toolActivity(row.sources ?? [], row.text));
      continue;
    }
    if (row.kind === "note" && run.rows.length) {
      held.push(row);
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

// Marks collapsed tool activity, so it stands apart from thinking and notes, which are also italic.
const toolMarker = "▸";

// Expanded, each call in a run shows its own target and change counts above its output.
export function runMarkdown(run: ToolRun, limit?: number, fullView = fullWidth): string {
  return [`**${run.summary}**`, ...run.rows.map((row) => runRowMarkdown(row, limit, fullView))].join("\n\n");
}

function runRowMarkdown(row: TranscriptRow, limit?: number, fullView = fullWidth): string {
  return row.kind === "tool" ? toolMarkdown(row, limit, fullView) : activityMarkdown(row, limit, fullView);
}

function activityMarkdown(row: TranscriptRow, limit?: number, fullView = fullWidth): string {
  return `**${plainText(row.title)}**\n\n${clip(row.text, limit, true)}${more(row.text, limit, fullView)}`;
}

// A run is named after its first row, which loading earlier history can change; a selection that no longer
// names an entry moves to the entry now holding the row it started from.
export function resolveEntryId(entries: ExchangeEntry[], id: string | undefined): string | undefined {
  if (!id || entries.some((entry) => entryId(entry) === id)) return id;
  const rowId = id.startsWith("run:") ? id.slice("run:".length) : id;
  const holder = entries.find((entry) =>
    "run" in entry ? entry.run.rows.some((row) => row.id === rowId) : entry.row.id === rowId,
  );
  return holder ? entryId(holder) : id;
}

export function runCallCount(run: ToolRun): number {
  return run.rows.filter((row) => row.kind === "tool").length;
}

export function toolMarkdown(row: TranscriptRow, limit?: number, fullView = fullWidth): string {
  const activity = toolActivity(row.sources ?? [], row.text);
  const facts = [
    activity.files?.join(", ") ?? activity.target,
    activity.additions !== undefined ? `+${activity.additions} −${activity.deletions}` : "",
  ]
    .filter(Boolean)
    .map((line) => plainText(line!))
    .join(" · ");
  const body = `\`\`\`text\n${clip(row.text, limit).replaceAll("```", "` ` `")}\n\`\`\``;
  return `### ${plainText(row.title)}${facts ? `\n\n${facts}` : ""}\n\n${body}${more(row.text, limit, fullView)}`;
}

// Trailing spaces make hard breaks, so multiline prompts keep their lines inside the quote.
const promptMarkdown = (prompt: TranscriptRow, limit?: number, footer = more(prompt.text, limit)) =>
  `**You**\n\n${plainText(clip(prompt.text, limit))
    .split("\n")
    .map((line) => `> ${line}  `)
    .join("\n")}${footer}`;

export function chatMarkdown(
  exchange: ChatExchange | undefined,
  showActivity = false,
  waiting = true,
  limit?: number,
): string {
  if (!exchange) return "";
  const parts: string[] = [];
  if (exchange.prompt) {
    parts.push(promptMarkdown(exchange.prompt, limit));
    parts.push("---");
  }
  let assistant = false;
  for (const entry of groupRuns(exchange.rows)) {
    if ("run" in entry) {
      if (!entry.run.summary) continue;
      // The summary is built from counts and nouns, so it needs no escaping.
      parts.push(showActivity ? runMarkdown(entry.run, limit) : `${toolMarker} _${entry.run.summary}_`);
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
      // A tool with its own card is still a call, so its text stays fenced.
      parts.push(row.kind === "tool" ? toolMarkdown(row, limit) : activityMarkdown(row, limit));
    } else if (row.kind === "tool") {
      parts.push(`${toolMarker} _${standaloneLine(row) ?? plainText(row.title)}_`);
    } else if (row.kind === "reasoning") {
      const preview = thinkingPreview(row.text);
      parts.push(`_${plainText(row.title)}${preview ? ` · ${inlineText(preview)}` : ""}_`);
    }
  }
  if (waiting && !assistant && !exchange.rows.some((row) => row.kind === "approval"))
    parts.push("**Waypoint**\n\n_Waiting for a response…_");
  return parts.join("\n\n");
}

// One exchange as the conversation shows it, including the note that activity before it isn't loaded.
export function turnMarkdown(exchange: ChatExchange, showActivity = false, waiting = false, limit?: number): string {
  return [
    exchange.afterGap ? "_Earlier activity isn't loaded._" : "",
    chatMarkdown(exchange, showActivity, waiting, limit),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function conversationMarkdown(
  exchanges: ChatExchange[],
  showActivity = false,
  waiting = false,
  limit?: number,
): string {
  return exchanges
    .map((exchange, index) => turnMarkdown(exchange, showActivity, waiting && index === exchanges.length - 1, limit))
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function turnTitle(exchange: ChatExchange): string {
  if (!exchange.prompt) return "Activity";
  return (
    exchange.prompt.text
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "Message"
  );
}

export function exchangeResponse(exchange: ChatExchange | undefined): string {
  return (exchange?.rows ?? [])
    .filter((row) => row.kind === "assistant")
    .map((row) => row.text)
    .join("\n\n");
}

const previewLimit = 280;

// Shown on rows other than the selected one, so a selection the chat hasn't caught up with yet never shows an empty
// pane while staying cheap to send on every update.
export function turnPreview(exchange: ChatExchange | undefined): string {
  if (!exchange) return "";
  const reply = exchange.rows.find((row) => row.kind === "assistant" && row.text);
  return (
    [
      exchange.prompt ? promptMarkdown(exchange.prompt, previewLimit, "") : "",
      reply ? `**Waypoint**\n\n${clip(reply.text, previewLimit, true)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n") || `_${plainText(turnTitle(exchange))}_`
  );
}

// An exchange is named after its first row, so loading the page with an "Activity" exchange's prompt merges it into
// that prompt's exchange; a turn id that no longer names one moves to the exchange now holding its row.
export function resolveTurnId(exchanges: ChatExchange[], id: string): string | undefined {
  if (exchanges.some((exchange) => exchange.id === id)) return id;
  return exchanges.find((exchange) => exchange.prompt?.id === id || exchange.rows.some((row) => row.id === id))?.id;
}

export const conversationItem = "conversation";
export const loadEarlierItem = "load-earlier";
export const turnItem = (id: string) => `turn:${id}`;

// `following` keeps the newest turn selected as turns arrive; otherwise `selection` names the chosen row.
export interface ChatSelection {
  following: boolean;
  selection?: string;
}

export interface ChatItems {
  exchanges: ChatExchange[];
  loadEarlier: boolean;
  // Rows listed before the conversation, such as requests that need attention.
  auxiliary: string[];
}

export function chatItemIds(items: ChatItems): string[] {
  return [
    ...items.auxiliary,
    conversationItem,
    ...(items.loadEarlier ? [loadEarlierItem] : []),
    ...items.exchanges.map((exchange) => turnItem(exchange.id)),
  ];
}

export function chatSelectedId(current: ChatSelection, items: ChatItems): string {
  const newest = items.exchanges.at(-1);
  const followed = newest ? turnItem(newest.id) : conversationItem;
  const { selection } = current;
  if (current.following || !selection) return followed;
  if (selection === conversationItem || items.auxiliary.includes(selection)) return selection;
  if (selection === loadEarlierItem)
    return items.loadEarlier ? selection : items.exchanges.length ? turnItem(items.exchanges[0].id) : followed;
  if (selection.startsWith("turn:")) {
    const id = resolveTurnId(items.exchanges, selection.slice("turn:".length));
    if (id) return turnItem(id);
  }
  return followed;
}

export function selectChatItem(id: string, exchanges: ChatExchange[]): ChatSelection {
  const newest = exchanges.at(-1);
  return newest && id === turnItem(newest.id) ? { following: true } : { following: false, selection: id };
}

// Raycast reports the row it shows after every update, including the one the chat chose, so only a different known
// row counts as the user's choice.
export function chatSelectionChange(
  current: ChatSelection,
  id: string | undefined,
  items: ChatItems,
): ChatSelection | undefined {
  if (!id || id === chatSelectedId(current, items) || !chatItemIds(items).includes(id)) return undefined;
  return selectChatItem(id, items.exchanges);
}
