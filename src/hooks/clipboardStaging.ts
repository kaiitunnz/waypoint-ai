import { basename } from "node:path";
import { clipboardChoice, composePolicy } from "../domain/compose";
import { ClipboardFiles } from "../storage/clipboardFiles";
import { ClipboardReader } from "./clipboardReader";
import { QuickChatController } from "./quickChatController";

export interface StagingNotice {
  failed: boolean;
  title: string;
  message?: string;
}
export interface ClipboardStaging {
  staged: boolean;
  notice?: StagingNotice;
}

const attachedTitle = (paths: string[]) =>
  paths.length === 1 ? `Attached ${basename(paths[0])}` : `Attached ${paths.length} files`;

// Attaches copied files or image data, or stages copied text, checking the attachment policy before anything is
// written.
export async function stageClipboard(
  controller: QuickChatController,
  reader: ClipboardReader,
  files: ClipboardFiles,
): Promise<ClipboardStaging> {
  const state = controller.getSnapshot();
  if (state.busy) return { staged: false };
  const policy = composePolicy(state, state.metadata);
  const image = policy.images ? await files.create(new Date()) : undefined;
  let choice;
  try {
    choice = clipboardChoice(await reader.read(image?.path), policy);
  } catch (error) {
    if (image) await files.discard(image.id);
    throw error;
  }
  if (image && choice.kind !== "image") await files.discard(image.id);
  switch (choice.kind) {
    case "files": {
      const added = await controller.addFiles(choice.paths);
      const notice = added.problems.length
        ? { failed: true, title: "Some files were not added", message: added.problems.join("\n") }
        : added.staged.length
          ? { failed: false, title: attachedTitle(added.staged) }
          : undefined;
      return { staged: added.staged.length > 0, notice };
    }
    case "image": {
      const added = await controller.addFiles([image!.path]);
      // A file whose save failed may still be in a queued save, so the collector removes it later.
      if (!added.staged.length) await files.discard(image!.id);
      if (added.problems.length)
        return {
          staged: false,
          notice: { failed: true, title: "Image not attached", message: added.problems.join("\n") },
        };
      return {
        staged: added.staged.length > 0,
        notice: added.staged.length ? { failed: false, title: "Attached clipboard image" } : undefined,
      };
    }
    case "text": {
      const staged = await controller.stageContext("clipboard", choice.text);
      return {
        staged,
        notice:
          staged && choice.skipped
            ? { failed: false, title: "Included clipboard text", message: `Image not attached: ${choice.skipped}` }
            : undefined,
      };
    }
    case "refused":
      return { staged: false, notice: { failed: true, title: "Can't attach the clipboard", message: choice.reason } };
    case "unreadable":
      return { staged: false, notice: { failed: true, title: "Couldn't read the clipboard" } };
    case "empty":
      return { staged: false, notice: { failed: true, title: "The clipboard is empty" } };
  }
}
