import { open } from "node:fs/promises";
import { ClipboardReading, maxContextBytes, spilledClipboardText } from "../domain/compose";

export interface ClipboardReader {
  // Saves image data to `imagePath` only when one is given and no files were copied.
  read(imagePath?: string): Promise<ClipboardReading>;
}
export interface ClipboardSources {
  // Runs `pasteboardScript` with the arguments and resolves its output.
  runScript(script: string, args: string[]): Promise<string>;
  readRaycast(): Promise<{ text: string; file?: string }>;
  // Where Raycast's clipboard history keeps large copied text.
  spillStore: string;
}

// Raycast reports at most one copied file and no image data, so the pasteboard is read natively. The destination
// arrives as an argument, never as code.
export const pasteboardScript = `
ObjC.import("AppKit");
function run(argv) {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  const urls = pasteboard.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
  const files = [];
  if (!urls.isNil()) for (let index = 0; index < urls.count; index++) files.push(urls.objectAtIndex(index).path.js);
  if (files.length) return JSON.stringify({ files, image: "none" });
  let data = pasteboard.dataForType($.NSPasteboardTypePNG);
  if (data.isNil()) {
    const tiff = pasteboard.dataForType($.NSPasteboardTypeTIFF);
    if (!tiff.isNil()) {
      const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
      if (!bitmap.isNil()) data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    }
  }
  if (data.isNil()) return JSON.stringify({ files, image: "none" });
  if (!argv[0]) return JSON.stringify({ files, image: "present" });
  if (data.writeToFileAtomically(argv[0], true)) return JSON.stringify({ files, image: "saved" });
  return JSON.stringify({ files, image: "present", failed: true });
}`;

function parseNative(output: string): Pick<ClipboardReading, "files" | "image" | "failed"> {
  const data: unknown = JSON.parse(output);
  if (typeof data !== "object" || !data) throw new Error("Unexpected pasteboard output");
  const { files, image, failed } = data as Record<string, unknown>;
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) throw new Error("Unexpected files");
  if (image !== "saved" && image !== "present" && image !== "none") throw new Error("Unexpected image");
  return { files, image, ...(failed === true ? { failed } : {}) };
}

async function readSpilled(path: string): Promise<string> {
  // One byte past the limit is enough for staging to refuse oversized text.
  const handle = await open(path);
  try {
    const buffer = Buffer.alloc(maxContextBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function clipboardReader(sources: ClipboardSources): ClipboardReader {
  return {
    async read(imagePath) {
      const [native, raycast] = await Promise.all([
        sources
          .runScript(pasteboardScript, imagePath ? [imagePath] : [])
          .then(parseNative)
          .catch(() => undefined),
        sources.readRaycast(),
      ]);
      const spilled = spilledClipboardText(raycast, sources.spillStore);
      const text = spilled ? await readSpilled(spilled) : raycast.text;
      if (native) return { ...native, text, ...(spilled ? { spilled } : {}) };
      // Without the native read, Raycast's file still beats its text, which for a file copy is only the name.
      const files = raycast.file && raycast.file !== spilled ? [raycast.file] : [];
      return { files, image: "none", text, failed: true, ...(spilled ? { spilled } : {}) };
    },
  };
}
