import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, WaypointClient } from "../src/api/client";
import { parseMetadata } from "../src/api/contracts";
import {
  attachmentPolicy,
  clipboardChoice,
  clipboardImageName,
  composeMessage,
  composePolicy,
  fileProblem,
  maxUploadBytes,
  mimeType,
  reusableUpload,
  spilledClipboardText,
} from "../src/domain/compose";
import { decodeQuickChat } from "../src/storage/quickChat";
import { parseEvent, parseSession } from "../src/api/sessions";
import { transcript } from "../src/domain/transcript";
import { eventWire, metadataWire, sessionWire } from "./fixtures/conversation";

test("composed messages keep context verbatim in fences longer than any backtick run", () => {
  assert.equal(composeMessage("  Summarize  ", []), "Summarize");
  assert.equal(
    composeMessage("Explain", [
      { id: "1", kind: "selection", text: "const a = `x`;" },
      { id: "2", kind: "clipboard", text: "```\nnested\n```" },
    ]),
    "Explain\n\nSelected text:\n\n```text\nconst a = `x`;\n```\n\nClipboard:\n\n````text\n```\nnested\n```\n````",
  );
  assert.equal(composeMessage("", [{ id: "1", kind: "clipboard", text: "only" }]), "Clipboard:\n\n```text\nonly\n```");
});

test("attachment rules cover types, limits, reuse windows and remote delivery", () => {
  assert.equal(mimeType("/a/Shot.PNG"), "image/png");
  assert.equal(mimeType("/a/notes.md"), "application/octet-stream");
  assert.equal(fileProblem(undefined), "This file is no longer available on this computer.");
  assert.match(fileProblem({ isFile: false, size: 1 })!, /Folders/);
  assert.match(fileProblem({ isFile: true, size: 0 })!, /Empty/);
  assert.match(fileProblem({ isFile: true, size: maxUploadBytes + 1 })!, /25 MB/);
  assert.equal(fileProblem({ isFile: true, size: maxUploadBytes }), undefined);
  const file = {
    id: "f",
    path: "/a/b.txt",
    name: "b.txt",
    size: 1,
    modifiedMs: 1,
    upload: { sessionId: "s1", attachmentId: "a1", uploadedAt: 0 },
  };
  assert.equal(reusableUpload(file, "s1", 60_000)?.attachmentId, "a1");
  assert.equal(reusableUpload(file, "s2", 60_000), undefined, "never reused across sessions");
  assert.equal(reusableUpload(file, "s1", 23 * 3600_000), undefined, "expires before the server sweep");
  assert.deepEqual(attachmentPolicy("codex", false, false), {
    images: false,
    files: false,
    reason: "This agent doesn't accept attachments.",
  });
  assert.deepEqual(attachmentPolicy("codex", true, false), { images: true, files: true });
  assert.equal(attachmentPolicy("codex", true, true).images, false);
  assert.deepEqual(
    [attachmentPolicy("claude_code", true, true).images, attachmentPolicy("claude_code", true, true).files],
    [true, false],
  );
  assert.deepEqual(attachmentPolicy("opencode", true, true), { images: true, files: true });
});

test("large copied text is read from Raycast's clipboard store, never from other copied files", () => {
  const store = "/Library/com.raycast.macos/clipboard";
  const spill = `${store}/file-61c3.txt`;
  assert.equal(spilledClipboardText({ text: "file-61c3.txt", file: spill }, `${store}/`), spill);
  assert.equal(spilledClipboardText({ text: "plain text" }, store), undefined);
  assert.equal(spilledClipboardText({ text: "notes.txt", file: "/Users/me/notes.txt" }, store), undefined);
  assert.equal(spilledClipboardText({ text: "file-1.png", file: `${store}/file-1.png` }, store), undefined);
  assert.equal(spilledClipboardText({ text: "Image", file: spill }, store), undefined);
});

