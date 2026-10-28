import { open } from "node:fs/promises";
import { ClipboardReading, isSpilledText, maxContextBytes, spilledClipboardText } from "../domain/compose";

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

// Raycast reports at most one copied file and no image data, and its text can trail a copy made a moment ago, so the
// pasteboard is read natively. Text is cut one character past the context limit, which staging then refuses. The
// limit and destination arrive as arguments, never as code.
export const pasteboardScript = `
ObjC.import("AppKit");
function run(argv) {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  const string = pasteboard.stringForType($.NSPasteboardTypeString);
  const text = string.isNil() ? "" : string.js.slice(0, Number(argv[0]));
  const imagePath = argv[1];
  const urls = pasteboard.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
  const files = [];
  if (!urls.isNil()) for (let index = 0; index < urls.count; index++) files.push(urls.objectAtIndex(index).path.js);
  if (files.length) return JSON.stringify({ files, image: "none", text });
  let data = pasteboard.dataForType($.NSPasteboardTypePNG);
  if (data.isNil()) {
    const tiff = pasteboard.dataForType($.NSPasteboardTypeTIFF);
    if (!tiff.isNil()) {
      const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
      if (!bitmap.isNil()) data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    }
  }
  if (data.isNil()) return JSON.stringify({ files, image: "none", text });
  if (!imagePath) return JSON.stringify({ files, image: "present", text });
  if (data.writeToFileAtomically(imagePath, true)) return JSON.stringify({ files, image: "saved", text });
  return JSON.stringify({ files, image: "present", text, failed: true });
}`;

function parseNative(output: string): Pick<ClipboardReading, "files" | "image" | "text" | "failed"> {
  const data: unknown = JSON.parse(output);
  if (typeof data !== "object" || !data) throw new Error("Unexpected pasteboard output");
  const { files, image, text, failed } = data as Record<string, unknown>;
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) throw new Error("Unexpected files");
  if (image !== "saved" && image !== "present" && image !== "none") throw new Error("Unexpected image");
  if (typeof text !== "string") throw new Error("Unexpected text");
  return { files, image, text, ...(failed === true ? { failed } : {}) };
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
      const args = [String(maxContextBytes + 1), ...(imagePath ? [imagePath] : [])];
      const native = await sources
        .runScript(pasteboardScript, args)
        .then(parseNative)
        .catch(() => undefined);
      if (native) {
        const spilled = native.files.find((file) => isSpilledText(file, sources.spillStore));
        const text = !native.text && spilled ? await readSpilled(spilled) : native.text;
        return { ...native, text, ...(spilled ? { spilled } : {}) };
      }
      const raycast = await sources.readRaycast();
      const spilled = spilledClipboardText(raycast, sources.spillStore);
      const text = spilled ? await readSpilled(spilled) : raycast.text;
      // Without the native read, Raycast's file still beats its text, which for a file copy is only the name.
      const files = raycast.file && raycast.file !== spilled ? [raycast.file] : [];
      return { files, image: "none", text, failed: true, ...(spilled ? { spilled } : {}) };
    },
  };
}
