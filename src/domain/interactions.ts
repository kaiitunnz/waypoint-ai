import { createHash } from "node:crypto";
import { ServerMetadata } from "../api/contracts";
import { PendingQuestions, Session, SessionEvent } from "../api/sessions";
import { isRecord } from "./connections";
import { isStructured } from "./sessions";

export const interactionActions = ["approve", "approve-plan", "answer-question", "cancel-question"] as const;
export type InteractionAction = (typeof interactionActions)[number];
export type InteractionKind = "approval" | "plan" | "question";
export type InteractionAvailability = "actionable" | "starting" | "unavailable";
export interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiple: boolean;
}
export interface Interaction {
  key: string;
  id: string;
  kind: InteractionKind;
  title: string;
  text: string;
  event: SessionEvent;
  decisions: string[];
  note: boolean;
  questions?: Question[];
  // Some agents map answers back to questions by position, so every question needs an answer.
  positionalAnswers: boolean;
  availability: InteractionAvailability;
  // Set when only the Waypoint frontend can handle this request.
  reason?: string;
  afterApproval?: boolean;
  signature: string;
}
export interface InteractionDraft {
  decision?: string;
  note?: string;
  selected?: Record<string, string[]>;
  notes?: Record<string, string>;
}
export interface InteractionRequest {
  action: InteractionAction;
  body: Record<string, unknown>;
}

export const isLive = (session: Session) => ["starting", "running", "waiting_input"].includes(session.status);
const approvalDecisions = ["approve", "accept", "acceptForSession", "acceptAlways", "decline", "cancel"];
const planDecisions = ["accept", "acceptForSession", "decline", "cancel"];
// OpenCode splits answers on commas and drops unanswered questions from a positional list, and
// reports a failed upstream permission reply with the same 400 as a request that is not pending.
const positionalAnswerAgents = new Set(["opencode"]);
const lateRejectionAgents = new Set(["opencode"]);
const handoff = {
  transport: "Open this interface in Waypoint.",
  identity: "This request has no stable ID. Open it in Waypoint.",
  decisions: "This agent's decisions are not available here. Open it in Waypoint.",
  shape: "This question format needs Waypoint.",
  labels: "These option labels need Waypoint.",
};

const string = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function approvalId(event: SessionEvent): string {
  return (
    string(event.metadata.approval_id) ||
    (isRecord(event.metadata.approval) ? string(event.metadata.approval.approval_id) : "")
  );
}

function resolution(event: SessionEvent): { id: string } | { oldest: true } | undefined {
  if (event.kind !== "system_note") return;
  if (event.metadata.method === "permission.replied") {
    const payload = isRecord(event.metadata.payload) ? event.metadata.payload : {};
    const id = string(payload.requestID) || string(payload.permissionID) || string(payload.id);
    return id ? { id } : undefined;
  }
  if (
    event.metadata.method !== "approval.invalidated" &&
    !/(Approval response sent|Approval timed out)/i.test(event.text)
  )
    return;
  const id = approvalId(event);
  return id ? { id } : { oldest: true };
}

export function pendingApprovals(events: SessionEvent[]): SessionEvent[] {
  const queue: SessionEvent[] = [];
  for (const event of events) {
    if (event.kind === "approval_request") {
      queue.push(event);
      continue;
    }
    const resolved = resolution(event);
    if (!resolved) continue;
    const index = "id" in resolved ? queue.findIndex((entry) => approvalId(entry) === resolved.id) : 0;
    if (index >= 0) queue.splice(index, 1);
  }
  return queue;
}

function planId(event: SessionEvent): string {
  const payload = isRecord(event.metadata.payload) ? event.metadata.payload : {};
  return (
    (isRecord(event.metadata.plan) ? string(event.metadata.plan.id) : "") ||
    string(event.metadata.item_id) ||
    (isRecord(payload.item) ? string(payload.item.id) : "")
  );
}

function planText(event: SessionEvent): string {
  const payload = isRecord(event.metadata.payload) ? event.metadata.payload : {};
  return (
    (isRecord(event.metadata.plan) ? string(event.metadata.plan.text).trim() : "") ||
    (isRecord(payload.item) ? string(payload.item.text).trim() : "")
  );
}

// Mirrors Waypoint's current-plan lookup: the newest plan item decides the ID, and its text may come
// from an earlier event of the same item when the newest one has none.
export function latestPlan(events: SessionEvent[]) {
  const decided = new Set<string>();
  let latest: { id: string; event: SessionEvent; decisions: string[] } | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.metadata.item_type !== "plan") {
      if (
        typeof event.metadata.plan_item_id === "string" &&
        planDecisions.includes(string(event.metadata.plan_decision))
      )
        decided.add(event.metadata.plan_item_id);
      continue;
    }
    const id = planId(event);
    if (!id || decided.has(id) || (latest && id !== latest.id)) break;
    latest ??= { id, event, decisions: isRecord(event.metadata.plan) ? strings(event.metadata.plan.decisions) : [] };
    const text = planText(event);
    if (text) return { ...latest, text };
  }
  return latest && !decided.has(latest.id) ? { ...latest, text: "" } : undefined;
}

