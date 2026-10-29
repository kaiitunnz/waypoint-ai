import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WaypointClient } from "../src/api/client";
import { QuickChatController } from "../src/hooks/quickChatController";
import { ClipboardReader } from "../src/hooks/clipboardReader";
import { stageClipboard } from "../src/hooks/clipboardStaging";
import { ClipboardReading } from "../src/domain/compose";
import { ClipboardFiles } from "../src/storage/clipboardFiles";
import { ServerMutex } from "../src/storage/mutex";
import { draftKeys } from "../src/storage/drafts";
import { QuickChatStore } from "../src/storage/quickChat";
import { eventWire, metadataWire, sessionWire } from "./fixtures/conversation";

const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const connection = { id: "server-a", apiUrl: "http://localhost", name: "A", token: "fixture-token" };

async function fixture(options: { attachments?: boolean; target?: "password" | "key" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "compose-controller-"));
  const values = new Map<string, string>();
  const writes: string[] = [];
  const storage = {
    failState: false,
    failNextState: false,
    failed: false,
    // Runs once during the first Quick Chat state read after a failed write.
    afterFailedRead: undefined as (() => void) | undefined,
    beforeWrite: undefined as ((key: string, value: string) => void) | undefined,
  };
  const store = new QuickChatStore(
    {
      keys: async () => [...values.keys()],
      entries: async () => [...values],
      removeItem: async (key) => void values.delete(key),
      getItem: async (key) => {
        const value = values.get(key);
        if (storage.failed && key.startsWith("waypoint.quick-chat.") && storage.afterFailedRead) {
          storage.failed = false;
          storage.afterFailedRead();
          storage.afterFailedRead = undefined;
        }
        return value;
      },
      setItem: async (key, value) => {
        if ((storage.failState || storage.failNextState) && key.startsWith("waypoint.quick-chat.")) {
          storage.failNextState = false;
          storage.failed = true;
          throw new Error("Storage unavailable");
        }
        storage.beforeWrite?.(key, value);
        writes.push(key);
        values.set(key, value);
      },
    },
    new ServerMutex(directory),
  );
  const metadata = {
    ...metadataWire,
    default_cwd: "/workspace",
    launch_targets: options.target
      ? [
          {
            id: "ssh-1",
            name: "Build Box",
            kind: "ssh",
            auth: options.target,
            connected: false,
            supported_backends: ["test-agent"],
          },
        ]
      : [],
    backends: metadataWire.backends.map((agent) => ({
      ...agent,
      agent_capabilities: { supports_attachments: options.attachments !== false },
    })),
  };
  const server = {
    sessions: [] as (ReturnType<typeof sessionWire> & { tags?: Record<string, string>; launch_target_id?: string })[],
    events: new Map<string, ReturnType<typeof eventWire>[]>(),
    hasMore: false,
    stored: new Map<string, Set<string>>(),
    uploads: [] as { session: string; name: string; type: string }[],
    deletes: [] as string[],
    inputs: [] as { session: string; text: string; attachments?: string[] }[],
    creates: 0,
    failUploadAt: -1,
    expire: undefined as string | undefined,
    sshRequired: false,
    connects: [] as string[],
    beforeInput: undefined as (() => void) | undefined,
  };
  let uploads = 0;
  const client = new WaypointClient(connection.apiUrl, async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path === "/api/me") return respond(metadata);
    if (path.startsWith("/api/launch-targets/")) {
      const { password } = JSON.parse(String(init?.body));
      server.connects.push(password);
      if (password === "right") server.sshRequired = false;
      return respond({ target_id: "ssh-1", connected: password === "right", detail: "Permission denied" });
    }
    if (path === "/api/sessions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (server.sshRequired) return respond({ detail: "ssh-master-required" }, 409);
      server.creates++;
      const session = {
        ...sessionWire(`created-${server.creates}`),
        status: "idle",
        tags: body.tags,
        cwd: body.cwd,
        launch_target_id: body.launch_target_id,
      };
      server.sessions.push(session);
      server.stored.set(session.id, new Set());
      return respond({ session });
    }
    const id = decodeURIComponent(path.split("/")[3]);
    const session = server.sessions.find((item) => item.id === id);
    if (!session) return respond({}, 404);
    if (path.endsWith("/attachments") && init?.method === "POST") {
      const file = (init.body as FormData).get("file") as File;
      if (uploads++ === server.failUploadAt) return respond({}, 500);
      const attachment = {
        id: `att-${uploads}`,
        filename: file.name,
        mime: file.type,
        size: file.size,
        kind: file.type.startsWith("image/") ? "image" : "file",
      };
      server.uploads.push({ session: id, name: file.name, type: file.type });
      server.stored.get(id)!.add(attachment.id);
      return respond(attachment);
    }
    if (path.endsWith("/attachments"))
      return respond([...server.stored.get(id)!].map((item) => ({ id: item, filename: "x", kind: "file", size: 1 })));
    if (path.includes("/attachments/") && init?.method === "DELETE") {
      const attachment = path.split("/").pop()!;
      server.deletes.push(attachment);
      server.stored.get(id)!.delete(attachment);
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/events"))
      return respond({
        events: server.events.get(id) ?? [],
        has_more: server.hasMore,
        pending_questions: { questions: [], as_of_sequence: 0, revision: 0 },
      });
    if (path.endsWith("/input")) {
      const body = JSON.parse(String(init?.body));
      if (server.expire) {
        server.stored.get(id)!.delete(server.expire);
        server.expire = undefined;
      }
      const missing = (body.attachments ?? []).find((item: string) => !server.stored.get(id)!.has(item));
      if (missing) return respond({ detail: `attachment not found: ${missing}` }, 404);
      server.beforeInput?.();
      server.inputs.push({ session: id, text: body.text, attachments: body.attachments });
      return respond({ session });
    }
    return respond({ session });
  });
  const file = async (name: string, content = "hello") => {
    const path = join(directory, name);
    await writeFile(path, content);
    return path;
  };
  const clipboardRoot = join(directory, "clipboard-attachments");
  const clipboard = new ClipboardFiles(clipboardRoot, store);
  const controller = (forceNew = false) =>
    new QuickChatController(
      connection,
      store,
      async () => undefined,
      { destination: { kind: forceNew ? "new" : "quick" }, clipboardFiles: clipboard },
      client,
      () => 1_000_000,
    );
  const setDefaults = async (patch: Record<string, unknown>) =>
    store.transaction(connection.id, async (saved, persist) => {
      saved.defaults = { ...saved.defaults, ...patch };
      await persist();
    });
  return {
    store,
    storage,
    values,
    writes,
    server,
    client,
    controller,
    file,
    setDefaults,
    clipboard,
    clipboardRoot,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("compose sends create the session, upload typed files, then send their IDs with the composed text", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.setComposeText("Review these");
  await c.stageContext("selection", "picked text");
  const added = await c.addFiles([await f.file("shot.png"), await f.file("notes.md")]);
  assert.deepEqual([added.problems, added.staged.length], [[], 2]);
  assert.equal(await c.send(true), true);
  assert.deepEqual(f.server.uploads, [
    { session: "created-1", name: "shot.png", type: "image/png" },
    { session: "created-1", name: "notes.md", type: "application/octet-stream" },
  ]);
  assert.deepEqual(f.server.inputs, [
    {
      session: "created-1",
      text: "Review these\n\nSelected text:\n\n```text\npicked text\n```",
      attachments: ["att-1", "att-2"],
    },
  ]);
  assert.deepEqual(c.getSnapshot().compose, { context: [], files: [] });
  assert.equal(c.composeText(), "");
  assert.equal(await f.store.drafts.read(draftKeys.compose(connection.id, "quick")), "");
  assert.equal((await f.store.load(connection.id)).compose?.quick, undefined);
  await f.close();
});

