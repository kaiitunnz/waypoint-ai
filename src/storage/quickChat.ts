import { randomUUID } from "node:crypto";
import { ComposeParts } from "../domain/compose";
import { InteractionAction, InteractionDraft, interactionActions } from "../domain/interactions";
import { AttemptLaunch, ChatDefaults, initialDefaults } from "../domain/quickChat";
import { decodeState, isRecord } from "../domain/connections";
import { KeyedStorage, connectionsKey } from "./connections";
import { DraftStore } from "./drafts";

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
  launch?: AttemptLaunch;
}
export interface QuickChatState {
  version: 1;
  installation: string;
  defaults: ChatDefaults;
  pointer?: string;
  // A session the user explicitly chose for Quick Chat. It exists only while it is the pointer.
  chosen?: { sessionId: string; at: number };
  // When the newest failed start Quick Chat recognized was created; older failures never settle a later create.
  failedStartAt?: number;
  sentAt: Record<string, number>;
  // Draft text lives in the DraftStore; these fields are read only to carry older drafts over.
  drafts: Record<string, string>;
  pending?: PendingOperation;
  interactionDrafts?: Record<string, InteractionDraft>;
  compose?: Record<string, ComposeParts & { text?: string }>;
}
export interface Mutex {
  run<T>(id: string, operation: (check: () => Promise<void>) => Promise<T>): Promise<T>;
}
const textRecord = (value: unknown, valid: (entry: unknown) => boolean) =>
  value === undefined || (isRecord(value) && Object.values(value).every(valid));
const isText = (value: unknown) => typeof value === "string";
export function isInteractionDraft(value: unknown): value is InteractionDraft {
  return (
    isRecord(value) &&
    (value.decision === undefined || isText(value.decision)) &&
    (value.note === undefined || isText(value.note)) &&
    textRecord(value.selected, (entry) => Array.isArray(entry) && entry.every(isText)) &&
    textRecord(value.notes, isText)
  );
}
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
function isComposeParts(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.text === undefined || isText(value.text)) &&
    (value.sessionId === undefined || isText(value.sessionId)) &&
    (value.launch === undefined || isText(value.launch)) &&
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
      (data.pointer !== undefined && typeof data.pointer !== "string") ||
      (data.failedStartAt !== undefined && !isNumber(data.failedStartAt)) ||
      (data.chosen !== undefined &&
        (!isRecord(data.chosen) || !isText(data.chosen.sessionId) || !isNumber(data.chosen.at)))
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
    if (data.compose !== undefined && (!isRecord(data.compose) || !Object.values(data.compose).every(isComposeParts)))
      throw new Error();
    if (
      isRecord(data.pending) &&
      data.pending.launch !== undefined &&
      (!isRecord(data.pending.launch) ||
        !isText(data.pending.launch.backend) ||
        !isText(data.pending.launch.target) ||
        !isText(data.pending.launch.cwd) ||
        (data.pending.launch.title !== undefined && !isText(data.pending.launch.title)))
    )
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
// Every pointer change goes through here so a choice never outlives its destination.
export function setPointer(state: QuickChatState, sessionId: string | undefined, chosenAt?: number) {
  state.pointer = sessionId;
  if (sessionId && chosenAt !== undefined) state.chosen = { sessionId, at: chosenAt };
  else if (state.chosen?.sessionId !== sessionId) state.chosen = undefined;
}
// The last explicit user activity for a session: a successful send, or choosing it for Quick Chat.
export function lastActivity(state: QuickChatState, sessionId: string): number | undefined {
  const chosen = state.chosen?.sessionId === sessionId ? state.chosen.at : undefined;
  const sent = state.sentAt[sessionId];
  return sent === undefined ? chosen : chosen === undefined ? sent : Math.max(sent, chosen);
}
function serverOf(key: string): string | undefined {
  if (key.startsWith("waypoint.quick-chat.")) return key.slice("waypoint.quick-chat.".length);
  if (key.startsWith("waypoint.draft.")) return key.slice("waypoint.draft.".length).split(".")[0];
  return undefined;
}
export class QuickChatStore {
  readonly drafts: DraftStore;
  constructor(
    private readonly storage: KeyedStorage,
    private readonly mutex: Mutex,
  ) {
    this.drafts = new DraftStore(storage);
  }
  transaction<T>(
    connectionId: string,
    operation: (state: QuickChatState, persist: () => Promise<void>, fence: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.mutex.run(connectionId, async (check) => {
      const key = `waypoint.quick-chat.${connectionId}`;
      const state = decodeQuickChat(await this.storage.getItem(key));
      // Every write first proves this transaction still holds the server lock.
      const persist = async () => {
        await check();
        await this.storage.setItem(key, JSON.stringify(state));
      };
      return operation(state, persist, check);
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
  // Removes Quick Chat state and drafts of servers that are no longer saved. It doesn't decode the state, so
  // damaged data is removed too, and it takes each server's lock so no transaction writes it back meanwhile.
  // Nothing is removed unless the saved servers can be read, since a missing list would match every server.
  async sweep() {
    const owners = new Set((await this.storage.keys()).map(serverOf).filter((id): id is string => !!id));
    for (const id of owners) {
      if (!(await this.removed(id))) continue;
      await this.drafts.forget(`waypoint.draft.${id}.`);
      await this.mutex.run(id, async () => {
        if (!(await this.removed(id))) return;
        for (const key of await this.storage.keys()) if (serverOf(key) === id) await this.storage.removeItem(key);
      });
    }
  }
  private async removed(id: string) {
    const raw = await this.storage.getItem(connectionsKey);
    return raw !== undefined && !decodeState(raw).connections.some((connection) => connection.id === id);
  }
  defaults(id: string, defaults: ChatDefaults) {
    return this.transaction(id, async (state, persist) => {
      state.defaults = defaults;
      await persist();
    });
  }
}