export function plansDecisions(session: Session, metadata: ServerMetadata | undefined): boolean {
  return (
    session.permissionMode === "plan" &&
    metadata?.agents.some((agent) => agent.id === session.backend && agent.planApproval) === true
  );
}

function questionShape(event: SessionEvent): Question[] | undefined {
  const payload = isRecord(event.metadata.payload) ? event.metadata.payload : undefined;
  const input = isRecord(event.metadata.tool_input)
    ? event.metadata.tool_input
    : payload && isRecord(payload.input)
      ? payload.input
      : undefined;
  if (!Array.isArray(input?.questions) || !input.questions.length) return;
  const questions: Question[] = [];
  for (const raw of input.questions) {
    if (
      !isRecord(raw) ||
      typeof raw.question !== "string" ||
      !raw.question.trim() ||
      questions.some((entry) => entry.question === raw.question) ||
      (raw.header !== undefined && raw.header !== null && typeof raw.header !== "string") ||
      (raw.multiSelect !== undefined && typeof raw.multiSelect !== "boolean") ||
      (raw.options !== undefined && !Array.isArray(raw.options))
    )
      return;
    const options: Question["options"] = [];
    for (const option of raw.options ?? []) {
      if (
        !isRecord(option) ||
        typeof option.label !== "string" ||
        !option.label.trim() ||
        options.some((entry) => entry.label === option.label)
      )
        return;
      options.push({
        label: option.label,
        description: typeof option.description === "string" && option.description ? option.description : undefined,
      });
    }
    questions.push({
      question: raw.question,
      header: typeof raw.header === "string" && raw.header ? raw.header : undefined,
      options,
      multiple: raw.multiSelect === true,
    });
  }
  return questions;
}

function finish(value: Omit<Interaction, "signature">): Interaction {
  return {
    ...value,
    signature: createHash("sha256")
      .update(
        JSON.stringify([value.kind, value.id, value.title, value.text, value.questions, value.decisions, value.note]),
      )
      .digest("hex"),
  };
}

function approval(event: SessionEvent, session: Session, metadata: ServerMetadata, structured: boolean) {
  const agent = metadata.agents.find((entry) => entry.id === session.backend);
  const id = approvalId(event);
  const envelope = isRecord(event.metadata.interaction) ? event.metadata.interaction : {};
  const input = isRecord(event.metadata.tool_input) ? event.metadata.tool_input : {};
  const exitPlan = event.metadata.tool_name === "ExitPlanMode";
  const decisions = (agent?.approvalDecisions ?? []).filter(
    (decision, index, all) => approvalDecisions.includes(decision) && all.indexOf(decision) === index,
  );
  const reason = !structured
    ? handoff.transport
    : !id
      ? handoff.identity
      : !decisions.length
        ? handoff.decisions
        : undefined;
  return finish({
    key: `approval:${id || `sequence:${event.sequence}`}`,
    id,
    kind: "approval",
    title: exitPlan ? "Plan approval" : string(envelope.title) || string(event.metadata.tool_name) || "Approval",
    text: (exitPlan && string(input.plan)) || string(envelope.body) || event.text,
    event,
    decisions,
    note: agent?.approvalNote === true,
    positionalAnswers: false,
    availability: reason ? "unavailable" : "actionable",
    reason,
  });
}

// As in Waypoint's web app, approvals and plans are found in the history that has been loaded.
export function sessionInteractions(
  session: Session,
  metadata: ServerMetadata,
  events: SessionEvent[],
  pending?: PendingQuestions,
): Interaction[] {
  const structured = isStructured(session, metadata);
  // Requests outlive their process in history; a stopped session has no live request to answer.
  const approvals = isLive(session) ? pendingApprovals(events) : [];
  const result = approvals.map((event) => approval(event, session, metadata, structured));
  const plan = !approvals.length && structured && plansDecisions(session, metadata) ? latestPlan(events) : undefined;
  if (plan?.text.trim()) {
    const decisions = plan.decisions.length ? plan.decisions.filter((entry) => planDecisions.includes(entry)) : [];
    result.push(
      finish({
        key: `plan:${plan.id}`,
        id: plan.id,
        kind: "plan",
        title: "Plan approval",
        text: plan.text,
        event: plan.event,
        decisions: decisions.length ? decisions : planDecisions,
        note: true,
        positionalAnswers: false,
        availability: "actionable",
      }),
    );
  }
  for (const entry of pending?.questions ?? []) {
    const questions = questionShape(entry.event);
    const positionalAnswers = positionalAnswerAgents.has(session.backend);
    const reason = !structured
      ? handoff.transport
      : !questions
        ? handoff.shape
        : positionalAnswers &&
            questions.some((question) =>
              question.options.some((option) => option.label.includes(",") || option.label !== option.label.trim()),
            )
          ? handoff.labels
          : undefined;
    const availability: InteractionAvailability = reason
      ? "unavailable"
      : entry.availability === "actionable" || entry.availability === "starting"
        ? entry.availability
        : "unavailable";
    result.push(
      finish({
        key: `question:${entry.id}`,
        id: entry.id,
        kind: "question",
        title: questions?.[0].header || "Question",
        text: questions?.map((question) => question.question).join("\n\n") || entry.event.text,
        event: entry.event,
        decisions: [],
        note: true,
        questions,
        positionalAnswers,
        availability,
        reason,
        afterApproval: approvals.length > 0,
      }),
    );
  }
  return result;
}