test("a failed upload keeps earlier references, and the next send reuses them without re-uploading", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.addFiles([await f.file("a.txt"), await f.file("b.txt")]);
  f.server.failUploadAt = 1;
  assert.equal(await c.send(true), false);
  assert.match(c.getSnapshot().error!, /Could not upload b.txt/);
  assert.equal(f.server.inputs.length, 0);
  const saved = (await f.store.load(connection.id)).compose!.quick;
  assert.equal(saved.files[0].upload?.attachmentId, "att-1");
  assert.equal(saved.files[1].upload, undefined);
  assert.equal(saved.sessionId, "created-1");
  assert.equal(await c.send(true), true);
  assert.deepEqual(f.server.inputs[0].attachments, ["att-1", "att-3"]);
  assert.equal(f.server.creates, 1, "the created session is reused");
  await f.close();
});

test("an expired upload is refreshed once within the same send", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.addFiles([await f.file("a.txt")]);
  f.server.expire = "att-1";
  assert.equal(await c.send(true), true);
  assert.deepEqual(f.server.inputs, [{ session: "created-1", text: "", attachments: ["att-2"] }]);
  await f.close();
});

test("local checks and agent capability fail before anything is created", async () => {
  const f = await fixture({ attachments: false });
  const c = f.controller();
  await c.start();
  const { problems, staged } = await c.addFiles([join(tmpdir(), "missing-file-for-tests.txt")]);
  assert.match(problems[0], /no longer available/);
  assert.deepEqual(staged, []);
  await c.addFiles([await f.file("a.txt")]);
  assert.equal(await c.send(true), false);
  assert.match(c.getSnapshot().error!, /doesn't accept attachments/);
  assert.equal(f.server.creates, 0);
  await f.close();
});

test("removing files deletes unsent uploads, while unconfirmed sends only forget theirs", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.addFiles([await f.file("a.txt"), await f.file("b.txt")]);
  f.server.failUploadAt = 1;
  await c.send(true);
  const [first] = c.getSnapshot().compose.files;
  await c.removeFiles([first.id]);
  assert.deepEqual(f.server.deletes, ["att-1"]);

  await f.store.transaction(connection.id, async (saved, persist) => {
    saved.compose!.quick.files[0].upload = { sessionId: "created-1", attachmentId: "att-9", uploadedAt: 1_000_000 };
    saved.pending = {
      kind: "input",
      operationId: "op",
      sessionId: "created-1",
      text: "",
      draftKey: "quick",
      startedAt: 1,
      attachments: ["att-9"],
    };
    await persist();
  });
  const reopened = f.controller();
  await reopened.start();
  await reopened.removeFiles([]);
  await reopened.abandonPending();
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pending, undefined);
  assert.equal(saved.compose!.quick.files[0].upload, undefined);
  assert.deepEqual(f.server.deletes, ["att-1"], "a possibly delivered upload is never deleted");
  await f.close();
});

