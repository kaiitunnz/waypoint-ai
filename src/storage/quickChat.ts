import { randomUUID } from "node:crypto";
import { ComposeDraft } from "../domain/compose";
import { InteractionAction, InteractionDraft, interactionActions } from "../domain/interactions";
import { ChatDefaults, initialDefaults } from "../domain/quickChat";
import { isRecord } from "../domain/connections";
import { StorageAdapter } from "./connections";

export interface PendingOperation {
  kind: "create" | "input" | "reattach" | "interrupt" | "interaction";
  interactionKey?: string;
  interactionAction?: InteractionAction;
  operationId: string;
  sessionId?: string;
  text: string;
  draftKey: string;
  startedAt: number;
  baseline?: number;
  acknowledgedAt?: number;
  attachments?: string[];
}
export interface QuickChatState {
  version: 1;
  installation: string;
  defaults: ChatDefaults;
  pointer?: string;
  sentAt: Record<string, number>;
  drafts: Record<string, string>;
  pending?: PendingOperation;
  interactionDrafts?: Record<string, InteractionDraft>;
  compose?: Record<string, ComposeDraft>;
}
export interface Mutex {
  run<T>(id: string, operation: () => Promise<T>): Promise<T>;
}
const textRecord = (value: unknown, valid: (entry: unknown) => boolean) =>
  value === undefined || (isRecord(value) && Object.values(value).every(valid));
const isText = (value: unknown) => typeof value === "string";
function isInteractionDraft(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.decision === undefined || isText(value.decision)) &&
    (value.note === undefined || isText(value.note)) &&
    textRecord(value.selected, (entry) => Array.isArray(entry) && entry.every(isText)) &&
    textRecord(value.notes, isText)
  );
}
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
function isComposeDraft(value: unknown): boolean {
  return (
    isRecord(value) &&
    isText(value.text) &&
    (value.sessionId === undefined || isText(value.sessionId)) &&
    Array.isArray(value.context) &&
    value.context.every(
      (item) =>
        isRecord(item) &&
        isText(item.id) &&
        ["selection", "clipboard"].includes(String(item.kind)) &&
        isText(item.text),
    ) &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        isText(file.id) &&
        isText(file.path) &&
        isText(file.name) &&
        isNumber(file.size) &&
        isNumber(file.modifiedMs) &&
        (file.upload === undefined ||
          (isRecord(file.upload) &&
            isText(file.upload.sessionId) &&
            isText(file.upload.attachmentId) &&
            isNumber(file.upload.uploadedAt))),
    )
  );
}
export function decodeQuickChat(raw?: string): QuickChatState {
  if (raw === undefined)
    return { version: 1, installation: randomUUID(), defaults: initialDefaults(), sentAt: {}, drafts: {} };
  try {
    const data: unknown = JSON.parse(raw);
    if (
      !isRecord(data) ||
      data.version !== 1 ||
      typeof data.installation !== "string" ||
      !isRecord(data.defaults) ||
      !isRecord(data.drafts) ||
      !isRecord(data.sentAt) ||
      (data.pointer !== undefined && typeof data.pointer !== "string")
    )
      throw new Error();
    const defaults = data.defaults;
    if (
      !["timed", "continue", "new"].includes(String(defaults.mode)) ||
      typeof defaults.timeoutMinutes !== "number" ||
      !Number.isFinite(defaults.timeoutMinutes) ||
      defaults.timeoutMinutes <= 0
    )
      throw new Error();
    for (const key of ["preset", "target", "cwd", "agent", "transport", "model", "effort", "permission", "profile"])
      if (typeof defaults[key] !== "string") throw new Error();
    for (const key of ["args", "config"])
      if (
        defaults[key] !== undefined &&
        (!Array.isArray(defaults[key]) || !defaults[key].every((value: unknown) => typeof value === "string"))
      )
        throw new Error();
    if (
      !Object.values(data.drafts).every((value) => typeof value === "string") ||
      !Object.values(data.sentAt).every((value) => typeof value === "number" && Number.isFinite(value))
    )
      throw new Error();
    if (
      data.pending !== undefined &&
      (!isRecord(data.pending) ||
        !["create", "input", "reattach", "interrupt", "interaction"].includes(String(data.pending.kind)) ||
        typeof data.pending.operationId !== "string" ||
        typeof data.pending.text !== "string" ||
        typeof data.pending.draftKey !== "string" ||
        typeof data.pending.startedAt !== "number" ||
        (data.pending.sessionId !== undefined && typeof data.pending.sessionId !== "string"))
    )
      throw new Error();
    if (
      data.interactionDrafts !== undefined &&
      (!isRecord(data.interactionDrafts) || !Object.values(data.interactionDrafts).every(isInteractionDraft))
    )
      throw new Error();
    if (data.compose !== undefined && (!isRecord(data.compose) || !Object.values(data.compose).every(isComposeDraft)))
      throw new Error();
    if (
      isRecord(data.pending) &&
      data.pending.attachments !== undefined &&
      (!Array.isArray(data.pending.attachments) || !data.pending.attachments.every(isText))
    )
      throw new Error();
    if (
      isRecord(data.pending) &&
      data.pending.kind === "interaction" &&
      (typeof data.pending.sessionId !== "string" ||
        typeof data.pending.interactionKey !== "string" ||
        !interactionActions.includes(data.pending.interactionAction as InteractionAction))
    )
      throw new Error();
    return data as unknown as QuickChatState;
  } catch {
    throw new Error(
      "Saved Quick Chat data could not be read. Restore the saved data before sending; it has not been replaced.",
    );
  }
}
export class QuickChatStore {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly mutex: Mutex,
  ) {}
  transaction<T>(
    connectionId: string,
    operation: (state: QuickChatState, persist: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.mutex.run(connectionId, async () => {
      const key = `waypoint.quick-chat.${connectionId}`;
      const state = decodeQuickChat(await this.storage.getItem(key));
      const persist = () => this.storage.setItem(key, JSON.stringify(state));
      return operation(state, persist);
    });
  }
  // Reads without the lock so long operations such as uploads don't block other commands from loading.
  async read(id: string) {
    const raw = await this.storage.getItem(`waypoint.quick-chat.${id}`);
    return raw === undefined ? this.load(id) : decodeQuickChat(raw);
  }
  load(id: string) {
    return this.transaction(id, async (state, persist) => {
      await persist();
      return state;
    });
  }
  draft(id: string, key: string, text: string) {
    return this.transaction(id, async (state, persist) => {
      state.drafts[key] = text;
      await persist();
    });
  }
  defaults(id: string, defaults: ChatDefaults) {
    return this.transaction(id, async (state, persist) => {
      state.defaults = defaults;
      await persist();
    });
  }
}
