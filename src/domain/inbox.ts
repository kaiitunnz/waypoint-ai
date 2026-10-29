import {
  InboxAttachmentRef,
  InboxBlock,
  InboxFrame,
  InboxItem,
  InboxPage,
  InboxQuestionBlock,
  InboxStatus,
  refWire,
} from "../api/inbox";

export const inboxPageSize = 30;

export function senderName(item: InboxItem): string {
  return item.fromSessionId ? item.fromLabel || "Session" : "You";
}

export function answered(block: InboxBlock): boolean {
  return (block.type === "question" || block.type === "approval") && !!block.answer;
}

// Questions and approvals that still keep the item open.
export function pendingBlocks(item: InboxItem): InboxBlock[] {
  return item.status === "resolved"
    ? []
    : item.blocks.filter(
        (block) => (block.type === "question" || block.type === "approval") && block.required && !block.answer,
      );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export function blockChips(item: InboxItem): string[] {
  const pending = pendingBlocks(item);
  const questions = pending.filter((block) => block.type === "question").length;
  const approvals = pending.length - questions;
  return [...(questions ? [plural(questions, "question")] : []), ...(approvals ? [plural(approvals, "approval")] : [])];
}

export interface QuestionAnswer {
  selected: string[];
  other: string;
}

// Mirrors Waypoint's checks, so a form shows the reason before sending.
export function answerProblem(block: InboxQuestionBlock, answer: QuestionAnswer): string | undefined {
  const labels = new Set(block.options.map((option) => option.label));
  if (answer.selected.some((label) => !labels.has(label))) return "Choose from the listed options.";
  if (!block.multi && answer.selected.length > 1) return "Choose one option.";
  if (block.required && !answer.selected.length && !answer.other.trim())
    return "Choose an option or write another answer.";
}

export function questionAnswer(answer: QuestionAnswer) {
  return answer.selected.length || answer.other.trim()
    ? { selected: answer.selected, other: answer.other.trim() || null }
    : undefined;
}

// A reply replaces the block's whole reply, so it carries the earlier attachments along; it is sent only when it
// has notes or files, which leaves an existing reply alone when only the answer changes.
export function replyBody(notes: string, carried: InboxAttachmentRef[], added: InboxAttachmentRef[]) {
  const trimmed = notes.trim();
  if (!trimmed && !added.length) return undefined;
  return { notes: trimmed || null, attachments: [...carried, ...added].map(refWire) };
}

const attachmentName = (ref: InboxAttachmentRef) => ref.filename ?? "Unavailable attachment";
// Inbox text comes from agents; this keeps it from adding headings or HTML around the parts Raycast labels.
const quote = (value: string) =>
  value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

function blockMarkdown(block: InboxBlock): string {
  const parts: string[] = [];
  switch (block.type) {
    case "markdown":
      parts.push(block.text);
      break;
    case "attachment":
      parts.push(`📎 ${attachmentName(block.ref)}`);
      break;
    case "question": {
      parts.push(`**${block.header ? `${block.header} · ` : ""}Question${block.required ? "" : " (optional)"}**`);
      parts.push(block.question);
      const chosen = new Set(block.answer?.selected ?? []);
      if (block.options.length)
        parts.push(
          block.options
            .map(
              (option) =>
                `- ${chosen.has(option.label) ? "✓ " : ""}${option.label}${option.description ? ` — ${option.description}` : ""}`,
            )
            .join("\n"),
        );
      if (block.answer?.other) parts.push(`Other: ${block.answer.other}`);
      if (!block.answer) parts.push("_Not answered_");
      break;
    }
    case "approval":
      parts.push(`**Approval${block.required ? "" : " (optional)"}**`);
      parts.push(block.prompt);
      parts.push(
        block.answer ? `Decision: **${block.answer.decision}**` : `_Waiting for: ${block.options.join(" / ")}_`,
      );
      break;
    case "unsupported":
      parts.push(`_Unsupported block (${block.name}). Open it in Waypoint._`);
      break;
  }
  if (block.reply) {
    const reply = [
      ...(block.reply.notes ? [block.reply.notes] : []),
      ...block.reply.attachments.map((ref) => `📎 ${attachmentName(ref)}`),
    ];
    if (reply.length) parts.push(`**Your reply**\n\n${quote(reply.join("\n"))}`);
  }
  return parts.join("\n\n");
}

const when = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export function itemMarkdown(item: InboxItem): string {
  const header = `# ${item.subject.replace(/\n/g, " ")}\n\n${senderName(item)} · ${when(item.updatedAt)}${item.status === "resolved" ? " · Resolved" : ""}`;
  return [header, ...item.blocks.map(blockMarkdown)].join("\n\n---\n\n");
}

// What an unselected row shows, so a long list doesn't render every item in full.
export function itemSummary(item: InboxItem): string {
  const chips = blockChips(item);
  const first = item.blocks.find((block) => block.type === "markdown");
  const line = first?.type === "markdown" ? first.text.trim().split("\n")[0] : undefined;
  return [
    `# ${item.subject.replace(/\n/g, " ")}`,
    `${senderName(item)}${chips.length ? ` · ${chips.join(", ")}` : ""}`,
    ...(line ? [line] : []),
  ].join("\n\n");
}

export function itemText(item: InboxItem): string {
  return [item.subject, ...item.blocks.map(blockMarkdown)].join("\n\n");
}

export interface InboxSection {
  items: InboxItem[];
  cursor?: string;
  hasMore: boolean;
  loaded: boolean;
}
export type InboxSections = Record<InboxStatus, InboxSection>;

export const emptySection = (): InboxSection => ({ items: [], hasMore: true, loaded: false });

// Waypoint's order: latest update first, then id. Both come from the same server, so the strings compare in order.
export function compareItems(a: InboxItem, b: InboxItem): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

// Waypoint's search: a case-insensitive substring of the subject or the sender's label.
export function matchesQuery(item: InboxItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || item.subject.toLowerCase().includes(needle) || !!item.fromLabel?.toLowerCase().includes(needle);
}

const without = (sections: InboxSections, id: string): InboxSections => ({
  open: { ...sections.open, items: sections.open.items.filter((item) => item.id !== id) },
  resolved: { ...sections.resolved, items: sections.resolved.items.filter((item) => item.id !== id) },
});
const find = (sections: InboxSections, id: string) =>
  sections.open.items.find((item) => item.id === id) ?? sections.resolved.items.find((item) => item.id === id);
// A plain read changes neither the version nor the update time, so a read copy is the fresher of two otherwise equal.
function newer(a: InboxItem, b: InboxItem): boolean {
  if (a.version !== b.version) return a.version > b.version;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return !!a.readAt && !b.readAt;
}

function place(sections: InboxSections, item: InboxItem, force: boolean): InboxSections {
  const section = sections[item.status];
  const last = section.items.at(-1);
  // Keyset paging brings an item that sorts below the last loaded row; inserting it early would page it twice.
  if (!force && section.hasMore && last && compareItems(item, last) > 0) return sections;
  return {
    ...sections,
    [item.status]: { ...section, items: [...section.items, item].sort(compareItems) },
  };
}

// Keyset paging under concurrent updates can repeat an item or move it between sections, so each item lives once,
// in the section of its newest copy.
// `deleted` holds items deleted since the page was requested, which a page read before the delete still lists.
export function addPage(
  sections: InboxSections,
  status: InboxStatus,
  page: InboxPage,
  deleted: ReadonlySet<string> = new Set(),
): InboxSections {
  let next: InboxSections = {
    ...sections,
    [status]: { ...sections[status], cursor: page.cursor, hasMore: page.hasMore, loaded: true },
  };
  for (const item of page.items) {
    if (deleted.has(item.id)) continue;
    const existing = find(next, item.id);
    if (existing && newer(existing, item)) continue;
    next = place(without(next, item.id), item, true);
  }
  return next;
}

// Applies a live update or a local result: the item moves to its status section when it belongs in what's loaded.
export function applyItem(sections: InboxSections, item: InboxItem, query: string, force = false): InboxSections {
  const existing = find(sections, item.id);
  if (existing && newer(existing, item)) return sections;
  const next = without(sections, item.id);
  return matchesQuery(item, query) ? place(next, item, force) : next;
}

export function applyFrame(sections: InboxSections, frame: InboxFrame, query: string): InboxSections {
  if (frame.deleted || !frame.item) return without(sections, frame.itemId);
  return applyItem(sections, frame.item, query);
}

export function removeItems(sections: InboxSections, ids: string[]): InboxSections {
  return ids.reduce(without, sections);
}

export function findItem(sections: InboxSections, id: string): InboxItem | undefined {
  return find(sections, id);
}

export interface InboxForm {
  selected: string[];
  other: string;
  notes: string;
}

// A saved draft wins; otherwise the form opens on the block's current answer and reply, since sending replaces them.
export function initialForm(block: InboxBlock, draft: string | undefined): InboxForm {
  try {
    const value: unknown = draft === undefined ? undefined : JSON.parse(draft);
    if (
      typeof value === "object" &&
      value !== null &&
      "notes" in value &&
      typeof value.notes === "string" &&
      "other" in value &&
      typeof value.other === "string" &&
      "selected" in value &&
      Array.isArray(value.selected)
    )
      return {
        notes: value.notes,
        other: value.other,
        selected: value.selected.filter((label): label is string => typeof label === "string"),
      };
  } catch {
    /* A damaged draft falls back to the block. */
  }
  return {
    notes: block.reply?.notes ?? "",
    other: block.type === "question" ? (block.answer?.other ?? "") : "",
    selected: block.type === "question" ? (block.answer?.selected ?? []) : [],
  };
}
