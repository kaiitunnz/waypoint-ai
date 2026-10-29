import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { ApiError, WaypointClient } from "../api/client";
import { InboxAttachmentRef, InboxBlock, InboxItem } from "../api/inbox";
import { fileProblem } from "../domain/compose";
import { InboxForm, answerProblem, questionAnswer, replyBody } from "../domain/inbox";
import { DraftStore, draftKeys } from "../storage/drafts";
import { BlockSubmit, SubmitOutcome, submitBlock } from "./inboxSubmit";

export interface FileStats {
  size: number;
  modifiedMs: number;
}
interface Upload extends FileStats {
  ref: InboxAttachmentRef;
  // Sent with a submit whose outcome nobody could confirm, so the saved reply may hold it.
  unsettled: boolean;
}
export type ReplyOutcome =
  SubmitOutcome | { kind: "invalid"; message: string } | { kind: "session-gone"; message: string };

export async function fileStats(path: string): Promise<FileStats> {
  const stats = await stat(path).catch(() => undefined);
  const problem = fileProblem(stats && { isFile: stats.isFile(), size: stats.size });
  if (problem) throw new Error(`${basename(path)}: ${problem}`);
  return { size: stats!.size, modifiedMs: stats!.mtimeMs };
}

// One Answer or Reply form. Reply files are pinned uploads, which Waypoint never sweeps, so the form reuses them
// across retries and deletes the ones no reply holds.
export class InboxReplySubmitter {
  private readonly uploads = new Map<string, Upload>();
  // The reply attachments last sent, which the next reply carries along before Waypoint's update arrives.
  private sent?: InboxAttachmentRef[];
  private sessionGone = false;
  constructor(
    private readonly client: WaypointClient,
    private readonly connection: { id: string; token: string },
    private readonly item: InboxItem,
    private readonly blockId: string,
    private readonly drafts: DraftStore,
    private readonly statFile = fileStats,
  ) {}
  get filesAllowed() {
    return !!this.item.fromSessionId && !this.sessionGone;
  }
  private get draftKey() {
    return draftKeys.inbox(this.connection.id, this.item.id, this.blockId);
  }
  readDraft() {
    return this.drafts.read(this.draftKey);
  }
  saveDraft(form: InboxForm) {
    return this.drafts.write(this.draftKey, JSON.stringify(form)).catch(() => undefined);
  }
  private async remove(paths: string[]) {
    await Promise.all(
      paths.map(async (path) => {
        const upload = this.uploads.get(path);
        this.uploads.delete(path);
        if (upload)
          await this.client
            .deleteAttachment(this.connection.token, upload.ref.sessionId, upload.ref.attachmentId)
            .catch(() => undefined);
      }),
    );
  }
  private async upload(files: string[]): Promise<InboxAttachmentRef[] | ReplyOutcome> {
    const refs: InboxAttachmentRef[] = [];
    // Files taken out of the form are no longer wanted, unless an unconfirmed reply may hold them.
    await this.remove(
      [...this.uploads].filter(([path, upload]) => !files.includes(path) && !upload.unsettled).map(([path]) => path),
    );
    for (const path of files) {
      let stats: FileStats;
      try {
        stats = await this.statFile(path);
      } catch (error) {
        return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
      }
      const earlier = this.uploads.get(path);
      if (earlier && earlier.size === stats.size && earlier.modifiedMs === stats.modifiedMs) {
        refs.push(earlier.ref);
        continue;
      }
      if (earlier && !earlier.unsettled) await this.remove([path]);
      try {
        const attachment = await this.client.uploadAttachment(
          this.connection.token,
          this.item.fromSessionId,
          path,
          stats.size,
          undefined,
          true,
        );
        const ref = { sessionId: this.item.fromSessionId, attachmentId: attachment.id, filename: attachment.filename };
        this.uploads.set(path, { ...stats, ref, unsettled: false });
        refs.push(ref);
      } catch (error) {
        if (error instanceof ApiError && error.kind === "not-found") {
          this.sessionGone = true;
          return {
            kind: "session-gone",
            message: "The session that posted this item was deleted, so files can't be attached. Send notes only.",
          };
        }
        return { kind: "rejected", message: error instanceof Error ? error.message : String(error) };
      }
    }
    return refs;
  }
  async submit(block: InboxBlock, form: InboxForm, files: string[], answering: boolean): Promise<ReplyOutcome> {
    let answer: BlockSubmit["answer"];
    if (answering && block.type === "question") {
      const problem = answerProblem(block, form);
      if (problem) return { kind: "invalid", message: problem };
      answer = questionAnswer(form);
    }
    const added = this.filesAllowed && files.length ? await this.upload(files) : [];
    if (!Array.isArray(added)) return added;
    const reply = replyBody(form.notes, this.sent ?? block.reply?.attachments ?? [], added);
    if (!answer && !reply) return { kind: "invalid", message: "Add an answer, notes, or files." };
    const outcome = await submitBlock(this.client, this.connection.token, this.item.id, this.blockId, {
      ...(answer ? { answer } : {}),
      ...(reply ? { reply } : {}),
    });
    const current = [...this.uploads.keys()];
    if (outcome.kind === "saved") {
      if (reply) this.sent = outcome.item.blocks.find((entry) => entry.id === this.blockId)?.reply?.attachments;
      this.uploads.clear();
      await this.drafts.remove(this.draftKey).catch(() => undefined);
    } else if (outcome.kind === "deleted") await this.remove(current);
    else if (outcome.kind === "rejected")
      await this.remove(current.filter((path) => !this.uploads.get(path)!.unsettled));
    else if (outcome.kind === "not-saved") for (const upload of this.uploads.values()) upload.unsettled = false;
    else if (outcome.kind === "unknown") for (const upload of this.uploads.values()) upload.unsettled = true;
    return outcome;
  }
  // The form closed without a confirmed send. An unconfirmed reply may hold some uploads, so the item is read
  // first; when that fails too, they are kept, since a stray upload costs less than a reply missing its file.
  async discard() {
    const unsettled = [...this.uploads].filter(([, upload]) => upload.unsettled);
    let held = new Set<string>();
    if (unsettled.length) {
      try {
        const item = await this.client.inboxItem(this.connection.token, this.item.id);
        held = new Set(
          item.blocks.find((entry) => entry.id === this.blockId)?.reply?.attachments.map((ref) => ref.attachmentId),
        );
      } catch (error) {
        if (!(error instanceof ApiError && error.kind === "not-found")) {
          await this.remove([...this.uploads].filter(([, upload]) => !upload.unsettled).map(([path]) => path));
          this.uploads.clear();
          return;
        }
      }
    }
    await this.remove(
      [...this.uploads].filter(([, upload]) => !held.has(upload.ref.attachmentId)).map(([path]) => path),
    );
    this.uploads.clear();
  }
}
