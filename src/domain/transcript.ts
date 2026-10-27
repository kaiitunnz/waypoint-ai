import { SessionEvent, PendingQuestions } from "../api/sessions";
import { isRecord } from "./connections";

export interface TranscriptRow {
  id: string;
  kind: "user" | "assistant" | "reasoning" | "tool" | "approval" | "note";
  title: string;
  text: string;
  timestamp: string;
  sequence: number;
  // The events a tool row merged, kept so tool activity can be classified from structured fields.
  sources?: SessionEvent[];
}

export function mergeEvents(current: SessionEvent[], incoming: SessionEvent[], sessionId: string): SessionEvent[] {
  const ids = new Set<number>();
  const sequences = new Set<number>();
  return [...current, ...incoming]
    .filter((event) => {
      if (
        event.sessionId !== sessionId ||
        sequences.has(event.sequence) ||
        (event.id !== undefined && ids.has(event.id))
      )
        return false;
      sequences.add(event.sequence);
      if (event.id !== undefined) ids.add(event.id);
      return true;
    })
    .sort((a, b) => a.sequence - b.sequence || (a.id ?? 0) - (b.id ?? 0));
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}
const deltas = new Set(["item/commandExecution/outputDelta", "item/fileChange/outputDelta"]);

function withAttachments(event: SessionEvent) {
  const names = Array.isArray(event.metadata.attachments)
    ? event.metadata.attachments.flatMap((item) =>
        isRecord(item) && typeof item.filename === "string" ? [item.filename] : [],
      )
    : [];
  return names.length ? [event.text, `Attached: ${names.join(", ")}`].filter(Boolean).join("\n\n") : event.text;
}

export function transcript(events: SessionEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const messages = new Map<string, TranscriptRow>();
  const tools = new Map<
    string,
    { row: TranscriptRow; call: string; output: string; streamed: boolean; sources: SessionEvent[] }
  >();
  for (const event of events) {
    if (event.kind === "raw_terminal_chunk") continue;
    const item = string(event.metadata.item_id);
    const eventKey = `sequence:${event.sequence}`;
    const plan = isRecord(event.metadata.plan) ? event.metadata.plan : undefined;
    const approvalInput =
      event.kind === "approval_request" &&
      event.metadata.tool_name === "ExitPlanMode" &&
      isRecord(event.metadata.tool_input)
        ? event.metadata.tool_input
        : undefined;
    const planText = string(plan?.text).trim() || string(approvalInput?.plan).trim();
    if (planText) {
      const approval = event.kind === "approval_request";
      const key = `${approval ? "plan-approval" : "plan"}:${string(plan?.id) || string(event.metadata.approval_id) || item || eventKey}`;
      const existing = messages.get(key);
      if (existing) {
        existing.text = planText;
        existing.sequence = event.sequence;
        existing.timestamp = event.timestamp;
      } else {
        const row: TranscriptRow = {
          id: key,
          kind: approval ? "approval" : "assistant",
          title: approval ? "Plan approval request" : "Plan",
          text: planText,
          timestamp: event.timestamp,
          sequence: event.sequence,
        };
        messages.set(key, row);
        rows.push(row);
      }
      continue;
    }

    if (event.kind === "tool_call" || event.kind === "tool_result") {
      const key = item ? `tool:${item}` : eventKey;
      let tool = tools.get(key);
      if (!tool) {
        const row: TranscriptRow = {
          id: key,
          kind: "tool",
          title: string(event.metadata.tool_name) || "Tool activity",
          text: "",
          timestamp: event.timestamp,
          sequence: event.sequence,
        };
        tool = { row, call: "", output: "", streamed: false, sources: [] };
        tools.set(key, tool);
        rows.push(row);
      }
      tool.sources.push(event);
      if (event.kind === "tool_call") {
        tool.call = event.text || JSON.stringify(event.metadata.tool_input ?? "");
        if (event.metadata.tool_name) tool.row.title = string(event.metadata.tool_name);
      } else {
        const delta = deltas.has(string(event.metadata.method));
        if (event.metadata.item_type === "todo_list") tool.output = event.text || tool.output;
        else if (delta) tool.output += event.text;
        else if (!tool.streamed)
          tool.output =
            !tool.output || tool.output === event.text ? event.text || tool.output : `${tool.output}\n${event.text}`;
        else if (!tool.output) tool.output = event.text;
        tool.streamed ||= delta;
      }
      tool.row.sources = tool.sources;
      tool.row.text = [tool.call, tool.output].filter(Boolean).join("\n\n");
      if (event.metadata.is_error === true) tool.row.title = `${tool.row.title} · Error`;
      continue;
    }
    const kind: TranscriptRow["kind"] =
      event.kind === "user_input"
        ? "user"
        : event.kind === "agent_output"
          ? ["reasoning", "progress"].includes(string(event.metadata.item_kind))
            ? "reasoning"
            : "assistant"
          : event.kind === "approval_request"
            ? "approval"
            : "note";
    if (event.kind === "status_update" && !event.text) continue;
    const key = event.kind === "agent_output" && item ? `${kind}:${item}` : eventKey;
    const existing = messages.get(key);
    if (existing) {
      existing.text += event.text;
      continue;
    }
    const row: TranscriptRow = {
      id: key,
      kind,
      title:
        kind === "user"
          ? "You"
          : kind === "assistant"
            ? "Assistant"
            : kind === "reasoning"
              ? "Thinking"
              : kind === "approval"
                ? "Approval request"
                : "Session update",
      text: kind === "user" ? withAttachments(event) : event.text,
      timestamp: event.timestamp,
      sequence: event.sequence,
    };
    rows.push(row);
    messages.set(key, row);
  }
  return rows.sort((a, b) => a.sequence - b.sequence);
}

export function newerQuestions(current: PendingQuestions | undefined, next: PendingQuestions): PendingQuestions {
  return !current ||
    next.sequence > current.sequence ||
    (next.sequence === current.sequence && next.revision >= current.revision)
    ? next
    : current;
}

// Entries may be a single row or a collapsed tool run, so both are addressed by id.
export function selectedRow(
  entries: { id: string; kind?: TranscriptRow["kind"] }[],
  previousId: string | undefined,
  following: boolean,
): string | undefined {
  if (following) return entries.findLast((entry) => entry.kind === "assistant")?.id ?? entries.at(-1)?.id;
  return entries.some((entry) => entry.id === previousId) ? previousId : entries.at(-1)?.id;
}