test("capabilities and stored compose drafts are validated", () => {
  const catalog = parseMetadata({
    ...metadataWire,
    backends: metadataWire.backends.map((agent) => ({ ...agent, agent_capabilities: { supports_attachments: true } })),
  });
  assert.equal(catalog.agents[0].attachments, true);
  assert.equal(parseMetadata(metadataWire).agents[0].attachments, false);
  const base = { version: 1, installation: "i", defaults: decodeQuickChat().defaults, sentAt: {}, drafts: {} };
  const compose = {
    quick: {
      text: "hi",
      sessionId: "s1",
      context: [{ id: "c", kind: "clipboard", text: "x" }],
      files: [
        {
          id: "f",
          path: "/a",
          name: "a",
          size: 1,
          modifiedMs: 2,
          upload: { sessionId: "s1", attachmentId: "a1", uploadedAt: 3 },
        },
      ],
    },
  };
  assert.deepEqual(decodeQuickChat(JSON.stringify({ ...base, compose })).compose, compose);
  for (const corrupt of [
    { compose: [] },
    { compose: { quick: { text: 1, context: [], files: [] } } },
    { compose: { quick: { text: "", context: [{ id: "c", kind: "screen", text: "" }], files: [] } } },
    {
      compose: {
        quick: { text: "", context: [], files: [{ id: "f", path: "/a", name: "a", size: "1", modifiedMs: 1 }] },
      },
    },
    {
      compose: {
        quick: {
          text: "",
          context: [],
          files: [{ id: "f", path: "/a", name: "a", size: 1, modifiedMs: 1, upload: {} }],
        },
      },
    },
    { pending: { kind: "input", operationId: "o", text: "", draftKey: "quick", startedAt: 1, attachments: [1] } },
  ])
    assert.throws(() => decodeQuickChat(JSON.stringify({ ...base, ...corrupt })), /could not be read/);
});

test("uploads send multipart files with their image type, and connect reports failed passwords", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compose-tests-"));
  const image = join(directory, "shot.png");
  await writeFile(image, Buffer.from([137, 80, 78, 71]));
  const received: { path: string; type?: string; body: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      received.push({ path: request.url ?? "", type: request.headers["content-type"], body });
      if (request.url?.endsWith("/connect")) {
        const { password } = JSON.parse(body);
        response.end(JSON.stringify({ target_id: "t", connected: password === "right", detail: "Permission denied" }));
      } else if (request.url?.includes("too-big")) {
        response.statusCode = 413;
        response.end(JSON.stringify({ detail: "attachment exceeds 1 byte limit" }));
      } else
        response.end(
          JSON.stringify({ id: "a".repeat(32), filename: "shot.png", mime: "image/png", size: 4, kind: "image" }),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new WaypointClient(`http://127.0.0.1:${address.port}`);
  try {
    const attachment = await client.uploadAttachment("token", "s1", image, 4);
    assert.deepEqual(attachment, { id: "a".repeat(32), filename: "shot.png", kind: "image", size: 4 });
    assert.equal(received[0].path, "/api/sessions/s1/attachments");
    assert.match(received[0].type!, /^multipart\/form-data; boundary=/);
    assert.match(received[0].body, /name="file"; filename="shot.png"\r\nContent-Type: image\/png/);
    await assert.rejects(client.uploadAttachment("token", "too-big", image, 4), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 413);
      return true;
    });
    assert.deepEqual(await client.connectTarget("token", "t", "wrong"), {
      connected: false,
      detail: "Permission denied",
    });
    assert.equal((await client.connectTarget("token", "t", "right")).connected, true);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sent attachments keep only their ID, name and kind, and appear under the message", () => {
  const event = parseEvent(
    {
      ...eventWire(1, "user_input", "Look", ""),
      metadata: {
        attachments: [{ id: "a1", filename: "shot.png", kind: "image", mime: "image/png", origin: "/private/x" }],
      },
    },
    "demo",
  );
  assert.deepEqual(event.metadata.attachments, [{ id: "a1", filename: "shot.png", kind: "image" }]);
  assert.equal(transcript([event])[0].text, "Look\n\nAttached: shot.png");
  const only = parseEvent(
    { ...eventWire(2, "user_input", "", ""), metadata: { attachments: [{ id: "a2", filename: "notes.md" }] } },
    "demo",
  );
  assert.equal(transcript([only])[0].text, "Attached: notes.md");
});

