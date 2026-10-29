import { isRecord } from "../domain/connections";

export type InboxStatus = "open" | "resolved";

export interface InboxAttachmentRef {
  sessionId: string;
  attachmentId: string;
  // Waypoint fills these in when the attachment resolves; they are absent for one it can't find.
  filename?: string;
  kind?: string;
}

export interface InboxReply {
  notes?: string;
  attachments: InboxAttachmentRef[];
  createdAt: string;
}

interface BlockCommon {
  id: string;
  reply?: InboxReply;
}
export interface InboxQuestionOption {
  label: string;
  description?: string;
}
export type InboxBlock = BlockCommon &
  (
    | { type: "markdown"; text: string }
    | { type: "attachment"; ref: InboxAttachmentRef }
    | {
        type: "question";
        header?: string;
        question: string;
        options: InboxQuestionOption[];
        multi: boolean;
        required: boolean;
        answer?: { selected: string[]; other?: string };
        answeredAt?: string;
      }
    | {
        type: "approval";
        prompt: string;
        options: string[];
        required: boolean;
        answer?: { decision: string };
        answeredAt?: string;
      }
    // A block type this version doesn't know, kept so a newer server's items still list.
    | { type: "unsupported"; name: string }
  );
export type InboxQuestionBlock = Extract<InboxBlock, { type: "question" }>;
export type InboxApprovalBlock = Extract<InboxBlock, { type: "approval" }>;

export interface InboxItem {
  id: string;
  // Empty when a person posted the item.
  fromSessionId: string;
  fromLabel?: string;
  subject: string;
  status: InboxStatus;
  readAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  blocks: InboxBlock[];
}

export interface InboxPage {
  items: InboxItem[];
  hasMore: boolean;
  cursor?: string;
}

export interface InboxFrame {
  itemId: string;
  unresolvedCount: number;
  deleted: boolean;
  item?: InboxItem;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const filled = (value: unknown) => (typeof value === "string" && value ? value : undefined);
function required(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid inbox ${field}`);
  return value;
}

function parseRef(value: unknown): InboxAttachmentRef {
  if (!isRecord(value)) throw new Error("Invalid inbox attachment");
  return {
    sessionId: required(value.session_id, "attachment"),
    attachmentId: required(value.attachment_id, "attachment"),
    filename: filled(value.filename),
    kind: filled(value.kind),
  };
}

function parseReply(value: unknown): InboxReply | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid inbox reply");
  return {
    notes: filled(value.notes),
    attachments: Array.isArray(value.attachments) ? value.attachments.map(parseRef) : [],
    createdAt: text(value.created_at) ?? "",
  };
}

function parseBlock(value: unknown): InboxBlock {
  if (!isRecord(value)) throw new Error("Invalid inbox block");
  const common = { id: required(value.id, "block"), reply: parseReply(value.reply) };
  switch (value.type) {
    case "markdown":
      return { ...common, type: "markdown", text: required(value.text, "block") };
    case "attachment":
      return { ...common, type: "attachment", ref: parseRef(value.ref) };
    case "question": {
      const answer = isRecord(value.answer)
        ? {
            selected: Array.isArray(value.answer.selected)
              ? value.answer.selected.filter((item): item is string => typeof item === "string")
              : [],
            other: filled(value.answer.other),
          }
        : undefined;
      return {
        ...common,
        type: "question",
        header: filled(value.header),
        question: required(value.question, "question"),
        options: (Array.isArray(value.options) ? value.options : []).map((option) => {
          if (!isRecord(option)) throw new Error("Invalid inbox option");
          return { label: required(option.label, "option"), description: filled(option.description) };
        }),
        multi: value.multi === true,
        required: value.required !== false,
        answer,
        answeredAt: filled(value.answered_at),
      };
    }
    case "approval":
      return {
        ...common,
        type: "approval",
        prompt: required(value.prompt, "approval"),
        options: (Array.isArray(value.options) ? value.options : []).map((option) => required(option, "option")),
        required: value.required !== false,
        answer: isRecord(value.answer) ? { decision: required(value.answer.decision, "decision") } : undefined,
        answeredAt: filled(value.answered_at),
      };
    default:
      return { ...common, type: "unsupported", name: text(value.type) ?? "unknown" };
  }
}

export function parseInboxItem(value: unknown): InboxItem {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) throw new Error("Invalid inbox item");
  if (value.status !== "open" && value.status !== "resolved") throw new Error("Invalid inbox status");
  return {
    id: value.id,
    fromSessionId: text(value.from_session_id) ?? "",
    fromLabel: filled(value.from_label),
    subject: required(value.subject, "subject"),
    status: value.status,
    readAt: filled(value.read_at),
    version: typeof value.version === "number" ? value.version : 0,
    createdAt: required(value.created_at, "time"),
    updatedAt: required(value.updated_at, "time"),
    blocks: (Array.isArray(value.blocks) ? value.blocks : []).map(parseBlock),
  };
}

export function parseInboxPage(value: unknown): InboxPage {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("Invalid inbox page");
  return {
    items: value.items.map(parseInboxItem),
    hasMore: value.has_more === true,
    cursor: filled(value.cursor),
  };
}

export function parseInboxFrame(value: Record<string, unknown>): InboxFrame {
  const deleted = value.deleted === true;
  const item = !deleted && value.item !== null && value.item !== undefined ? parseInboxItem(value.item) : undefined;
  if (typeof value.unresolved_count !== "number") throw new Error("Invalid inbox update");
  return {
    itemId: required(value.item_id, "update"),
    unresolvedCount: value.unresolved_count,
    deleted,
    item,
  };
}

// The request body's attachment reference; Waypoint fills in the name and kind.
export const refWire = (ref: InboxAttachmentRef) => ({ session_id: ref.sessionId, attachment_id: ref.attachmentId });
