import { isRecord } from "../domain/connections";

export interface Session {
  id: string;
  backend: string;
  transport: string;
  source: string;
  title: string;
  cwd: string;
  repository?: string;
  branch?: string;
  status: string;
  pinnedAt?: string;
  lastEventAt: string;
  model?: string;
  context?: { used: number; limit?: number };
  tokens?: number;
  rateLimits: { label: string; percent: number }[];
  usageStale: boolean;
}

export interface SessionEvent {
  id?: number;
  sessionId: string;
  sequence: number;
  timestamp: string;
  kind: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface PendingQuestions {
  sequence: number;
  revision: number;
  questions: { id: string; event: SessionEvent; availability: string }[];
}

export interface EventsPage {
  events: SessionEvent[];
  hasMore: boolean;
  questions?: PendingQuestions;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid session field");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid session collection");
  return value;
}

export function parseSession(value: unknown): Session {
  if (!isRecord(value)) throw new Error("Invalid session");
  const context = isRecord(value.context_usage) ? value.context_usage : undefined;
  const usage = isRecord(value.session_token_usage) ? value.session_token_usage : undefined;
  const limits = isRecord(value.rate_limit_usage) ? value.rate_limit_usage : undefined;
  const used = number(context?.used_tokens);
  return {
    id: text(value.id),
    backend: text(value.backend),
    transport: text(value.transport),
    source: text(value.source),
    title: text(value.title),
    cwd: text(value.cwd),
    repository: optionalText(value.repo_name),
    branch: optionalText(value.branch),
    status: text(value.status),
    pinnedAt: optionalText(value.pinned_at),
    lastEventAt: text(value.last_event_at ?? value.updated_at),
    model: optionalText(value.resolved_model) ?? optionalText(value.model),
    context: used !== undefined ? { used, limit: number(context?.context_window_tokens) } : undefined,
    tokens: number(usage?.display_total_tokens),
    rateLimits: Array.isArray(limits?.windows)
      ? limits.windows.flatMap((item: unknown) =>
          isRecord(item) && typeof item.label === "string" && number(item.used_percent) !== undefined
            ? [{ label: item.label, percent: number(item.used_percent)! }]
            : [],
        )
      : [],
    usageStale: limits?.stale === true || limits?.unavailable === true,
  };
}

export function parseSessions(value: unknown): Session[] {
  if (!isRecord(value)) throw new Error("Invalid session list");
  return array(value.sessions).map(parseSession);
}

export function parseEvent(value: unknown, sessionId: string): SessionEvent {
  if (
    !isRecord(value) ||
    value.session_id !== sessionId ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    (value.id !== undefined && (!Number.isSafeInteger(value.id) || Number(value.id) < 0))
  )
    throw new Error("Invalid session event");
  const source = isRecord(value.metadata) ? value.metadata : {};
  const metadata: Record<string, unknown> = {};
  for (const key of [
    "item_id",
    "item_type",
    "item_kind",
    "method",
    "tool_name",
    "tool_use_id",
    "approval_id",
    "status",
    "is_error",
    "tool_input",
    "plan",
    "interaction",
    "attachments",
  ]) {
    if (source[key] !== undefined) metadata[key] = source[key];
  }
  return {
    id: number(value.id),
    sessionId,
    sequence: Number(value.sequence),
    timestamp: text(value.ts),
    kind: text(value.kind),
    text: text(value.text),
    metadata,
  };
}

export function parseQuestions(value: unknown, sessionId: string): PendingQuestions {
  if (!isRecord(value) || !Number.isSafeInteger(value.as_of_sequence) || !Number.isSafeInteger(value.revision))
    throw new Error("Invalid pending questions");
  return {
    sequence: Number(value.as_of_sequence),
    revision: Number(value.revision),
    questions: array(value.questions).map((question) => {
      if (!isRecord(question)) throw new Error("Invalid question");
      return {
        id: text(question.tool_use_id),
        event: parseEvent(question.event, sessionId),
        availability: text(question.availability),
      };
    }),
  };
}

export function parseEventsPage(value: unknown, sessionId: string): EventsPage {
  if (!isRecord(value) || typeof value.has_more !== "boolean") throw new Error("Invalid history page");
  return {
    events: array(value.events).map((event) => parseEvent(event, sessionId)),
    hasMore: value.has_more,
    questions: value.pending_questions != null ? parseQuestions(value.pending_questions, sessionId) : undefined,
  };
}
