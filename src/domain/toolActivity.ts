import { SessionEvent } from "../api/sessions";
import { isRecord } from "./connections";

export type ToolKind = "command" | "read" | "search" | "edit" | "web" | "agent" | "mcp" | "todo" | "other";

export interface ToolActivity {
  kind: ToolKind;
  label: string;
  target?: string;
  // Every file an edit reports; one Codex file change can add, delete, and update several.
  files?: string[];
  additions?: number;
  deletions?: number;
  error: boolean;
}

const kindsByName: Record<string, ToolKind> = {
  bash: "command",
  read: "read",
  grep: "search",
  glob: "search",
  list: "search",
  edit: "edit",
  write: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  patch: "edit",
  apply_patch: "edit",
  webfetch: "web",
  websearch: "web",
  task: "agent",
  agent: "agent",
  subagent: "agent",
  spawnagent: "agent",
  closeagent: "agent",
  wait: "agent",
  todowrite: "todo",
};

// Codex reports no tool_name on its streamed deltas, so its item type is the reliable signal.
const kindsByItemType: Record<string, ToolKind> = {
  commandexecution: "command",
  filechange: "edit",
  mcptoolcall: "mcp",
  websearch: "web",
  collabagenttoolcall: "agent",
  subagentactivity: "agent",
  todo_list: "todo",
};

const targetKeys = ["command", "file_path", "filePath", "notebook_path", "path", "pattern", "glob", "url", "query"];

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function kindOf(name: string, itemType: string): ToolKind {
  if (name.startsWith("mcp__") || name.includes(":")) return "mcp";
  return kindsByName[name.toLocaleLowerCase()] ?? kindsByItemType[itemType.toLocaleLowerCase()] ?? "other";
}

// Every backend spells the same argument differently; first match wins.
function targetFrom(args: Record<string, unknown>): string | undefined {
  for (const key of targetKeys) if (string(args[key])) return string(args[key]);
  return undefined;
}

// The last resort for a backend that reports only flat text: "Bash(git status)\nRunning…" or "Read\n{json}".
function targetFromText(text: string): string | undefined {
  const [head = "", ...rest] = text.split("\n");
  const call = /^[A-Za-z_][\w:.-]*\((.+)\)$/.exec(head.trim());
  if (call) return call[1];
  const body = rest.join("\n").trim();
  if (!body.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? targetFrom(parsed) : undefined;
  } catch {
    return undefined;
  }
}

// A logical call can arrive as several events: a call plus a result, an OpenCode pending/running pair,
// or a Claude diff-preview result alongside the real one. They are classified together.
export function toolActivity(events: SessionEvent[], text: string): ToolActivity {
  const named = events.find((event) => !!string(event.metadata.tool_name));
  const typed = events.find((event) => !!string(event.metadata.item_type));
  const name = string(named?.metadata.tool_name) || string(typed?.metadata.tool_name);
  const kind = kindOf(name, string(typed?.metadata.item_type));
  const item = events.map((event) => record(record(event.metadata.payload)?.item)).find(Boolean);
  const args = events
    .map((event) => record(record(event.metadata.payload)?.input) ?? record(event.metadata.tool_input))
    .find(Boolean);
  const changes = item && Array.isArray(item.changes) ? item.changes : [];
  const changePaths = changes.map((change) => string(record(change)?.path)).filter(Boolean);
  const fromItem =
    (item ? string(item.command) : "") ||
    changePaths[0] ||
    (item ? [string(item.server), string(item.tool)].filter(Boolean).join(":") : "");
  const preview = events.map((event) => record(event.metadata.diff_preview)).find(Boolean);
  const filediff = events.map((event) => record(record(event.metadata.payload)?.filediff)).find(Boolean);
  const previewPaths = (Array.isArray(preview?.files) ? preview.files : [])
    .map((file) => string(record(file)?.path))
    .filter(Boolean);
  const target = (args && targetFrom(args)) || fromItem || targetFromText(text) || undefined;
  const files = [...new Set([...previewPaths, ...changePaths, string(filediff?.path), target ?? ""])].filter(Boolean);
  return {
    kind,
    label: name || (kind === "other" ? "Tool" : kind),
    target,
    files: kind === "edit" && files.length ? files : undefined,
    additions: kind === "edit" ? (integer(preview?.totalAdditions) ?? integer(filediff?.additions)) : undefined,
    deletions: kind === "edit" ? (integer(preview?.totalDeletions) ?? integer(filediff?.deletions)) : undefined,
    error: events.some((event) => event.metadata.is_error === true),
  };
}

const clauseOrder: ToolKind[] = ["command", "read", "search", "edit", "web", "agent", "mcp", "todo", "other"];
const nouns: Record<ToolKind, [string, string]> = {
  command: ["command", "commands"],
  read: ["file read", "files read"],
  search: ["search", "searches"],
  edit: ["file edited", "files edited"],
  web: ["fetch", "fetches"],
  agent: ["agent", "agents"],
  mcp: ["MCP tool", "MCP tools"],
  todo: ["todo update", "todo updates"],
  other: ["tool call", "tool calls"],
};

// Reads and edits count distinct files, so two edits to one file read as one file; a call that names
// no file still counts once. Other kinds count calls.
function distinct(kind: ToolKind, activities: ToolActivity[]): number {
  const of = activities.filter((activity) => activity.kind === kind);
  if (kind !== "read" && kind !== "edit") return of.length;
  const named = new Set<string>();
  let unnamed = 0;
  for (const activity of of) {
    const files = activity.files ?? (activity.target ? [activity.target] : []);
    if (files.length) files.forEach((file) => named.add(file));
    else unnamed++;
  }
  return named.size + unnamed;
}

export function summarizeRun(activities: ToolActivity[]): string {
  if (!activities.length) return "";
  const clauses = clauseOrder.flatMap((kind) => {
    const count = distinct(kind, activities);
    if (!count) return [];
    const noun = nouns[kind][count === 1 ? 0 : 1];
    if (kind !== "edit") return [`${count} ${noun}`];
    const additions = activities.reduce((total, activity) => total + (activity.additions ?? 0), 0);
    const deletions = activities.reduce((total, activity) => total + (activity.deletions ?? 0), 0);
    const stat = activities.some((activity) => activity.additions !== undefined)
      ? ` (+${additions} −${deletions})`
      : "";
    return [`${count} ${noun}${stat}`];
  });
  return clauses.join(" · ");
}