test("a password SSH target asks to connect, rejects a wrong password, and resumes the send", async () => {
  const f = await fixture({ target: "password" });
  await f.setDefaults({ target: "ssh-1" });
  f.server.sshRequired = true;
  const c = f.controller();
  await c.start();
  await c.changeDraft("hello remote");
  assert.equal(await c.send(), false);
  assert.equal(c.getSnapshot().sshTarget, "ssh-1");
  assert.match(c.getSnapshot().error!, /Connect Build Box/);
  assert.equal((await f.store.load(connection.id)).pending, undefined);
  assert.deepEqual(await c.connectTarget("wrong"), { connected: false, detail: "Permission denied" });
  assert.equal(f.server.inputs.length, 0);
  assert.equal((await c.connectTarget("right")).connected, true);
  assert.deepEqual(f.server.inputs, [{ session: "created-1", text: "hello remote", attachments: undefined }]);
  assert.equal(c.getSnapshot().sshTarget, undefined);
  assert.ok(!JSON.stringify(await f.store.load(connection.id)).includes("right"), "the password is never stored");
  await f.close();
});

test("key-auth targets keep the plain error, and remote Codex-like agents can't take attachments", async () => {
  const f = await fixture({ target: "key" });
  await f.setDefaults({ target: "ssh-1" });
  f.server.sshRequired = true;
  const c = f.controller();
  await c.start();
  await c.changeDraft("hello");
  await c.send();
  assert.equal(c.getSnapshot().sshTarget, undefined);
  f.server.sshRequired = false;
  await c.addFiles([await f.file("a.txt")]);
  assert.equal(await c.send(true), false);
  assert.match(c.getSnapshot().error!, /remote target/);
  await f.close();
});

