import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WaypointClient } from "../src/api/client";
import { QuickChatController } from "../src/hooks/quickChatController";
import { LockLostError, ServerMutex } from "../src/storage/mutex";
import { QuickChatStore, decodeQuickChat } from "../src/storage/quickChat";
import { eventWire, metadataWire, sessionWire } from "./fixtures/conversation";

const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const connection = { id: "server-a", apiUrl: "http://localhost", name: "A", token: "fixture-token" };

async function fixture(options: { attachments?: boolean; target?: "password" | "key" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "compose-controller-"));
  const values = new Map<string, string>();
  const store = new QuickChatStore(
    { getItem: async (key) => values.get(key), setItem: async (key, value) => void values.set(key, value) },
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
    stored: new Map<string, Set<string>>(),
    uploads: [] as { session: string; name: string; type: string }[],
    deletes: [] as string[],
    inputs: [] as { session: string; text: string; attachments?: string[] }[],
    creates: 0,
    failUploadAt: -1,
    expire: undefined as string | undefined,
    sshRequired: false,
    connects: [] as string[],
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
        has_more: false,
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
  const controller = (forceNew = false) =>
    new QuickChatController(
      connection,
      store,
      async () => undefined,
      forceNew,
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
    server,
    client,
    controller,
    file,
    setDefaults,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("compose sends create the session, upload typed files, then send their IDs with the composed text", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.changeCompose({ text: "Review these" });
  await c.stageContext("selection", "picked text");
  assert.deepEqual(await c.addFiles([await f.file("shot.png"), await f.file("notes.md")]), []);
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
  assert.deepEqual(c.getSnapshot().compose, { text: "", context: [], files: [] });
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
  const problems = await c.addFiles([join(tmpdir(), "missing-file-for-tests.txt")]);
  assert.match(problems[0], /no longer available/);
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
  assert.equal(c.getSnapshot().compose.text, "typed in the search bar");
  assert.equal(c.getSnapshot().draft, "");
  const saved = await f.store.load(connection.id);
  assert.equal(saved.drafts.quick, "");
  assert.equal(saved.compose!.quick.text, "typed in the search bar");
  await f.close();
});

test("a live-pid lock with a stale heartbeat is reclaimed and its fenced holder can no longer write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutex-lease-"));
  let now = 1_000_000;
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key),
    setItem: async (key: string, value: string) => void values.set(key, value),
  };
  const clock = () => now;
  // Separate queues model two commands; a long heartbeat interval stands in for a holder whose work stopped.
  const stalled = new QuickChatStore(
    storage,
    new ServerMutex(directory, 80, { heartbeatMs: 3_600_000, now: clock, queues: new Map() }),
  );
  const other = new QuickChatStore(storage, new ServerMutex(directory, 80, { now: clock, queues: new Map() }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const holder = stalled.transaction("server-a", async (state, persist) => {
    await gate;
    state.drafts.quick = "late write";
    await persist();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(other.draft("server-a", "quick", "blocked"), /still active/, "a fresh heartbeat keeps the lock");
  now += 31_000;
  await other.draft("server-a", "quick", "reclaimed");
  release();
  await assert.rejects(holder, LockLostError);
  assert.equal(decodeQuickChat(values.get("waypoint.quick-chat.server-a")).drafts.quick, "reclaimed");
  await rm(directory, { recursive: true, force: true });
});

test("locks without a heartbeat keep the dead-pid rule", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutex-legacy-"));
  const lock = join(directory, createHash("sha256").update("server-a").digest("hex"));
  await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: "legacy" }));
  await assert.rejects(
    new ServerMutex(directory, 80, { now: () => Date.now() + 1e9 }).run("server-a", async () => 1),
    /still active/,
  );
  await rm(directory, { recursive: true, force: true });
});
