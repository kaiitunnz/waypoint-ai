import { basename, dirname, resolve } from "node:path";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import { ChatDefaults, launchContext } from "./quickChat";

export type ContextKind = "selection" | "clipboard";
export interface ContextItem {
  id: string;
  kind: ContextKind;
  text: string;
}
export interface UploadReference {
  sessionId: string;
  attachmentId: string;
  uploadedAt: number;
}
export interface StagedFile {
  id: string;
  path: string;
  name: string;
  size: number;
  modifiedMs: number;
  upload?: UploadReference;
}
// Staged parts that sends and their checkpoints track; the message text is stored separately as a draft.
export interface ComposeParts {
  context: ContextItem[];
  files: StagedFile[];
  // The session a send created or targeted for this draft before it was acknowledged, or one started from chosen
  // settings that has had no message yet.
  sessionId?: string;
  // Fingerprint of the launch settings that created that session, or `customLaunch` for one started from chosen
  // settings.
  launch?: string;
}
export interface ComposeDraft extends ComposeParts {
  text: string;
}
export interface AttachmentPolicy {
  images: boolean;
  files: boolean;
  reason?: string;
}

export const maxUploadBytes = 25 * 1024 * 1024;
export const maxContextBytes = 256 * 1024;
export const maxDraftContextBytes = 1024 * 1024;
// Waypoint sweeps unsent uploads after 24 hours; reuse a reference only well inside that window.
const reuseWindowMs = 23 * 60 * 60 * 1000;
const contextTitles: Record<ContextKind, string> = { selection: "Selected text", clipboard: "Clipboard" };

export const emptyParts = (): ComposeParts => ({ context: [], files: [] });
export const composeParts = ({ context, files, sessionId, launch }: ComposeParts): ComposeParts => ({
  context,
  files,
  ...(sessionId ? { sessionId } : {}),
  ...(launch ? { launch } : {}),
});
export const hasCompose = (draft?: ComposeDraft) =>
  !!draft && (!!draft.text.trim() || draft.context.length > 0 || draft.files.length > 0);
export const contextTitle = (kind: ContextKind) => contextTitles[kind];

function fence(text: string) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(longest + 1);
}

export function composeMessage(text: string, context: ContextItem[]): string {
  return [
    text.trim(),
    ...context.map((item) => {
      const marker = fence(item.text);
      return `${contextTitles[item.kind]}:\n\n${marker}text\n${item.text}\n${marker}`;
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};
// Waypoint classifies an upload as an image from its declared content type.
export function mimeType(path: string): string {
  return imageTypes[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
export const isImage = (path: string) => mimeType(path).startsWith("image/");

// Raycast's clipboard history keeps large copied text in a file and reports only that file's name as the text.
export const isSpilledText = (file: string, store: string) =>
  file.endsWith(".txt") && dirname(resolve(file)) === resolve(store);
export function spilledClipboardText(content: { text: string; file?: string }, store: string): string | undefined {
  const file = content.file;
  return file && basename(file) === content.text && isSpilledText(file, store) ? file : undefined;
}

// Agents on SSH targets receive attachments as Waypoint host paths unless they inline them.
const remoteDelivery: Record<string, "all" | "images"> = { opencode: "all", claude_code: "images" };

export function attachmentPolicy(agentId: string, supported: boolean, remote: boolean): AttachmentPolicy {
  if (!supported) return { images: false, files: false, reason: "This agent doesn't accept attachments." };
  if (!remote) return { images: true, files: true };
  const delivery = remoteDelivery[agentId];
  if (delivery === "all") return { images: true, files: true };
  if (delivery === "images")
    return { images: true, files: false, reason: "Only images reach this agent on a remote target." };
  return { images: false, files: false, reason: "Attachments don't reach this agent on a remote target." };
}

// The shown session's agent and target decide, else the defaults a send would start a session with.
export function composePolicy(
  shown: { session?: Session; defaults?: ChatDefaults },
  metadata: ServerMetadata | undefined,
): AttachmentPolicy {
  if (!metadata) return { images: false, files: false, reason: "Attachments are not available yet." };
  const { session, defaults } = shown;
  const agentId = session?.backend ?? (defaults ? launchContext(defaults, metadata).backend : "");
  const agent = metadata.agents.find((entry) => entry.id === agentId);
  const targetId = session ? session.targetId : defaults?.target || undefined;
  return attachmentPolicy(
    agentId,
    agent?.attachments === true,
    !!targetId && metadata.targets.some((target) => target.id === targetId),
  );
}

// What the clipboard held: every copied file, whether an image was saved to the path asked for (or only seen), the
// text, and Raycast's spilled-text file. `failed` means the native read didn't finish or the image couldn't be saved.
export interface ClipboardReading {
  files: string[];
  image: "saved" | "present" | "none";
  text: string;
  spilled?: string;
  failed?: boolean;
}
export type ClipboardChoice =
  | { kind: "files"; paths: string[] }
  | { kind: "image" }
  | { kind: "text"; text: string; skipped?: string }
  | { kind: "refused"; reason: string }
  | { kind: "unreadable" }
  | { kind: "empty" };

// Copied files win over image data, which wins over text, as in the Waypoint web app. A file copy's text is only its
// name, so it is never staged in place of the files.
export function clipboardChoice(reading: ClipboardReading, policy: AttachmentPolicy): ClipboardChoice {
  const refusal = policy.reason ?? "This agent doesn't accept attachments.";
  const files = reading.files.filter((file) => file !== reading.spilled);
  if (files.length)
    return policy.images || policy.files ? { kind: "files", paths: files } : { kind: "refused", reason: refusal };
  if (reading.image === "saved") return { kind: "image" };
  // An image is only seen, not saved, when the agent can't take it or the save failed.
  const skipped = reading.image !== "present" ? undefined : policy.images ? "The image couldn't be saved." : refusal;
  if (reading.text.trim()) return { kind: "text", text: reading.text, ...(skipped ? { skipped } : {}) };
  if (skipped) return { kind: "refused", reason: skipped };
  return reading.failed ? { kind: "unreadable" } : { kind: "empty" };
}

const pad = (value: number) => String(value).padStart(2, "0");
// Named like a macOS screenshot, with dots in the time since some file systems refuse colons.
export function clipboardImageName(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `Clipboard image ${day} at ${time}.png`;
}

export function reusableUpload(file: StagedFile, sessionId: string, now: number): UploadReference | undefined {
  const upload = file.upload;
  return upload && upload.sessionId === sessionId && now - upload.uploadedAt < reuseWindowMs ? upload : undefined;
}

export function fileProblem(stats: { isFile: boolean; size: number } | undefined): string | undefined {
  if (!stats) return "This file is no longer available on this computer.";
  if (!stats.isFile) return "Folders cannot be attached.";
  if (!stats.size) return "Empty files cannot be attached.";
  if (stats.size > maxUploadBytes) return "Files larger than 25 MB cannot be attached.";
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