test("New Chat continues the session its unsent draft created, but not one that already has input", async () => {
  const f = await fixture();
  const first = f.controller(true);
  await first.start();
  await first.addFiles([await f.file("a.txt")]);
  f.server.failUploadAt = 0;
  await first.send(true);
  assert.equal(f.server.creates, 1);
  const reopened = f.controller(true);
  await reopened.start();
  assert.equal(reopened.getSnapshot().session?.id, "created-1");
  f.server.events.set("created-1", [{ ...eventWire(1, "user_input", "from elsewhere", "", "created-1") }]);
  const again = f.controller(true);
  await again.start();
  assert.equal(again.getSnapshot().session, undefined);
  f.server.events.set("created-1", [{ ...eventWire(9, "agent_output", "later", "", "created-1") }]);
  f.server.hasMore = true;
  const earlier = f.controller(true);
  await earlier.start();
  assert.equal(earlier.getSnapshot().session, undefined, "earlier history may hold input");
  f.server.hasMore = false;
  f.server.events.delete("created-1");
  await f.setDefaults({ permission: "plan" });
  const changed = f.controller(true);
  await changed.start();
  assert.equal(changed.getSnapshot().session, undefined, "new defaults start a new session");
  await f.close();
});

test("large context is refused and the single-line draft moves into an empty compose draft once", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.stageContext("clipboard", "x".repeat(256 * 1024 + 1));
  assert.match(c.getSnapshot().error!, /larger than 256 KB/);
  for (let index = 0; index < 4; index++) await c.stageContext("clipboard", "y".repeat(256 * 1024));
  assert.equal(c.getSnapshot().compose.context.length, 4);
  await c.stageContext("clipboard", "z");
  assert.match(c.getSnapshot().error!, /1 MB of context/);
  for (const item of c.getSnapshot().compose.context) await c.removeContext(item.id);
  await c.changeDraft("typed in the search bar");
  await c.openCompose();
  assert.equal(c.composeText(), "typed in the search bar");
  assert.equal(c.getSnapshot().draft, "");
  assert.equal(await f.store.drafts.read(draftKeys.line(connection.id, "quick")), "");
  assert.equal(await f.store.drafts.read(draftKeys.compose(connection.id, "quick")), "typed in the search bar");
  await f.close();
});

test("compose keystrokes publish only when a draft appears or empties, and never write Quick Chat state", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  let published = 0;
  c.subscribe(() => published++);
  f.writes.length = 0;
  for (const text of ["H", "He", "Hel", "Hell", "Hello"]) await c.setComposeText(text);
  assert.equal(published, 1, "only the first keystroke creates a draft");
  assert.equal(c.getSnapshot().hasDraft, true);
  await c.setComposeText("");
  assert.equal(published, 2);
  assert.equal(c.getSnapshot().hasDraft, false);
  assert.ok(f.writes.every((key) => key === draftKeys.compose(connection.id, "quick")));
  assert.equal(await f.store.drafts.read(draftKeys.compose(connection.id, "quick")), "");
  await f.close();
});

test("text typed while a send is in flight is kept; text that was sent is cleared", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.setComposeText("First message");
  f.server.beforeInput = () => void c.setComposeText("Typed during send");
  assert.equal(await c.send(true), true);
  assert.equal(f.server.inputs[0].text, "First message");
  assert.equal(c.composeText(), "Typed during send");
  assert.equal(await f.store.drafts.read(draftKeys.compose(connection.id, "quick")), "Typed during send");
  f.server.beforeInput = undefined;
  const epoch = c.getSnapshot().composeEpoch;
  assert.equal(await c.send(true), true);
  assert.equal(c.composeText(), "");
  assert.ok(c.getSnapshot().composeEpoch > epoch, "the form is told to read the cleared text");
  await f.close();
});

