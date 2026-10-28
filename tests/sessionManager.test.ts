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
    {
      getItem: async (key) => values.get(key),
      setItem: async (key, value) => void values.set(key, value),
      keys: async () => [...values.keys()],
      entries: async () => [...values],
      removeItem: async (key) => void values.delete(key),
    },
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
    directory,
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
    f.add("e", { status: "error" });
    f.failures.set("DELETE /api/sessions/e", () => {
      f.add("e", { status: "exited" });
      return respond({}, 502);
    });
    const partial = await f.manager.remove("e", metadata);
    assert.equal(partial.kind, "failed");
    assert.equal(partial.kind === "failed" && partial.session?.status, "exited");
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
    f.add("raced", { status: "exited" });
    f.failures.set("DELETE /api/sessions/raced", () => {
      // A Quick Chat send started a checkpoint for the session while it was being deleted.
      void f.store.transaction(connection.id, async (state, persist) => {
        setPointer(state, "raced", 2000);
        state.pending = {
          kind: "reattach",
          operationId: "op",
          sessionId: "raced",
          text: "",
          draftKey: "quick",
          startedAt: 1,
        };
        await persist();
      });
      f.sessions.delete("raced");
      return respond({ deleted: "raced" });
    });
    await f.manager.remove("raced", metadata);
    const raced = await f.store.read(connection.id);
    assert.equal(raced.pointer, "raced");
    assert.equal(raced.pending?.sessionId, "raced");
    await f.store.transaction(connection.id, async (state, persist) => {
      setPointer(state, "kept", 1000);
      state.pending = undefined;
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
    assert.match(again.kind === "stale" ? again.message : "", /already Quick Chat's destination/);
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

test("delete rechecks the session once it holds the server lock", async () => {
  const f = await fixture();
  try {
    f.add("s", { status: "exited" });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A Quick Chat send reattaches the session while the delete waits for the lock.
    const send = f.store.transaction(connection.id, async () => {
      await held;
      f.sessions.get("s")!.status = "idle";
    });
    const removal = f.manager.remove("s", metadata);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await send;
    const outcome = await removal;
    assert.equal(outcome.kind, "stale");
    assert.ok(f.sessions.has("s"));
    assert.ok(!f.calls.includes("DELETE /api/sessions/s"));
  } finally {
    await f.close();
  }
});

test("a failure before anything is sent says what went wrong locally", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "session-manager-broken-"));
  try {
    f.add("s", { status: "exited" });
    const broken = new SessionManager(
      connection,
      new QuickChatStore(
        {
          getItem: async () => "{not json",
          setItem: async () => undefined,
          keys: async () => [],
          entries: async () => [],
          removeItem: async () => undefined,
        },
        new ServerMutex(dir),
      ),
      new WaypointClient(connection.apiUrl, async () => respond({ session: sessionWire("s") })),
    );
    const outcome = await broken.useForQuickChat("s", metadata);
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.kind === "failed" ? outcome.message : "", /Saved Quick Chat data could not be read/);
    const removal = await broken.remove("s", metadata);
    assert.equal(removal.kind, "failed");
    assert.match(removal.kind === "failed" ? removal.message : "", /Saved Quick Chat data could not be read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await f.close();
  }
});

const referenced = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const saved = await f.store.read(connection.id);
  return { pointer: saved.pointer, chosen: saved.chosen, bound: saved.compose?.new?.sessionId };
};
const useIn = (f: Awaited<ReturnType<typeof fixture>>, pointer: string, bound: string) =>
  f.store.transaction(connection.id, async (state, persist) => {
    setPointer(state, pointer, 1000);
    state.compose = { new: { context: [], files: [], sessionId: bound, launch: "fingerprint" } };
    await persist();
  });

test("terminating a session Quick Chat uses releases it, and only a definite refusal puts it back", async () => {
  const f = await fixture();
  try {
    for (const id of ["dest", "plain"]) f.add(id, { status: "running" });
    await useIn(f, "dest", "dest");
    const plain = await f.manager.terminate("plain", metadata);
    assert.equal(plain.kind === "done" && plain.releasedQuickChat, undefined);
    assert.deepEqual(await referenced(f), { pointer: "dest", chosen: { sessionId: "dest", at: 1000 }, bound: "dest" });

    f.failures.set("POST /api/sessions/dest/terminate", () => respond({ detail: "target busy" }, 409));
    assert.equal((await f.manager.terminate("dest", metadata)).kind, "failed");
    assert.deepEqual(await referenced(f), { pointer: "dest", chosen: { sessionId: "dest", at: 1000 }, bound: "dest" });

    f.failures.set("POST /api/sessions/dest/terminate", () => respond({}, 502));
    const uncertain = await f.manager.terminate("dest", metadata);
    assert.equal(uncertain.kind === "failed" && uncertain.uncertain, true);
    assert.deepEqual(await referenced(f), { pointer: undefined, chosen: undefined, bound: undefined });

    f.failures.clear();
    await useIn(f, "dest", "dest");
    const done = await f.manager.terminate("dest", metadata);
    assert.equal(done.kind === "done" && done.releasedQuickChat, true);
    assert.deepEqual(await referenced(f), { pointer: undefined, chosen: undefined, bound: undefined });
  } finally {
    await f.close();
  }
});

test("with an unconfirmed operation, terminate still goes through and Quick Chat keeps the session", async () => {
  for (const owner of ["dest", "other"]) {
    const f = await fixture();
    try {
      f.add("dest", { status: "running" });
      await useIn(f, "dest", "dest");
      await f.store.transaction(connection.id, async (state, persist) => {
        state.pending = {
          kind: "input",
          operationId: "op",
          sessionId: owner,
          text: "x",
          draftKey: "quick",
          startedAt: 1,
        };
        await persist();
      });
      const outcome = await f.manager.terminate("dest", metadata);
      assert.equal(outcome.kind === "done" && outcome.releasedQuickChat, undefined, owner);
      assert.equal(f.sessions.get("dest")!.status, "exited");
      assert.equal((await referenced(f)).pointer, "dest", owner);
    } finally {
      await f.close();
    }
  }
});