test("copied files beat image data, which beats text, and spilled text stays text", () => {
  const all = { images: true, files: true };
  const reading = { files: [], image: "none" as const, text: "" };
  assert.deepEqual(clipboardChoice({ ...reading, files: ["/a.txt", "/b.png"], image: "present", text: "a.txt" }, all), {
    kind: "files",
    paths: ["/a.txt", "/b.png"],
  });
  assert.deepEqual(clipboardChoice({ ...reading, image: "saved", text: "A1" }, all), { kind: "image" });
  assert.deepEqual(clipboardChoice({ ...reading, text: "plain" }, all), { kind: "text", text: "plain" });
  assert.deepEqual(
    clipboardChoice({ ...reading, files: ["/store/x.txt"], spilled: "/store/x.txt", text: "long" }, all),
    {
      kind: "text",
      text: "long",
    },
  );
  assert.deepEqual(clipboardChoice({ ...reading, text: "  " }, all), { kind: "empty" });
  assert.deepEqual(clipboardChoice({ ...reading, failed: true }, all), { kind: "unreadable" });
  assert.deepEqual(clipboardChoice({ ...reading, image: "present", failed: true }, all), { kind: "unreadable" });
});

test("agents that can't take attachments refuse copied files, and copied images give way to their text", () => {
  const none = attachmentPolicy("codex", true, true);
  const reading = { files: [], image: "none" as const, text: "" };
  assert.deepEqual(clipboardChoice({ ...reading, files: ["/report.pdf"], text: "report.pdf" }, none), {
    kind: "refused",
    reason: "Attachments don't reach this agent on a remote target.",
  });
  assert.deepEqual(clipboardChoice({ ...reading, image: "present", text: "a\tb" }, none), {
    kind: "text",
    text: "a\tb",
    skipped: "Attachments don't reach this agent on a remote target.",
  });
  assert.deepEqual(clipboardChoice({ ...reading, image: "present" }, none), {
    kind: "refused",
    reason: "Attachments don't reach this agent on a remote target.",
  });
  const imagesOnly = attachmentPolicy("claude_code", true, true);
  assert.deepEqual(clipboardChoice({ ...reading, files: ["/notes.md"] }, imagesOnly), {
    kind: "files",
    paths: ["/notes.md"],
  });
});

test("clipboard images are named like screenshots, in local time without colons", () => {
  assert.equal(clipboardImageName(new Date(2026, 9, 29, 9, 3, 7)), "Clipboard image 2026-10-29 at 09.03.07.png");
});

test("the attachment policy follows the shown session, else the defaults", () => {
  const metadata = parseMetadata({
    ...metadataWire,
    launch_targets: [{ id: "ssh-1", name: "Box", kind: "ssh", auth: "key", connected: true, supported_backends: [] }],
    backends: metadataWire.backends.map((agent) => ({
      ...agent,
      agent_capabilities: { supports_attachments: agent.id === "test-agent" },
    })),
  });
  const defaults = decodeQuickChat().defaults;
  assert.deepEqual(composePolicy({ defaults }, metadata), { images: true, files: true });
  assert.equal(composePolicy({ defaults: { ...defaults, target: "ssh-1" } }, metadata).images, false);
  const terminal = parseSession({ ...sessionWire("t"), backend: "terminal" });
  assert.equal(composePolicy({ session: terminal, defaults }, metadata).images, false);
  assert.deepEqual(
    composePolicy({ session: parseSession(sessionWire("s")), defaults: { ...defaults, target: "ssh-1" } }, metadata),
    {
      images: true,
      files: true,
    },
  );
  assert.equal(composePolicy({ defaults }, undefined).images, false);
});