test("drafts saved in Quick Chat state before per-key storage are carried over once", async () => {
  const f = await fixture();
  await f.store.transaction(connection.id, async (state, persist) => {
    state.drafts.quick = "old line";
    state.compose = { quick: { text: "old compose", context: [], files: [] } };
    await persist();
  });
  const c = f.controller();
  await c.start();
  assert.equal(c.getSnapshot().draft, "old line");
  assert.equal(c.composeText(), "old compose");
  assert.equal(await f.store.drafts.read(draftKeys.line(connection.id, "quick")), "old line");
  assert.equal(await f.store.drafts.read(draftKeys.compose(connection.id, "quick")), "old compose");
  await c.changeDraft("");
  const reopened = f.controller();
  await reopened.start();
  assert.equal(reopened.getSnapshot().draft, "", "a cleared per-key draft wins over the old field");
  await f.close();
});

test("a failed draft save shows the saved files again, and the send matches them", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.setComposeText("Files");
  await c.addFiles([await f.file("kept.txt")]);
  f.storage.failState = true;
  await c.addFiles([await f.file("unsaved.txt")]);
  assert.match(c.getSnapshot().error!, /Storage unavailable/);
  assert.deepEqual(
    c.getSnapshot().compose.files.map((file) => file.name),
    ["kept.txt"],
  );
  f.storage.failState = false;
  assert.equal(await c.send(true), true);
  assert.deepEqual(
    f.server.uploads.map((upload) => upload.name),
    ["kept.txt"],
  );
  await f.close();
});

test("staging context reports whether it was saved, even after an earlier error", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  assert.equal(await c.stageContext("clipboard", "x".repeat(256 * 1024 + 1)), false);
  assert.ok(c.getSnapshot().error);
  assert.equal(await c.stageContext("clipboard", "small"), true);
  assert.equal(c.getSnapshot().error, undefined);
  f.storage.failState = true;
  assert.equal(await c.stageContext("selection", "unsaved"), false);
  assert.deepEqual(
    c.getSnapshot().compose.context.map((item) => item.text),
    ["small"],
  );
  await f.close();
});

test("when an earlier save fails and a later one succeeds, the form shows what was saved", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  f.storage.failNextState = true;
  const first = c.stageContext("clipboard", "one");
  const second = c.stageContext("clipboard", "two");
  assert.deepEqual([await first, await second], [false, true]);
  const saved = (await f.store.read(connection.id)).compose!.quick.context.map((item) => item.text);
  assert.deepEqual(saved, ["one", "two"]);
  assert.deepEqual(
    c.getSnapshot().compose.context.map((item) => item.text),
    saved,
  );
  await f.close();
});

test("a failed stage keeps the search-bar text, and a failed discard keeps the draft", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.changeDraft("typed in the search bar");
  f.storage.failState = true;
  assert.equal(await c.stageContext("clipboard", "context"), false);
  assert.equal(c.getSnapshot().draft, "typed in the search bar");
  assert.equal(c.composeText(), "");
  f.storage.failState = false;
  assert.equal(await c.stageContext("clipboard", "context"), true);
  assert.equal(c.composeText(), "typed in the search bar");
  f.storage.failState = true;
  assert.equal(await c.discardCompose(), false);
  assert.equal(c.composeText(), "typed in the search bar");
  assert.equal(c.getSnapshot().compose.context.length, 1);
  await f.close();
});

test("a save issued while a failed save reads storage is not undone", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  let second!: Promise<boolean>;
  f.storage.failNextState = true;
  f.storage.afterFailedRead = () => (second = c.stageContext("clipboard", "two"));
  assert.equal(await c.stageContext("clipboard", "one"), false);
  assert.equal(await second, true);
  const saved = (await f.store.read(connection.id)).compose!.quick.context.map((item) => item.text);
  assert.deepEqual(saved, ["one", "two"]);
  assert.deepEqual(
    c.getSnapshot().compose.context.map((item) => item.text),
    saved,
  );
  await f.close();
});

test("sent text leaves the form and search bar before its draft is saved empty", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  const seen: string[] = [];
  f.storage.beforeWrite = (key, value) => {
    if (key === draftKeys.compose(connection.id, "quick") && value === "")
      seen.push(`compose epoch=${c.getSnapshot().composeEpoch} text=${c.composeText()}`);
    if (key === draftKeys.line(connection.id, "quick") && value === "")
      seen.push(`line draft=${c.getSnapshot().draft}`);
  };
  await c.setComposeText("Composed");
  const epoch = c.getSnapshot().composeEpoch;
  assert.equal(await c.send(true), true);
  await c.changeDraft("Typed");
  assert.equal(await c.send(), true);
  assert.deepEqual(seen, [`compose epoch=${epoch + 1} text=`, "line draft="]);
  await f.close();
});