// Identities of every open request regardless of visibility or eligibility, so drafts survive filtering.
export function openInteractionKeys(events: SessionEvent[], pending?: PendingQuestions): Set<string> {
  const plan = latestPlan(events);
  return new Set([
    ...pendingApprovals(events).map((event) => `approval:${approvalId(event) || `sequence:${event.sequence}`}`),
    ...(plan ? [`plan:${plan.id}`] : []),
    ...(pending?.questions ?? []).map((entry) => `question:${entry.id}`),
  ]);
}

// Every approval and plan request the events show, answered or not. A request missing from here may
// simply be older than the events, so its absence from the open requests proves nothing.
export function requestKeys(events: SessionEvent[]): Set<string> {
  return new Set(
    events.flatMap((event) =>
      event.kind === "approval_request"
        ? [`approval:${approvalId(event) || `sequence:${event.sequence}`}`]
        : event.metadata.item_type === "plan" && planId(event)
          ? [`plan:${planId(event)}`]
          : [],
    ),
  );
}

export function interactionRequest(interaction: Interaction, draft: InteractionDraft): InteractionRequest {
  if (interaction.availability !== "actionable" || interaction.reason || !interaction.id)
    throw new Error("This request is not available here. Refresh it or open it in Waypoint.");
  if (interaction.kind !== "question") {
    if (!draft.decision || !interaction.decisions.includes(draft.decision))
      throw new Error("Choose an available decision.");
    const note = interaction.note ? draft.note?.trim() : undefined;
    return {
      action: interaction.kind === "plan" ? "approve-plan" : "approve",
      body: {
        [interaction.kind === "plan" ? "plan_item_id" : "approval_id"]: interaction.id,
        decision: draft.decision,
        ...(note ? { text: note } : {}),
      },
    };
  }
  const questions = interaction.questions ?? [];
  const answers = questions.flatMap((question, index) => {
    const selected = draft.selected?.[String(index)] ?? [];
    if (
      (!question.multiple && selected.length > 1) ||
      new Set(selected).size !== selected.length ||
      selected.some((label) => !question.options.some((option) => option.label === label))
    )
      throw new Error("Choose an available answer.");
    const ordered = question.options.map((option) => option.label).filter((label) => selected.includes(label));
    const notes = draft.notes?.[String(index)]?.trim() ?? "";
    if (!ordered.length && !notes) return [];
    if (!question.options.length)
      return [
        interaction.positionalAnswers
          ? { question: question.question, answer: null, notes }
          : { question: question.question, answer: notes },
      ];
    return [
      {
        question: question.question,
        answer: ordered.length ? ordered.join(", ") : null,
        ...(notes ? { notes } : {}),
      },
    ];
  });
  if (!answers.length) throw new Error("Enter an answer.");
  if (interaction.positionalAnswers && answers.length !== questions.length)
    throw new Error("Answer every question, or open this request in Waypoint.");
  return {
    action: "answer-question",
    body: {
      tool_use_id: interaction.id,
      answers,
      answer: answers
        .map((entry) =>
          [
            `"${entry.question}"=${entry.answer === null ? "(no option selected)" : `"${entry.answer}"`}`,
            ...("notes" in entry ? [`user notes: ${entry.notes}`] : []),
          ].join(" "),
        )
        .join(", "),
    },
  };
}

// Waypoint details raised by identity or state checks before anything reaches the agent.
export function preDispatchDetails(interaction: Interaction, backend: string): string[] {
  if (interaction.kind === "plan")
    return ["codex plan item was not found", "codex session is not in plan mode", "unsupported plan decision"];
  if (interaction.kind === "question") return ["no pending question for this session", "question is no longer open"];
  return lateRejectionAgents.has(backend) ? [] : ["no pending approval request"];
}

export function cancelRequest(interaction: Interaction): InteractionRequest {
  if (interaction.kind !== "question" || interaction.availability !== "actionable" || !interaction.id)
    throw new Error("This question cannot be cancelled here. Refresh it or open it in Waypoint.");
  return { action: "cancel-question", body: { tool_use_id: interaction.id } };
}
