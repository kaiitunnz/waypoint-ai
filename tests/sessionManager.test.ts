import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WaypointClient } from "../src/api/client";
import { parseMetadata } from "../src/api/contracts";
import { SessionManager } from "../src/hooks/sessionManager";
import { QuickChatStore, setPointer } from "../src/storage/quickChat";
import { ServerMutex } from "../src/storage/mutex";
import { metadataWire, sessionWire } from "./fixtures/conversation";

const connection = { id: "server-a", apiUrl: "http://localhost", name: "A", token: "fixture-token" };
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const metadata = parseMetadata({
  ...metadataWire,
  launch_targets: [
    { id: "lab", name: "Lab Box", kind: "ssh", auth: "password", agents: ["test-agent"] },
    { id: "keys", name: "Key Box", kind: "ssh", auth: "key", agents: ["test-agent"] },
  ],
  backends: metadataWire.backends.map((backend) => ({
    ...backend,
    transport_capabilities: { ...backend.transport_capabilities, supports_reattach_after_exit: true },
  })),
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "session-manager-tests-"));
  const values = new Map<string, string>();
  const store = new QuickChatStore(
    { getItem: async (key) => values.get(key), setItem: async (key, value) => void values.set(key, value) },
    new ServerMutex(directory),
  );
  const sessions = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const failures = new Map<string, () => Response>();
  const client = new WaypointClient(connection.apiUrl, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push(`${method} ${path}`);
    const failure = failures.get(`${method} ${path}`);
    if (failure) return failure();
    const [, , , rawId, action] = path.split("/");
    const id = decodeURIComponent(rawId ?? "");
    const session = sessions.get(id);
    if (!session) return respond({ detail: "session not found" }, 404);
    if (method === "DELETE" && !action) {
      sessions.delete(id);
      return respond({ deleted: id });
    }
    if (action === "pin") session.pinned_at = method === "POST" ? "2026-10-26T00:00:00Z" : null;
    if (action === "title") session.title = JSON.parse(String(init?.body)).title;
    if (action === "terminate") session.status = "exited";
    if (action === "interrupt") session.status = "interrupted";
    if (action === "reattach") session.status = "idle";
    return respond({ session });
  });
  const add = (id: string, patch: Record<string, unknown> = {}) => {
    sessions.set(id, { ...sessionWire(id), ...patch });
  };
  let now = 5000;
  const manager = new SessionManager(connection, store, client, () => now);
  return {
    store,
    sessions,
    calls,
    failures,
    add,
    manager,
    tick: () => (now += 1000),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("each action rereads the session and sends one request", async () => {
  const f = await fixture();
  try {
    f.add("s", { status: "running" });
    assert.equal((await f.manager.rename("s", "  New name  ", metadata)).kind, "done");
    assert.equal(f.sessions.get("s")!.title, "New name");
    assert.equal((await f.manager.rename("s", "   ", metadata)).kind, "failed");
    assert.equal((await f.manager.setPinned("s", true, metadata)).kind, "done");
    assert.equal((await f.manager.setPinned("s", false, metadata)).kind, "done");
    assert.equal((await f.manager.interrupt("s", metadata)).kind, "done");
    assert.equal((await f.manager.terminate("s", metadata)).kind, "done");
    assert.equal((await f.manager.reattach("s", metadata)).kind, "done");
    assert.deepEqual(f.calls, [
      "PATCH /api/sessions/s/title",
      "POST /api/sessions/s/pin",
      "DELETE /api/sessions/s/pin",
      "POST /api/sessions/s/interrupt",
      "POST /api/sessions/s/terminate",
      "POST /api/sessions/s/reattach",
    ]);
  } finally {
    await f.close();
  }
});

test("a stale row never restarts a live session or interrupts an idle one", async () => {
  const f = await fixture();
  try {
    f.add("s", { status: "idle" });
    const reattach = await f.manager.reattach("s", metadata);
    assert.equal(reattach.kind, "stale");
    assert.equal((await f.manager.interrupt("s", metadata)).kind, "stale");
    assert.equal((await f.manager.remove("s", metadata)).kind, "stale");
    assert.deepEqual(f.calls, []);
    assert.equal((await f.manager.terminate("missing", metadata)).kind, "failed");
  } finally {
    await f.close();
  }
});

test("reattach on a disconnected password target asks for the password; key targets explain", async () => {
  const f = await fixture();
  try {
    f.add("p", { status: "exited", launch_target_id: "lab" });
    f.add("k", { status: "exited", launch_target_id: "keys" });
    for (const id of ["p", "k"])
      f.failures.set(`POST /api/sessions/${id}/reattach`, () => respond({ detail: "ssh-master-required" }, 409));
    const password = await f.manager.reattach("p", metadata);
    assert.deepEqual(password.kind === "ssh" && password.targetId, "lab");
    const key = await f.manager.reattach("k", metadata);
    assert.equal(key.kind, "failed");
    assert.match(key.kind === "failed" ? key.message : "", /ssh-master-required/);
  } finally {
    await f.close();
  }
});

test("unconfirmed and refused outcomes report fresh state without retrying", async () => {
  const f = await fixture();
  try {
    f.add("s", { status: "running" });
    f.failures.set("POST /api/sessions/s/terminate", () => respond({}, 502));
    const outcome = await f.manager.terminate("s", metadata);
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.kind === "failed" ? outcome.message : "", /didn't confirm/);
    assert.equal(outcome.kind === "failed" && outcome.session?.id, "s");
    assert.equal(f.calls.length, 1);
    f.add("t", { status: "exited" });
    f.failures.set("DELETE /api/sessions/t", () => respond({ detail: "the assistant session cannot be deleted" }, 403));
    const refused = await f.manager.remove("t", metadata);
    assert.match(refused.kind === "failed" ? refused.message : "", /does not allow this/);
    assert.ok(f.sessions.has("t"));
  } finally {
    await f.close();
  }
});

test("delete clears Quick Chat's references but refuses while its checkpoint needs the session", async () => {
  const f = await fixture();
  try {
    f.add("chosen", { status: "exited" });
    f.add("other", { status: "exited" });
    f.add("created", { status: "error", tags: { raycast_create: "op-1" } });
    await f.store.transaction(connection.id, async (state, persist) => {
      setPointer(state, "chosen", 1000);
      state.sentAt = { chosen: 10, other: 20 };
      state.compose = {
        new: {
          text: "",
          context: [],
          sessionId: "chosen",
          launch: "fingerprint",
          files: [
            {
              id: "f",
              path: "/tmp/f",
              name: "f",
              size: 1,
              modifiedMs: 1,
              upload: { sessionId: "chosen", attachmentId: "a", uploadedAt: 1 },
            },
          ],
        },
      };
      state.pending = { kind: "create", operationId: "op-1", text: "", draftKey: "quick", startedAt: 1 };
      await persist();
    });
    const blocked = await f.manager.remove("created", metadata);
    assert.equal(blocked.kind, "stale");
    assert.match(blocked.kind === "stale" ? blocked.message : "", /unconfirmed operation/);
    await f.store.transaction(connection.id, async (state, persist) => {
      state.pending = {
        kind: "reattach",
        operationId: "op-2",
        sessionId: "other",
        text: "",
        draftKey: "quick",
        startedAt: 1,
      };
      await persist();
    });
    assert.equal((await f.manager.remove("other", metadata)).kind, "stale");
    assert.ok(f.sessions.has("other"));
    assert.equal((await f.manager.remove("chosen", metadata)).kind, "done");
    const saved = await f.store.read(connection.id);
    assert.equal(saved.pointer, undefined);
    assert.equal(saved.chosen, undefined);
    assert.deepEqual(saved.sentAt, { other: 20 });
    assert.equal(saved.compose!.new.sessionId, undefined);
    assert.equal(saved.compose!.new.files[0].upload, undefined);
    assert.equal(saved.pending?.sessionId, "other");
  } finally {
    await f.close();
  }
});

test("deleting another session leaves Quick Chat untouched, and a confirmed-gone delete still clears", async () => {
  const f = await fixture();
  try {
    f.add("kept", { status: "idle" });
    f.add("gone", { status: "exited" });
    await f.store.transaction(connection.id, async (state, persist) => {
      setPointer(state, "kept", 1000);
      await persist();
    });
    f.failures.set("DELETE /api/sessions/gone", () => {
      f.sessions.delete("gone");
      return respond({}, 502);
    });
    assert.equal((await f.manager.remove("gone", metadata)).kind, "done");
    const saved = await f.store.read(connection.id);
    assert.equal(saved.pointer, "kept");
    assert.deepEqual(saved.chosen, { sessionId: "kept", at: 1000 });
  } finally {
    await f.close();
  }
});

test("Use for Quick Chat records an explicit choice, and refuses while an operation is unconfirmed", async () => {
  const f = await fixture();
  try {
    f.add("found", { status: "idle" });
    f.add("terminal", { backend: "terminal", transport: "test-terminal" });
    assert.equal((await f.manager.useForQuickChat("terminal", metadata)).kind, "stale");
    assert.equal((await f.manager.useForQuickChat("found", metadata)).kind, "done");
    let saved = await f.store.read(connection.id);
    assert.equal(saved.pointer, "found");
    assert.deepEqual(saved.chosen, { sessionId: "found", at: 5000 });
    assert.deepEqual(await f.manager.quickChat(), { pointer: "found", pending: false });
    const again = await f.manager.useForQuickChat("found", metadata);
    assert.match(again.kind === "stale" ? again.message : "", /already continues/);
    f.add("next", { status: "idle" });
    await f.store.transaction(connection.id, async (state, persist) => {
      state.pending = {
        kind: "input",
        operationId: "op",
        sessionId: "found",
        text: "x",
        draftKey: "quick",
        startedAt: 1,
      };
      await persist();
    });
    assert.equal((await f.manager.useForQuickChat("next", metadata)).kind, "failed");
    saved = await f.store.read(connection.id);
    assert.equal(saved.pointer, "found");
  } finally {
    await f.close();
  }
});

test("delete waits for Quick Chat to check a create whose session failed to start", async () => {
  const f = await fixture();
  try {
    f.add("failed", { status: "error", title: "Quick Chat", cwd: "/workspace", created_at: "2026-10-26T00:00:00Z" });
    await f.store.transaction(connection.id, async (state, persist) => {
      state.pending = {
        kind: "create",
        operationId: "op",
        text: "",
        draftKey: "quick",
        startedAt: Date.parse("2026-10-26T00:00:00Z"),
        launch: { backend: "test-agent", target: "", cwd: "/workspace" },
      };
      await persist();
    });
    assert.equal((await f.manager.remove("failed", metadata)).kind, "stale");
    assert.ok(f.sessions.has("failed"));
  } finally {
    await f.close();
  }
});