test("files picked as a send starts are not saved over what it sent", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.setComposeText("Sending");
  await c.stageContext("clipboard", "sent once");
  const adding = c.addFiles([await f.file("late.txt")]);
  const sending = c.send(true);
  assert.deepEqual(await adding, {
    problems: ["A message is being sent. Add the files again when it finishes."],
    staged: [],
  });
  assert.equal(await sending, true);
  assert.equal((await f.store.read(connection.id)).compose?.quick, undefined);
  assert.deepEqual(f.server.uploads, []);
  await f.close();
});

test("starting a session with changed settings creates it at once and leaves the defaults", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  c.changeDraft("first");
  assert.equal(await c.send(), true);
  const defaults = c.getSnapshot().defaults!;
  let refused: Promise<unknown> | undefined;
  f.server.beforeInput = () => {
    refused = c.createSession({ ...defaults, cwd: "/refused" }).catch((error: unknown) => error);
  };
  c.changeDraft("second");
  assert.equal(await c.send(), true);
  assert.match(String(await refused), /being sent/);
  f.server.beforeInput = undefined;
  assert.equal((await c.createSession({ ...defaults, cwd: "/elsewhere" })).kind, "created");
  assert.equal(c.getSnapshot().session?.id, "created-2");
  assert.equal((await f.store.load(connection.id)).defaults.cwd, defaults.cwd);
  c.changeDraft("third");
  assert.equal(await c.send(), true);
  assert.deepEqual(
    f.server.sessions.map((session) => session.cwd),
    ["/workspace", "/elsewhere"],
  );
  assert.deepEqual(
    f.server.inputs.map((input) => input.session),
    ["created-1", "created-1", "created-2"],
  );
  await f.close();
});

// Writes image data when asked for a path, like the pasteboard script; otherwise reports what the copy held.
function fakeClipboard(
  copy: Partial<ClipboardReading> & { png?: boolean },
): ClipboardReader & { paths: (string | undefined)[] } {
  const paths: (string | undefined)[] = [];
  return {
    paths,
    async read(imagePath) {
      paths.push(imagePath);
      const files = copy.files ?? [];
      const saved = copy.png && !files.length && imagePath;
      if (saved) await writeFile(imagePath, "png bytes");
      return { files, text: copy.text ?? "", image: saved ? "saved" : copy.png ? "present" : "none" };
    },
  };
}
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const ownedDirectories = (root: string) => readdir(root).catch(() => [] as string[]);

test("a copied image is saved, attached and sent, then deleted; a picked file is kept", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.setComposeText("Look");
  const result = await stageClipboard(c, fakeClipboard({ png: true, text: "" }), f.clipboard);
  assert.deepEqual(result, { staged: true, notice: { failed: false, title: "Attached clipboard image" } });
  const [image] = c.getSnapshot().compose.files;
  assert.match(image.name, /^Clipboard image \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/);
  assert.equal(f.clipboard.ownedId(image.path) !== undefined, true);
  const picked = await f.file("picked.txt");
  await c.addFiles([picked]);
  assert.equal(await c.send(true), true);
  assert.deepEqual(
    f.server.uploads.map((upload) => upload.type),
    ["image/png", "application/octet-stream"],
  );
  await f.clipboard.settled();
  assert.deepEqual(await ownedDirectories(f.clipboardRoot), []);
  assert.equal(await exists(picked), true);
  await f.close();
});

test("copied files are attached together and their names are never staged as text", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  const paths = [await f.file("one.txt"), await f.file("two.txt")];
  const reader = fakeClipboard({ files: paths, text: "one.txt" });
  assert.deepEqual(await stageClipboard(c, reader, f.clipboard), {
    staged: true,
    notice: { failed: false, title: "Attached 2 files" },
  });
  assert.deepEqual(
    c.getSnapshot().compose.files.map((file) => file.path),
    paths,
  );
  assert.deepEqual(c.getSnapshot().compose.context, []);
  assert.deepEqual(await ownedDirectories(f.clipboardRoot), [], "the unused image directory is removed");
  await f.close();
});