test("a server lock held by another command doesn't stop terminate", async () => {
  const f = await fixture();
  try {
    f.add("dest", { status: "running" });
    await useIn(f, "dest", "dest");
    // Another command has its own queue, so this command waits for the lock and gives up rather than queueing.
    const other = new QuickChatStore(
      {
        getItem: async () => undefined,
        setItem: async () => undefined,
        keys: async () => [],
        entries: async () => [],
        removeItem: async () => undefined,
      },
      new ServerMutex(f.directory, 2500, { queues: new Map() }),
    );
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = other.transaction(connection.id, async () => {
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    const outcome = await f.manager.terminate("dest", metadata);
    release();
    await holder;
    assert.equal(outcome.kind === "done" && outcome.releasedQuickChat, undefined);
    assert.equal(f.sessions.get("dest")!.status, "exited");
    assert.equal((await referenced(f)).pointer, "dest");
  } finally {
    await f.close();
  }
});

test("terminate on a session Quick Chat doesn't use skips the lock, and a moved destination isn't released", async () => {
  const f = await fixture();
  try {
    for (const id of ["dest", "plain", "moved"]) f.add(id, { status: "running" });
    await useIn(f, "dest", "dest");
    const other = new QuickChatStore(
      {
        getItem: async () => undefined,
        setItem: async () => undefined,
        keys: async () => [],
        entries: async () => [],
        removeItem: async () => undefined,
      },
      new ServerMutex(f.directory, 2500, { queues: new Map() }),
    );
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = other.transaction(connection.id, async () => {
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    const started = Date.now();
    assert.equal((await f.manager.terminate("plain", metadata)).kind, "done");
    assert.ok(Date.now() - started < 1000, "it didn't wait for the lock");
    release();
    await holder;

    // The destination moves to another session after the unlocked read and before the lock.
    await useIn(f, "moved", "moved");
    const read = f.store.read.bind(f.store);
    f.store.read = async (id: string) => {
      const state = await read(id);
      f.store.read = read;
      await useIn(f, "dest", "dest");
      return state;
    };
    const outcome = await f.manager.terminate("moved", metadata);
    assert.equal(outcome.kind === "done" && outcome.releasedQuickChat, undefined);
    assert.equal(f.sessions.get("moved")!.status, "exited");
    assert.deepEqual(await referenced(f), { pointer: "dest", chosen: { sessionId: "dest", at: 1000 }, bound: "dest" });
  } finally {
    await f.close();
  }
});

test("terminate and delete removes a live session and classifies failures", async () => {
  const f = await fixture();
  try {
    f.add("live", { status: "running" });
    assert.equal((await f.manager.remove("live", metadata)).kind, "stale", "plain delete still needs an ended session");
    await useIn(f, "live", "live");
    const done = await f.manager.terminateAndRemove("live", metadata);
    assert.deepEqual(done, { kind: "done", deleted: "live", releasedQuickChat: true });
    assert.ok(f.calls.includes("DELETE /api/sessions/live"));
    assert.ok(!f.calls.includes("POST /api/sessions/live/terminate"));
    assert.deepEqual(await referenced(f), { pointer: undefined, chosen: undefined, bound: undefined });

    f.add("refused", { status: "running" });
    await useIn(f, "refused", "refused");
    f.failures.set("DELETE /api/sessions/refused", () => respond({ detail: "target busy" }, 409));
    const refused = await f.manager.terminateAndRemove("refused", metadata);
    assert.equal(refused.kind === "failed" && refused.uncertain, false);
    assert.equal((await referenced(f)).pointer, "refused", "a definite refusal puts Quick Chat's session back");

    f.failures.set("DELETE /api/sessions/refused", () => {
      f.add("refused", { status: "exited" });
      return respond({}, 502);
    });
    const uncertain = await f.manager.terminateAndRemove("refused", metadata);
    assert.equal(uncertain.kind === "failed" && uncertain.uncertain, true, "it may still be deleting");
    assert.equal(uncertain.kind === "failed" && uncertain.session?.status, "exited");
    assert.equal((await referenced(f)).pointer, undefined);

    f.add("ended", { status: "running" });
    await useIn(f, "ended", "ended");
    f.failures.set("DELETE /api/sessions/ended", () => {
      f.add("ended", { status: "exited" });
      return respond({ detail: "worktree has changes" }, 409);
    });
    const partial = await f.manager.terminateAndRemove("ended", metadata);
    assert.equal(partial.kind === "failed" && !partial.uncertain && partial.session?.status, "exited");
    assert.equal((await referenced(f)).pointer, undefined, "it ended, so Quick Chat doesn't go back to it");

    await useIn(f, "missing", "missing");
    const gone = await f.manager.terminateAndRemove("missing", metadata);
    assert.equal(gone.kind === "failed" && gone.gone, true);
    assert.deepEqual(await referenced(f), { pointer: undefined, chosen: undefined, bound: undefined });

    f.add("exited", { status: "exited" });
    await useIn(f, "exited", "exited");
    f.failures.set("DELETE /api/sessions/exited", () => respond({ detail: "not allowed" }, 403));
    assert.equal((await f.manager.remove("exited", metadata)).kind, "failed");
    assert.equal((await referenced(f)).pointer, "exited", "a refused plain delete leaves Quick Chat alone");
  } finally {
    await f.close();
  }
});