test("an agent without attachments refuses copied files and images before anything is written", async () => {
  const f = await fixture({ attachments: false });
  const c = f.controller();
  await c.start();
  const finder = fakeClipboard({ files: [await f.file("report.pdf")], text: "report.pdf" });
  assert.deepEqual(await stageClipboard(c, finder, f.clipboard), {
    staged: false,
    notice: { failed: true, title: "Can't attach the clipboard", message: "This agent doesn't accept attachments." },
  });
  const image = fakeClipboard({ png: true });
  assert.equal((await stageClipboard(c, image, f.clipboard)).staged, false);
  assert.deepEqual(image.paths, [undefined], "no image path is offered");
  const sheet = fakeClipboard({ png: true, text: "a\tb" });
  assert.deepEqual(await stageClipboard(c, sheet, f.clipboard), {
    staged: true,
    notice: {
      failed: false,
      title: "Included clipboard text",
      message: "Image not attached: This agent doesn't accept attachments.",
    },
  });
  assert.deepEqual(
    c.getSnapshot().compose.context.map((item) => item.text),
    ["a\tb"],
  );
  assert.deepEqual(c.getSnapshot().compose.files, []);
  assert.deepEqual(await ownedDirectories(f.clipboardRoot), []);
  await f.close();
});

test("an image that never entered the draft is deleted at once; one whose save failed is left for collection", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  const empty = fakeClipboard({ png: true });
  const original = empty.read;
  empty.read = async (path) => {
    const reading = await original(path);
    await writeFile(path!, "");
    return reading;
  };
  const refused = await stageClipboard(c, empty, f.clipboard);
  assert.equal(refused.staged, false);
  assert.match(refused.notice!.message!, /Empty files cannot be attached/);
  assert.deepEqual(await ownedDirectories(f.clipboardRoot), []);
  f.storage.failState = true;
  assert.equal((await stageClipboard(c, fakeClipboard({ png: true }), f.clipboard)).staged, true);
  assert.equal((await ownedDirectories(f.clipboardRoot)).length, 1, "a queued save may still name it");
  await f.close();
});

test("removing or discarding a copied image deletes it", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await stageClipboard(c, fakeClipboard({ png: true }), f.clipboard);
  assert.equal(await c.removeFiles(c.getSnapshot().compose.files.map((file) => file.id)), true);
  await f.clipboard.settled();
  assert.deepEqual(await ownedDirectories(f.clipboardRoot), []);
  await stageClipboard(c, fakeClipboard({ png: true }), f.clipboard);
  assert.equal(await c.discardCompose(), true);
  await f.clipboard.settled();
  assert.deepEqual(await ownedDirectories(f.clipboardRoot), []);
  await f.close();
});

test("a send whose final save fails, or whose outcome is unconfirmed, keeps its copied image", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.setComposeText("Look");
  await stageClipboard(c, fakeClipboard({ png: true }), f.clipboard);
  f.server.beforeInput = () => void (f.storage.failState = true);
  assert.equal(await c.send(true), false);
  await f.clipboard.settled();
  assert.equal((await ownedDirectories(f.clipboardRoot)).length, 1);
  await f.close();

  const g = await fixture();
  const d = g.controller();
  await d.start();
  await d.setComposeText("Look");
  await stageClipboard(d, fakeClipboard({ png: true }), g.clipboard);
  g.server.beforeInput = () => {
    throw new Error("connection dropped");
  };
  assert.equal(await d.send(true), false);
  assert.equal(d.getSnapshot().pending?.kind, "input");
  await g.clipboard.settled();
  assert.equal((await ownedDirectories(g.clipboardRoot)).length, 1);
  await g.close();
});

test("a copied image another server's draft still names is kept when this draft drops it", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await stageClipboard(c, fakeClipboard({ png: true }), f.clipboard);
  const [image] = c.getSnapshot().compose.files;
  f.values.set("waypoint.quick-chat.server-b", JSON.stringify({ damaged: image.path }));
  assert.equal(await c.discardCompose(), true);
  await f.clipboard.settled();
  assert.equal(await exists(image.path), true);
  await f.close();
});
