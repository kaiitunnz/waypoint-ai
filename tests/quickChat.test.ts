import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseMetadata } from "../src/api/contracts";
import { WaypointClient } from "../src/api/client";
import { parseSession, parseEvent } from "../src/api/sessions";
import {
  createRequest,
  failedStart,
  failedStartAt,
  initialDefaults,
  ongoing,
  resumeFor,
  reuseDecision,
} from "../src/domain/quickChat";
import { draftKeys } from "../src/storage/drafts";
import { QuickChatStore, decodeQuickChat, lastActivity, setPointer } from "../src/storage/quickChat";
import { ServerMutex } from "../src/storage/mutex";
import { QuickChatController } from "../src/hooks/quickChatController";
import { Workspace } from "../src/storage/workspace";
import { metadataWire, sessionWire, eventWire } from "./fixtures/conversation";

const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const connection = { id: "server-a", apiUrl: "http://localhost", name: "A", token: "fixture-token" };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "quick-chat-tests-"));
  const values = new Map<string, string>();
  let failFinalWrite = false;
  let inputGate: Promise<void> | undefined;
  let sessionGate: Promise<void> | undefined;
  let readGate: Promise<void> | undefined;
  let storageReads = 0;
  let sessionReads = 0;
  const eventQueries: string[] = [];
  // Recorded history per session, served newest first in pages of three like Waypoint's paged reads.
  const history = new Map<string, ReturnType<typeof eventWire>[]>();
  const store = new QuickChatStore(
    {
      keys: async () => [...values.keys()],
      entries: async () => [...values],
      removeItem: async (key) => void values.delete(key),
      getItem: async (key) => {
        storageReads++;
        await readGate;
        return values.get(key);
      },
      setItem: async (key, value) => {
        const state = key.startsWith("waypoint.quick-chat.") ? JSON.parse(value) : undefined;
        if (failFinalWrite && state && !state.pending && Object.keys(state.sentAt).length) {
          failFinalWrite = false;
          throw new Error("Storage unavailable");
        }
        values.set(key, value);
      },
    },
    new ServerMutex(directory),
  );
  const sessions: (ReturnType<typeof sessionWire> & { tags?: Record<string, string> })[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let inputStatus = 200;
  let uncertainCreate = false;
  let uncertainInput = false;
  let terminate: "exit" | "refuse" | "uncertain" | "uncertain-exit" | "gone" = "exit";
  let duringTerminate: (() => Promise<void>) | undefined;
  let removal: "delete" | "refuse" | "uncertain" | "uncertain-exit" | "partial" = "delete";
  const deletes: string[] = [];
  let now = 1000000;
  const client = new WaypointClient(connection.apiUrl, async (url, options) => {
    const path = new URL(String(url)).pathname;
    const body = options?.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : {};
    if (options?.method === "POST") requests.push({ path, body });
    if (path === "/api/me") return respond({ ...metadataWire, default_cwd: "/workspace" });
    if (path === "/api/sessions" && options?.method === "POST") {
      const session = { ...sessionWire(`created-${sessions.length + 1}`), tags: body.tags };
      sessions.push(session as (typeof sessions)[number]);
      if (uncertainCreate) throw new Error("network private detail");
      return respond({ session });
    }
    if (path === "/api/sessions") return respond({ sessions });
    const id = decodeURIComponent(path.split("/")[3]);
    const session = sessions.find((item) => item.id === id);
    if (!session) return respond({}, 404);
    if (path.endsWith("/events")) {
      const query = new URL(String(url)).searchParams;
      eventQueries.push(new URL(String(url)).search);
      const own = history.get(id) ?? [];
      const before = query.get("before_sequence");
      const older = before === null ? own : own.filter((event) => event.sequence < Number(before));
      return respond({
        events: older.slice(-3),
        has_more: older.length > 3,
        pending_questions: { questions: [], as_of_sequence: 0, revision: 0 },
      });
    }
    if (path.endsWith("/input")) {
      await inputGate;
      if (uncertainInput) throw new Error("private connection failure");
      return respond({ session }, inputStatus);
    }
    if (options?.method === "DELETE") {
      deletes.push(id);
      if (removal === "refuse") return respond({ detail: "target busy" }, 409);
      if (removal !== "uncertain") session.status = "exited";
      if (removal === "partial") return respond({ detail: "worktree has changes" }, 409);
      if (removal.startsWith("uncertain")) throw new Error("connection reset");
      sessions.splice(sessions.indexOf(session), 1);
      return respond({ deleted: id });
    }
    if (path.endsWith("/reattach")) {
      session.status = "idle";
      return respond({ session });
    }
    if (path.endsWith("/terminate")) {
      await duringTerminate?.();
      if (terminate === "refuse") return respond({ detail: "target busy" }, 409);
      if (terminate === "gone") {
        sessions.splice(sessions.indexOf(session), 1);
        return respond({}, 404);
      }
      if (terminate !== "uncertain") session.status = "exited";
      if (terminate !== "exit") throw new Error("connection reset");
      return respond({ session });
    }
    sessionReads++;
    await sessionGate;
    return respond({ session });
  });
  const controller = (forceNew = false, resume = false, workspace?: Workspace) =>
    new QuickChatController(
      connection,
      store,
      async () => undefined,
      { destination: forceNew ? { kind: "new" } : { kind: "quick", resume }, workspace },
      client,
      () => now,
    );
  return {
    directory,
    store,
    values,
    sessions,
    requests,
    client,
    controller,
    storageReads: () => storageReads,
    setReadGate: (value: Promise<void>) => {
      readGate = value;
    },
    eventQueries,
    history,
    sessionReads: () => sessionReads,
    setSessionGate: (value: Promise<void>) => {
      sessionGate = value;
    },
    setInputGate: (value: Promise<void>) => {
      inputGate = value;
    },
    failFinalWrite: () => {
      failFinalWrite = true;
    },
    setInputStatus: (value: number) => {
      inputStatus = value;
    },
    setUncertainCreate: (value: boolean) => {
      uncertainCreate = value;
    },
    setUncertainInput: (value: boolean) => {
      uncertainInput = value;
    },
    setTerminate: (value: typeof terminate) => {
      terminate = value;
    },
    deletes,
    setRemoval: (value: typeof removal) => {
      removal = value;
    },
    setDuringTerminate: (value: typeof duringTerminate) => {
      duringTerminate = value;
    },
    advance: (value: number) => {
      now += value;
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("reuse mode matrix includes exact timeout and finished waiting_input", () => {
  const defaults = initialDefaults();
  const session = parseSession({ ...sessionWire(), status: "idle" });
  assert.equal(reuseDecision(defaults, session, 0, 30 * 60000 - 1, false, false), "continue");
  assert.equal(reuseDecision(defaults, session, 0, 30 * 60000, false, false), "new");
  assert.equal(reuseDecision(defaults, session, 0, 30 * 60000, true, false), "continue");
  assert.equal(reuseDecision({ ...defaults, mode: "continue" }, session, 0, 999999999, false, false), "continue");
  assert.equal(reuseDecision({ ...defaults, mode: "new" }, session, 0, 0, true, false), "new");
  assert.equal(reuseDecision(defaults, session, 0, 0, true, true), "new");
  assert.equal(ongoing({ ...session, status: "waiting_input" }), false);
  assert.equal(ongoing({ ...session, status: "running" }), true);
  const approval = parseEvent(
    { ...eventWire(1, "approval_request", "Approve?"), metadata: { approval_id: "a" } },
    "demo",
  );
  assert.equal(ongoing(session, undefined, [approval]), true);
  assert.equal(
    ongoing(session, undefined, [
      approval,
      parseEvent(
        { ...eventWire(2, "system_note", "Approval response sent: accept"), metadata: { approval_id: "a" } },
        "demo",
      ),
    ]),
    false,
  );
});

test("reuse interaction evidence follows Waypoint approval queue and latest plan", () => {
  const session = parseSession({ ...sessionWire(), status: "waiting_input" });
  const event = (sequence: number, kind: string, text: string, metadata = {}) =>
    parseEvent({ ...eventWire(sequence, kind, text), metadata }, "demo");
  const approval = event(1, "approval_request", "Approve?", { approval_id: "a" });
  assert.equal(ongoing(session, undefined, [approval, event(2, "system_note", "Approval timed out")]), false);
  const catalog = parseMetadata({
    ...metadataWire,
    backends: metadataWire.backends.map((agent) => ({
      ...agent,
      agent_capabilities: { supports_plan_approval: true },
    })),
  });
  const planning = { ...session, permissionMode: "plan" };
  const oldPlan = event(1, "system_note", "Old plan", { item_type: "plan", plan: { id: "old", text: "Old plan" } });
  const newPlan = event(2, "system_note", "New plan", { item_type: "plan", plan: { id: "new", text: "New plan" } });
  const decided = event(3, "system_note", "Accepted", { plan_item_id: "new", plan_decision: "accept" });
  assert.equal(ongoing(planning, undefined, [oldPlan, newPlan, decided], catalog), false);
  assert.equal(ongoing(planning, undefined, [newPlan, event(3, "user_input", "More detail")], catalog), true);
  assert.equal(
    ongoing(
      planning,
      undefined,
      [
        newPlan,
        decided,
        event(4, "system_note", "Revised", { item_type: "plan", plan: { id: "new", text: "Revised" } }),
      ],
      catalog,
    ),
    true,
  );
  assert.equal(ongoing({ ...planning, permissionMode: "default" }, undefined, [newPlan], catalog), false);
  assert.equal(ongoing(planning, undefined, [newPlan], parseMetadata(metadataWire)), false);
  assert.equal(
    reuseDecision(initialDefaults(), planning, 0, 30 * 60000, ongoing(planning, undefined, [newPlan], catalog), false),
    "continue",
  );
  const finished = { ...planning, permissionMode: "default" };
  assert.equal(
    reuseDecision(initialDefaults(), finished, 0, 30 * 60000, ongoing(finished, undefined, [newPlan], catalog), false),
    "new",
  );
});

test("launch request omits inherited values and retains preset tags without secrets", () => {
  const catalog = parseMetadata({
    ...metadataWire,
    default_cwd: "/workspace",
    default_preset_id: "preset",
    session_presets: [
      {
        id: "preset",
        name: "Default",
        is_default: true,
        spec: {
          backend: "test-agent",
          model: "preset-model",
          tags: { team: "garden" },
          launch_env: { PRIVATE: "secret" },
        },
      },
    ],
  });
  const request = createRequest(initialDefaults(), catalog, "installation", "operation");
  assert.equal(request.backend, undefined);
  assert.equal(request.model, undefined);
  assert.equal(request.effort, undefined);
  assert.equal(request.args, undefined);
  assert.equal(request.launch_env, undefined);
  assert.equal(request.transport, "test-rpc");
  assert.equal(request.launch_target_id, null);
  assert.deepEqual(request.tags, {
    team: "garden",
    raycast_installation: "installation",
    raycast_create: "operation",
    raycast_role: "quick-chat",
  });
  assert.equal(createRequest({ ...initialDefaults(), model: "__default__" }, catalog, "i", "o").model, null);
  assert.throws(
    () => createRequest({ ...initialDefaults(), transport: "test-terminal" }, catalog, "i", "o"),
    /structured/,
  );
  assert.ok(!JSON.stringify(catalog).includes("secret"));
});

test("first send creates once, persists pointer before input, and follow-ups reuse session", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    assert.equal(f.requests.length, 0);
    c.changeDraft("Hello");
    await c.send();
    assert.deepEqual(
      f.requests.map((request) => request.path),
      ["/api/sessions", "/api/sessions/created-1/input"],
    );
    assert.equal((await f.store.load(connection.id)).pointer, "created-1");
    assert.equal(c.getSnapshot().draft, "");
    c.changeDraft("Follow up");
    await c.send();
    assert.equal(f.sessions.length, 1);
    assert.equal(c.getSnapshot().session?.id, "created-1");
    assert.ok(f.eventQueries.every((query) => !query.includes("cursor=")));
  } finally {
    await f.close();
  }
});

test("failed first input retains created session and draft for retry", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    f.setInputStatus(409);
    c.changeDraft("Keep me");
    await c.send();
    assert.equal(f.sessions.length, 1);
    assert.equal(c.getSnapshot().draft, "Keep me");
    assert.equal(c.getSnapshot().pending, undefined);
    f.setInputStatus(200);
    await c.send();
    assert.equal(f.sessions.length, 1);
    assert.equal(c.getSnapshot().draft, "");
  } finally {
    await f.close();
  }
});

test("uncertain creation survives reopening and recovers tagged session without resending", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    f.setUncertainCreate(true);
    c.changeDraft("Uncertain");
    await c.send();
    c.stop();
    assert.equal(c.getSnapshot().pending?.kind, "create");
    const reopened = f.controller();
    await reopened.start();
    await reopened.send();
    assert.equal(f.sessions.length, 1);
    await reopened.reconcile();
    assert.equal(reopened.getSnapshot().session?.id, "created-1");
    assert.equal(reopened.getSnapshot().pending, undefined);
    assert.equal(f.requests.filter((request) => request.path.endsWith("/input")).length, 0);
    f.setUncertainCreate(false);
    await reopened.send();
    assert.equal(f.sessions.length, 1);
  } finally {
    await f.close();
  }
});

test("uncertain input never retries on reopen; explicit outcome-aware retry is separate", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    f.setUncertainInput(true);
    c.changeDraft("Do once");
    await c.send();
    c.stop();
    const reopened = f.controller();
    await reopened.start();
    await reopened.send();
    assert.equal(f.requests.filter((request) => request.path.endsWith("/input")).length, 1);
    await reopened.reconcile();
    assert.ok(reopened.getSnapshot().notice?.includes("unconfirmed"));
    f.setUncertainInput(false);
    await reopened.allowRetry();
    assert.equal(reopened.getSnapshot().pending, undefined);
    await reopened.send();
    assert.equal(f.requests.filter((request) => request.path.endsWith("/input")).length, 2);
  } finally {
    await f.close();
  }
});

test("checking an unconfirmed message pages back only to the history before it was sent", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    c.changeDraft("Seed");
    await c.send();
    const say = (sequence: number, kind = "agent_output", text = ".") =>
      eventWire(sequence, kind, text, "", "created-1");
    const outputs = (from: number, count: number) => Array.from({ length: count }, (_, index) => say(from + index));
    const recorded = [say(1, "user_input", "Do once"), say(2)];
    f.history.set("created-1", recorded);
    f.setUncertainInput(true);
    c.changeDraft("Do once");
    await c.send();
    f.setUncertainInput(false);
    assert.equal((await f.store.load(connection.id)).pending?.baseline, 102);

    recorded.push(...outputs(3, 10));
    f.eventQueries.length = 0;
    await c.reconcile();
    assert.match(c.getSnapshot().notice!, /No matching input/, "the same message sent earlier does not count");
    assert.deepEqual(f.eventQueries, ["", "?before_sequence=10", "?before_sequence=7", "?before_sequence=4"]);

    recorded.push(say(13, "user_input", "Do once"), ...outputs(14, 10));
    await c.reconcile();
    assert.match(c.getSnapshot().notice!, /recorded matching input/);

    recorded.push(...outputs(24, 70));
    f.eventQueries.length = 0;
    await c.reconcile();
    assert.match(c.getSnapshot().notice!, /No matching input/);
    assert.equal(f.eventQueries.length, 20, "a long history is read only so far back");
  } finally {
    await f.close();
  }
});

test("an unconfirmed reattach or interrupt is checked without reading history", async () => {
  for (const kind of ["reattach", "interrupt"] as const) {
    const f = await fixture();
    try {
      const c = f.controller();
      await c.start();
      c.changeDraft("Seed");
      await c.send();
      await f.store.transaction(connection.id, async (state, persist) => {
        state.pending = { kind, operationId: "op", sessionId: "created-1", text: "", draftKey: "quick", startedAt: 1 };
        await persist();
      });
      f.eventQueries.length = 0;
      await c.reconcile();
      assert.match(c.getSnapshot().notice!, new RegExp(`The ${kind} outcome is not confirmed`));
      assert.deepEqual(f.eventQueries, [], kind);
    } finally {
      await f.close();
    }
  }
});

test("an expired timed conversation is kept while the latest page shows a pending approval", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    c.changeDraft("Seed");
    await c.send();
    c.stop();
    f.sessions[0].status = "waiting_input";
    f.history.set("created-1", [eventWire(1, "approval_request", "Run tests", "", "created-1")]);
    f.advance(30 * 60000);
    const next = f.controller();
    await next.start();
    assert.equal(next.getSnapshot().session?.id, "created-1");
    assert.ok(f.eventQueries.every((query) => !query.includes("cursor")));
  } finally {
    await f.close();
  }
});

test("concurrent implicit-new opens share the created pointer; Always New opens remain distinct", async () => {
  for (const mode of ["timed", "new"] as const) {
    const f = await fixture();
    try {
      await f.store.defaults(connection.id, { ...initialDefaults(), mode });
      const a = f.controller();
      const b = f.controller();
      await Promise.all([a.start(), b.start()]);
      a.changeDraft("A");
      b.changeDraft("B");
      await Promise.all([a.send(), b.send()]);
      assert.equal(f.sessions.length, mode === "new" ? 2 : 1);
    } finally {
      await f.close();
    }
  }
});

test("old view follow-ups do not refresh the replacement session clock", async () => {
  const f = await fixture();
  try {
    const a = f.controller();
    await a.start();
    a.changeDraft("A");
    await a.send();
    const b = f.controller(true);
    await b.start();
    b.changeDraft("B");
    await b.send();
    const time = (await f.store.load(connection.id)).sentAt["created-2"];
    f.advance(5000);
    a.changeDraft("A again");
    await a.send();
    const saved = await f.store.load(connection.id);
    assert.equal(saved.pointer, "created-2");
    assert.equal(saved.sentAt["created-2"], time);
    assert.ok(saved.sentAt["created-1"] > time);
  } finally {
    await f.close();
  }
});

test("missing or foreign pointer requires explicit New Chat and retains draft", async () => {
  const f = await fixture();
  try {
    await f.store.transaction(connection.id, async (state, persist) => {
      state.pointer = "missing";
      state.drafts.quick = "Retained";
      await persist();
    });
    const c = f.controller();
    await c.start();
    assert.match(c.getSnapshot().error!, /no longer on this server\. Choose Start New Chat/);
    await c.send();
    assert.equal(f.sessions.length, 0);
    assert.equal(c.getSnapshot().draft, "Retained");
    await c.newChat();
    await c.send();
    assert.equal(f.sessions.length, 1);
    await f.store.transaction(connection.id, async (state, persist) => {
      state.pointer = f.sessions[0].id;
      state.installation = "different-owner";
      await persist();
    });
    const foreign = f.controller();
    await foreign.start();
    await foreign.changeDraft("No takeover");
    await foreign.send();
    assert.equal(f.sessions.length, 1);
  } finally {
    await f.close();
  }
});

test("drafts are stored per server and key; corrupt Quick Chat state is never replaced", async () => {
  const f = await fixture();
  try {
    await f.store.drafts.write(draftKeys.line("a", "quick"), "A");
    await f.store.drafts.write(draftKeys.line("b", "quick"), "B");
    await f.store.drafts.write(draftKeys.line("a", "new"), "New draft");
    assert.equal(await f.store.drafts.read(draftKeys.line("a", "quick")), "A");
    assert.equal(await f.store.drafts.read(draftKeys.line("a", "new")), "New draft");
    assert.equal(await f.store.drafts.read(draftKeys.line("b", "quick")), "B");
    assert.throws(() => decodeQuickChat('{"version":2}'), /could not be read/);
    f.values.set("waypoint.quick-chat.corrupt", '{"version":2}');
    await assert.rejects(f.store.defaults("corrupt", decodeQuickChat().defaults), /could not be read/);
    assert.equal(f.values.get("waypoint.quick-chat.corrupt"), '{"version":2}');
  } finally {
    await f.close();
  }
});

test("cross-process mutex prevents a draft/default writer from erasing a pending checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quick-lock-process-"));
  try {
    const statePath = join(directory, "state.json");
    await writeFile(statePath, "{}");
    const modulePath = require.resolve("../src/storage/mutex");
    const script = `const {ServerMutex}=require(process.argv[1]); const fs=require('node:fs/promises'); const m=new ServerMutex(process.argv[2],5000); m.run('server',async()=>{const data=JSON.parse(await fs.readFile(process.argv[3],'utf8')); if(process.argv[4]==='checkpoint'){data.pending={kind:'input'}; await new Promise(r=>setTimeout(r,120));} else data.draft='new draft'; await fs.writeFile(process.argv[3],JSON.stringify(data));}).catch(e=>{process.stderr.write(e.message);process.exitCode=1});`;
    const child = (role: string) =>
      new Promise<void>((resolve, reject) => {
        const processChild = spawn(process.execPath, [
          "-e",
          script,
          modulePath,
          join(directory, "locks"),
          statePath,
          role,
        ]);
        let error = "";
        processChild.stderr.on("data", (chunk) => {
          error += chunk;
        });
        processChild.on("error", reject);
        processChild.on("close", (code) => (code === 0 ? resolve() : reject(new Error(error))));
      });
    await Promise.all([child("checkpoint"), child("draft")]);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.pending.kind, "input");
    assert.equal(saved.draft, "new draft");
    const mutex = new ServerMutex(join(directory, "locks"));
    await assert.rejects(
      mutex.run("server", async () => {
        throw new Error("failure");
      }),
      /failure/,
    );
    await mutex.run("server", async () => undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed first send is reused on reopen even when idle and no send clock exists", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    f.setInputStatus(409);
    c.changeDraft("First draft");
    await c.send();
    c.stop();
    f.sessions[0].status = "idle";
    f.advance(99999999);
    const reopened = f.controller();
    await reopened.start();
    assert.equal(reopened.getSnapshot().session?.id, "created-1");
    f.setInputStatus(200);
    await reopened.send();
    assert.equal(f.sessions.length, 1);
  } finally {
    await f.close();
  }
});

test("timed finished waiting_input expires while running work preserves the pointer", async () => {
  for (const status of ["waiting_input", "running"]) {
    const f = await fixture();
    try {
      const c = f.controller();
      await c.start();
      c.changeDraft("Seed");
      await c.send();
      c.stop();
      f.sessions[0].status = status;
      f.advance(30 * 60000);
      const next = f.controller();
      await next.start();
      assert.equal(!!next.getSnapshot().session, status === "running");
    } finally {
      await f.close();
    }
  }
});

test("reuse is fixed at open; an expired pointer does not become a send destination", async () => {
  const f = await fixture();
  try {
    const first = f.controller();
    await first.start();
    first.changeDraft("First");
    await first.send();
    f.sessions[0].status = "idle";
    f.advance(30 * 60000);
    const next = f.controller();
    await next.start();
    assert.equal(next.getSnapshot().session, undefined);
    f.sessions[0].status = "running";
    next.changeDraft("New conversation");
    await next.send();
    assert.equal(f.sessions.length, 2);
  } finally {
    await f.close();
  }
});

test("manual New Chat and Always New follow-ups remain bound within the view", async () => {
  const f = await fixture();
  try {
    await f.store.defaults(connection.id, { ...initialDefaults(), mode: "new" });
    const c = f.controller();
    await c.start();
    c.changeDraft("First");
    await c.send();
    c.changeDraft("Second");
    await c.send();
    assert.equal(f.sessions.length, 1);
    await c.newChat();
    c.changeDraft("New");
    await c.send();
    assert.equal(f.sessions.length, 2);
  } finally {
    await f.close();
  }
});

test("dead-owner mutex recovery and live-owner contention preserve exclusive access", async () => {
  const { createHash } = await import("node:crypto");
  const directory = await mkdtemp(join(tmpdir(), "quick-dead-lock-"));
  try {
    const child = spawn(process.execPath, ["-e", ""]);
    const pid = child.pid;
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    assert.ok(pid);
    const path = join(directory, createHash("sha256").update("server").digest("hex"));
    await writeFile(path, JSON.stringify({ pid, nonce: "dead" }));
    const mutex = new ServerMutex(directory, 40);
    await mutex.run("server", async () => undefined);
    await writeFile(path, JSON.stringify({ pid: process.pid, nonce: "alive" }));
    await assert.rejects(
      mutex.run("server", async () => undefined),
      /Another Quick Chat/,
    );
    assert.equal(JSON.parse(await readFile(path, "utf8")).nonce, "alive");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mutation errors distinguish known rejections from uncertain server/network outcomes", async () => {
  for (const status of [400, 401, 404, 409, 500]) {
    const client = new WaypointClient("http://localhost", async () =>
      respond({ detail: "private-server-detail" }, status),
    );
    await assert.rejects(
      client.input("token", "session", "text"),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes("private-server-detail") &&
        "kind" in error &&
        error.kind ===
          (status === 401 ? "expired-token" : status === 404 ? "not-found" : status === 500 ? "uncertain" : "rejected"),
    );
  }
});

test("deleted uncertain destination can be explicitly abandoned without losing the draft", async () => {
  const f = await fixture();
  try {
    const first = f.controller();
    await first.start();
    f.setUncertainInput(true);
    first.changeDraft("Keep this work");
    await first.send();
    f.sessions.splice(0);
    const reopened = f.controller();
    await reopened.start();
    await reopened.reconcile();
    assert.ok(reopened.getSnapshot().pending);
    await reopened.abandonPending();
    assert.equal(reopened.getSnapshot().pending, undefined);
    assert.equal(reopened.getSnapshot().draft, "Keep this work");
    assert.equal(f.requests.filter((request) => request.path === "/api/sessions").length, 1);
    f.setUncertainInput(false);
    await reopened.send();
    assert.equal(f.requests.filter((request) => request.path === "/api/sessions").length, 2);
  } finally {
    await f.close();
  }
});

test("a killed reclaimer leaves an owned claim that another process can recover", async () => {
  const { createHash } = await import("node:crypto");
  const directory = await mkdtemp(join(tmpdir(), "quick-reclaim-crash-"));
  try {
    const old = spawn(process.execPath, ["-e", ""]);
    const deadPid = old.pid;
    await new Promise<void>((resolve) => old.on("close", () => resolve()));
    const path = join(directory, createHash("sha256").update("server").digest("hex"));
    await writeFile(path, JSON.stringify({ pid: deadPid, nonce: "stale-main" }));
    const script = `const fs=require('node:fs'); const owner=process.argv[1]+'.candidate'; fs.writeFileSync(owner,JSON.stringify({pid:process.pid,nonce:'killed-reclaimer'})); fs.linkSync(owner,process.argv[1]+'.reclaim.stale-main'); process.stdout.write('ready'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", script, path]);
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    const stopped = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await stopped;
    let entered = false;
    await new ServerMutex(directory, 100).run("server", async () => {
      entered = true;
    });
    assert.equal(entered, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a late acknowledged input persists after the view closes", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.setInputGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const c = f.controller();
    await c.start();
    c.changeDraft("Close while sending");
    const sending = c.send();
    while (!f.requests.some((request) => request.path.endsWith("/input")))
      await new Promise<void>((resolve) => setImmediate(resolve));
    c.stop();
    release();
    await sending;
    const reopened = f.controller();
    await reopened.start();
    assert.equal(reopened.getSnapshot().draft, "");
    assert.equal(reopened.getSnapshot().pending, undefined);
    assert.equal(f.requests.filter((request) => request.path.endsWith("/input")).length, 1);
    assert.equal((await f.store.load(connection.id)).pointer, "created-1");
  } finally {
    await f.close();
  }
});

test("a failed final storage write keeps the checkpoint and never offers the acknowledged text again", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    c.changeDraft("Accepted before storage failed");
    f.failFinalWrite();
    await c.send();
    assert.ok(c.getSnapshot().pending);
    const reopened = f.controller();
    await reopened.start();
    await reopened.send();
    assert.equal(f.requests.filter((request) => request.path.endsWith("/input")).length, 1);
    assert.equal(reopened.getSnapshot().draft, "");
  } finally {
    await f.close();
  }
});

test("reconciling another view's creation preserves an already-bound destination", async () => {
  const f = await fixture();
  try {
    const first = f.controller();
    await first.start();
    first.changeDraft("First");
    await first.send();
    const next = f.controller(true);
    await next.start();
    f.setUncertainCreate(true);
    next.changeDraft("Second");
    await next.send();
    await first.reconcile();
    assert.equal(first.getSnapshot().session?.id, "created-1");
    assert.equal((await f.store.load(connection.id)).pointer, "created-2");
    assert.equal(f.requests.filter((request) => request.path.endsWith("/input")).length, 1);
  } finally {
    await f.close();
  }
});

test("manual New Chat invalidates a delayed refresh of its predecessor", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    c.changeDraft("First");
    await c.send();
    let release!: () => void;
    f.setSessionGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const before = f.sessionReads();
    const refreshing = c.start();
    while (f.sessionReads() === before) await new Promise<void>((resolve) => setImmediate(resolve));
    await c.newChat();
    release();
    await refreshing;
    assert.equal(c.getSnapshot().session, undefined);
    assert.equal(c.getSnapshot().loading, false);
    c.changeDraft("New intent");
    await c.send();
    assert.equal(f.sessions.length, 2);
  } finally {
    await f.close();
  }
});

test("refresh waits for queued draft writes instead of restoring old text", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    await c.changeDraft("Old text");
    const saving = c.changeDraft("New text");
    await c.start();
    await saving;
    assert.equal(c.getSnapshot().draft, "New text");
    assert.equal(await f.store.drafts.read(draftKeys.line(connection.id, "quick")), "New text");
  } finally {
    await f.close();
  }
});

test("an edit during a delayed refresh remains the visible and saved draft", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    await c.changeDraft("Before refresh");
    let release!: () => void;
    f.setReadGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const before = f.storageReads();
    const refreshing = c.start();
    while (f.storageReads() === before) await new Promise<void>((resolve) => setImmediate(resolve));
    const saving = c.changeDraft("Edited during refresh");
    release();
    await refreshing;
    await saving;
    assert.equal(c.getSnapshot().draft, "Edited during refresh");
    assert.equal(await f.store.drafts.read(draftKeys.line(connection.id, "quick")), "Edited during refresh");
  } finally {
    await f.close();
  }
});

test("abandoning an attempt invalidates a delayed refresh of its destination", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    f.setUncertainInput(true);
    c.changeDraft("Unconfirmed");
    await c.send();
    let release!: () => void;
    f.setSessionGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const before = f.sessionReads();
    const refreshing = c.start();
    while (f.sessionReads() === before) await new Promise<void>((resolve) => setImmediate(resolve));
    await c.abandonPending();
    release();
    await refreshing;
    assert.equal(c.getSnapshot().session, undefined);
    assert.equal(c.getSnapshot().pending, undefined);
    assert.equal(c.getSnapshot().loading, false);
    f.setUncertainInput(false);
    await c.send();
    assert.equal(f.sessions.length, 2);
  } finally {
    await f.close();
  }
});

const choose = (f: Awaited<ReturnType<typeof fixture>>, id: string, at: number) =>
  f.store.transaction(connection.id, async (state, persist) => {
    setPointer(state, id, at);
    await persist();
  });

test("a chosen destination decodes, times out from the choice, and leaves with its pointer", () => {
  const state = decodeQuickChat(undefined);
  assert.equal(decodeQuickChat(JSON.stringify(state)).chosen, undefined);
  setPointer(state, "found", 5000);
  assert.deepEqual(decodeQuickChat(JSON.stringify(state)).chosen, { sessionId: "found", at: 5000 });
  assert.throws(() => decodeQuickChat(JSON.stringify({ ...state, chosen: { sessionId: "found" } })));
  assert.equal(lastActivity(state, "found"), 5000);
  state.sentAt.found = 4000;
  assert.equal(lastActivity(state, "found"), 5000);
  state.sentAt.found = 6000;
  assert.equal(lastActivity(state, "found"), 6000);
  setPointer(state, "found");
  assert.equal(state.chosen?.sessionId, "found");
  setPointer(state, "created");
  assert.equal(state.chosen, undefined);
  assert.equal(lastActivity(state, "found"), 6000);
  setPointer(state, "found", 7000);
  setPointer(state, undefined);
  assert.equal(state.chosen, undefined);
  assert.equal(resumeFor("a", "a", true), true);
  assert.equal(resumeFor("b", "a", true), false);
  assert.equal(resumeFor("a", undefined, true), false);
  assert.equal(resumeFor("a", "a", false), false);
});

test("a chosen session from elsewhere is continued and receives sends", async () => {
  const f = await fixture();
  try {
    f.sessions.push({ ...sessionWire("found"), status: "idle", tags: {} });
    const unchosen = f.controller();
    await f.store.transaction(connection.id, async (state, persist) => {
      state.pointer = "found";
      await persist();
    });
    await unchosen.start();
    assert.match(unchosen.getSnapshot().error!, /not owned by this Quick Chat installation/);
    await choose(f, "found", 1000000);
    const c = f.controller();
    await c.start();
    assert.equal(c.getSnapshot().session?.id, "found");
    await c.changeDraft("Follow up");
    await c.send();
    assert.equal(f.sessions.length, 1);
    assert.ok(f.requests.some((request) => request.path === "/api/sessions/found/input"));
    f.advance(29 * 60000);
    const reopened = f.controller();
    await reopened.start();
    assert.equal(reopened.getSnapshot().session?.id, "found");
  } finally {
    await f.close();
  }
});

test("timed reuse of a chosen session counts from the choice, and resume overrides the mode", async () => {
  const f = await fixture();
  try {
    f.sessions.push({ ...sessionWire("found"), status: "idle", tags: {} });
    await choose(f, "found", 1000000);
    f.advance(29 * 60000);
    const within = f.controller();
    await within.start();
    assert.equal(within.getSnapshot().session?.id, "found");
    f.advance(2 * 60000);
    const expired = f.controller();
    await expired.start();
    assert.equal(expired.getSnapshot().session, undefined);
    const resumed = f.controller(false, true);
    await resumed.start();
    assert.equal(resumed.getSnapshot().session?.id, "found");
    await f.store.transaction(connection.id, async (state, persist) => {
      state.defaults = { ...state.defaults, mode: "new" };
      await persist();
    });
    const always = f.controller();
    await always.start();
    assert.equal(always.getSnapshot().session, undefined);
    const resumedNew = f.controller(false, true);
    await resumedNew.start();
    assert.equal(resumedNew.getSnapshot().session?.id, "found");
    const fresh = f.controller(true, true);
    await fresh.start();
    assert.equal(fresh.getSnapshot().session, undefined);
  } finally {
    await f.close();
  }
});

test("creating a new conversation drops the earlier choice", async () => {
  const f = await fixture();
  try {
    f.sessions.push({ ...sessionWire("found"), status: "idle", tags: {} });
    await choose(f, "found", 1000000);
    const c = f.controller();
    await c.start();
    await c.newChat();
    await c.changeDraft("Fresh");
    await c.send();
    const saved = await f.store.load(connection.id);
    assert.equal(saved.pointer, "created-2");
    assert.equal(saved.chosen, undefined);
    await f.store.transaction(connection.id, async (state, persist) => {
      state.pointer = "found";
      await persist();
    });
    const back = f.controller();
    await back.start();
    assert.match(back.getSnapshot().error!, /not owned/);
  } finally {
    await f.close();
  }
});

test("Start New Chat clears a destination that is gone, but never a live one", async () => {
  const f = await fixture();
  try {
    await f.store.transaction(connection.id, async (state, persist) => {
      setPointer(state, "missing", 1000000);
      await persist();
    });
    const c = f.controller();
    await c.start();
    assert.match(c.getSnapshot().error!, /no longer on this server/);
    await c.newChat();
    let saved = await f.store.load(connection.id);
    assert.equal(saved.pointer, undefined);
    assert.equal(saved.chosen, undefined);
    const reopened = f.controller();
    await reopened.start();
    assert.equal(reopened.getSnapshot().error, undefined);
    await reopened.changeDraft("Hello");
    await reopened.send();
    const live = f.controller();
    await live.start();
    assert.equal(live.getSnapshot().session?.id, "created-1");
    await live.newChat();
    saved = await f.store.load(connection.id);
    assert.equal(saved.pointer, "created-1");
  } finally {
    await f.close();
  }
});

test("a failed start saved by Edit Current Session in an earlier version points to New Session with Settings", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    f.setUncertainCreate(true);
    await c.changeDraft("Hello there");
    await c.send();
    await f.store.transaction(connection.id, async (saved, persist) => {
      saved.pending = { ...saved.pending!, origin: "edit" };
      await persist();
    });
    Object.assign(f.sessions[0], {
      tags: {},
      title: (await f.store.read(connection.id)).pending!.launch!.title,
      status: "error",
      created_at: "2026-10-26T00:00:00Z",
    });
    await c.reconcile();
    assert.equal(c.getSnapshot().pending, undefined);
    assert.match(c.getSnapshot().error!, /start it again with New Session with Settings\.$/);
  } finally {
    await f.close();
  }
});

test("a create whose session failed to start is recognized, cleared, and keeps the draft", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    f.setUncertainCreate(true);
    await c.changeDraft("Hello there");
    await c.send();
    const pending = (await f.store.read(connection.id)).pending!;
    const title = pending.launch!.title!;
    assert.match(title, /^Quick Chat \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.deepEqual(pending.launch, { backend: "test-agent", target: "", cwd: "/workspace", title });
    const failed = f.sessions[0];
    const untagged = () =>
      Object.assign(failed, {
        tags: {},
        title,
        status: "running",
        created_at: "2026-10-26T00:00:00Z",
      });
    untagged();
    await c.reconcile();
    assert.equal(c.getSnapshot().pending?.kind, "create");
    assert.match(c.getSnapshot().notice!, /No matching session is visible yet/);
    Object.assign(failed, { status: "error", created_at: "1969-12-31T00:00:00Z" });
    await c.reconcile();
    assert.equal(c.getSnapshot().pending?.kind, "create");
    Object.assign(failed, { created_at: "2026-10-26T00:00:00Z" });
    await c.reconcile();
    assert.equal(c.getSnapshot().pending, undefined);
    assert.match(c.getSnapshot().error!, /failed to start/);
    const settled = await f.store.read(connection.id);
    assert.equal(settled.pending, undefined);
    assert.equal(settled.failedStartAt, Date.parse("2026-10-26T00:00:00Z"));
    assert.equal(c.getSnapshot().draft, "Hello there");
    // A retry whose create is unconfirmed is not settled by the failure already recognized.
    await c.send();
    assert.equal(c.getSnapshot().pending?.kind, "create");
    // The retry's session isn't stored yet, as while Waypoint is still connecting to the target.
    f.sessions.pop();
    await c.reconcile();
    assert.equal(c.getSnapshot().pending?.kind, "create");
    assert.match(c.getSnapshot().notice!, /No matching session is visible yet/);
    assert.equal(f.requests.filter((request) => request.path.endsWith("/input")).length, 0);
  } finally {
    await f.close();
  }
});

test("a failed start is matched by target and, on remote targets, by working directory", async () => {
  const pending = {
    kind: "create" as const,
    operationId: "op",
    text: "",
    draftKey: "quick",
    startedAt: Date.parse("2026-10-26T00:00:00Z"),
    launch: { backend: "test-agent", target: "lab", cwd: "/home/lab/missing" },
  };
  const record = (patch: Record<string, unknown>) =>
    parseSession({
      ...sessionWire("f"),
      title: "Quick Chat",
      status: "error",
      launch_target_id: "lab",
      cwd: "/home/lab/missing",
      created_at: "2026-10-25T23:57:00Z",
      ...patch,
    });
  assert.equal(failedStart(pending, record({})), true);
  assert.equal(failedStart(pending, record({ cwd: "/home/lab" })), false);
  assert.equal(failedStart(pending, record({ launch_target_id: null })), false);
  assert.equal(failedStart(pending, record({ tags: { raycast_create: "op" } })), false);
  assert.equal(failedStart(pending, record({ created_at: "2026-10-25T23:50:00Z" })), false);
  assert.equal(failedStart(pending, record({ created_at: undefined })), false);
  assert.equal(failedStart({ ...pending, launch: undefined }, record({})), false);
  const local = { ...pending, launch: { ...pending.launch, target: "" } };
  assert.equal(failedStart(local, record({ launch_target_id: null, cwd: "/Users/me/project" })), true);
  // Attempts carry their own title; ones saved before titles had a time match the plain title.
  const titled = { ...pending, launch: { ...pending.launch, title: "Quick Chat 2026-10-26 08:00" } };
  assert.equal(failedStart(titled, record({ title: "Quick Chat 2026-10-26 08:00" })), true);
  assert.equal(failedStart(titled, record({})), false);
  assert.equal(failedStart(pending, record({ title: "Quick Chat 2026-10-26 08:00" })), false);
});

test("an earlier failed attempt is not taken as the outcome of a retry", async () => {
  const pending = {
    kind: "create" as const,
    operationId: "op",
    text: "",
    draftKey: "quick",
    startedAt: Date.parse("2026-10-26T00:00:00Z"),
    launch: { backend: "test-agent", target: "lab", cwd: "/home/lab/project" },
  };
  const record = (id: string, status: string, created = "2026-10-26T00:00:01Z") =>
    parseSession({
      ...sessionWire(id),
      title: "Quick Chat",
      status,
      launch_target_id: "lab",
      cwd: "/home/lab/project",
      created_at: created,
    });
  const earlier = Date.parse("2026-10-26T00:00:01Z");
  assert.equal(failedStartAt(pending, [record("earlier", "error")]), earlier);
  assert.equal(failedStartAt(pending, [record("earlier", "error"), record("current", "starting")]), undefined);
  assert.equal(failedStartAt(pending, [record("current", "starting")]), undefined);
  // The earlier failure was already recognized and the retry's session doesn't exist yet.
  assert.equal(failedStartAt(pending, [record("earlier", "error")], earlier), undefined);
  const later = record("retry", "error", "2026-10-26T00:00:09Z");
  assert.equal(
    failedStartAt(pending, [record("earlier", "error"), later], earlier),
    Date.parse("2026-10-26T00:00:09Z"),
  );
});

test("terminating releases Quick Chat's session, and the next send starts a new one", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    await c.changeDraft("First");
    await c.send();
    const first = c.getSnapshot().session!.id;
    await f.store.transaction(connection.id, async (state, persist) => {
      state.compose = { quick: { context: [], files: [], sessionId: first, launch: "fingerprint" } };
      await persist();
    });
    await c.changeDraft("Keep this");
    assert.deepEqual(await c.terminate(), { ended: true, outcome: "done" });
    assert.equal(f.sessions[0].status, "exited");
    assert.equal(c.getSnapshot().session, undefined);
    assert.equal(c.getSnapshot().draft, "Keep this");
    const saved = await f.store.read(connection.id);
    assert.equal(saved.pointer, undefined);
    assert.equal(saved.compose?.quick.sessionId, undefined);
    await c.send();
    assert.equal(c.getSnapshot().session?.id, "created-2");
    const reopened = f.controller();
    await reopened.start();
    assert.equal(reopened.getSnapshot().session?.id, "created-2");
  } finally {
    await f.close();
  }
});

test("a refused terminate restores the destination, and an unconfirmed one keeps it released", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    await c.changeDraft("First");
    await c.send();
    const id = c.getSnapshot().session!.id;
    await f.store.transaction(connection.id, async (state, persist) => {
      setPointer(state, id, 5000);
      await persist();
    });
    f.setTerminate("refuse");
    const refused = await c.terminate();
    assert.equal(refused?.ended, false);
    assert.match(refused?.message ?? "", /target busy/);
    assert.equal(c.getSnapshot().session?.id, id);
    const restored = await f.store.read(connection.id);
    assert.equal(restored.pointer, id);
    assert.deepEqual(restored.chosen, { sessionId: id, at: 5000 });
    f.setTerminate("uncertain-exit");
    assert.deepEqual(await c.terminate(), { ended: true, outcome: "done" });
    await c.changeDraft("Second");
    await c.send();
    f.setTerminate("uncertain");
    const unconfirmed = await c.terminate();
    assert.equal(unconfirmed?.ended, true);
    assert.match(unconfirmed?.message ?? "", /didn't confirm/);
    assert.equal((await f.store.read(connection.id)).pointer, undefined);
    assert.equal(c.getSnapshot().session, undefined);
    // The view moved on too, so a send can't reattach the session the user asked to end.
    await c.changeDraft("Third");
    await c.send();
    assert.equal(c.getSnapshot().session?.id, "created-3");
    assert.equal(f.sessions[1].status, "running");
    f.setTerminate("gone");
    assert.deepEqual(await c.terminate(), {
      ended: true,
      outcome: "unconfirmed",
      message: "This session is no longer on this server.",
    });
    assert.equal((await f.store.read(connection.id)).pointer, undefined);
    // Deleted before Terminate was chosen: Quick Chat moves on rather than reporting a failure.
    await c.changeDraft("Fourth");
    await c.send();
    const deleted = c.getSnapshot().session!.id;
    f.sessions.splice(
      f.sessions.findIndex((session) => session.id === deleted),
      1,
    );
    assert.deepEqual(await c.terminate(), {
      ended: true,
      outcome: "unconfirmed",
      message: "This session is no longer on this server.",
    });
    assert.equal(c.getSnapshot().session, undefined);
    assert.equal((await f.store.read(connection.id)).pointer, undefined);
  } finally {
    await f.close();
  }
});

test("terminating and deleting removes Quick Chat's session and keeps the draft", async () => {
  const f = await fixture();
  try {
    const first = f.controller();
    await first.start();
    await first.changeDraft("First");
    await first.send();
    const id = first.getSnapshot().session!.id;
    first.stop();
    const upload = { sessionId: id, attachmentId: "a1", uploadedAt: 1 };
    const file = { id: "f1", path: "/tmp/notes.txt", name: "notes.txt", size: 1, modifiedMs: 1, upload };
    await f.store.transaction(connection.id, async (state, persist) => {
      state.compose = { quick: { context: [], files: [file], sessionId: id, launch: "fingerprint" } };
      await persist();
    });
    const c = f.controller();
    await c.start();
    assert.equal(c.getSnapshot().session?.id, id);
    await c.changeDraft("Keep this");
    assert.deepEqual(await c.terminateAndDelete(), { ended: true, outcome: "done" });
    assert.deepEqual(f.deletes, [id]);
    assert.ok(
      !f.requests.some((request) => request.path.endsWith("/terminate")),
      "Waypoint terminates it while deleting",
    );
    assert.equal(f.sessions.length, 0);
    assert.equal(c.getSnapshot().session, undefined);
    assert.equal(c.getSnapshot().draft, "Keep this");
    const kept = c.getSnapshot().compose;
    assert.equal(kept.sessionId, undefined);
    assert.equal(kept.files[0].name, "notes.txt");
    assert.equal(kept.files[0].upload, undefined, "the deleted session's attachments are gone");
    const saved = await f.store.read(connection.id);
    assert.equal(saved.pointer, undefined);
    assert.equal(saved.compose?.quick.sessionId, undefined);
    assert.equal(saved.compose?.quick.files[0].upload, undefined);
    // Staging more context saves the in-memory parts, which no longer bind the deleted session.
    await c.stageContext("clipboard", "More");
    assert.equal((await f.store.read(connection.id)).compose?.quick.sessionId, undefined);
  } finally {
    await f.close();
  }
});

test("deleting reports refusals, unconfirmed results, and sessions that ended without being deleted", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    const next = async (text: string) => {
      await c.changeDraft(text);
      await c.send();
      return c.getSnapshot().session!.id;
    };
    const first = await next("First");
    f.setRemoval("refuse");
    const refused = await c.terminateAndDelete();
    assert.equal(refused?.ended, false);
    assert.match(refused?.message ?? "", /busy/);
    assert.equal(c.getSnapshot().session?.id, first);
    assert.equal((await f.store.read(connection.id)).pointer, first);

    f.setRemoval("uncertain");
    const uncertain = await c.terminateAndDelete();
    assert.equal(uncertain?.ended && uncertain.outcome, "unconfirmed");
    assert.equal((await f.store.read(connection.id)).pointer, undefined, "Waypoint may still be deleting it");
    const second = await next("Second");
    f.setRemoval("uncertain-exit");
    const exited = await c.terminateAndDelete();
    assert.equal(exited?.ended && exited.outcome, "unconfirmed", "an exited session may still be deleting");
    assert.notEqual(second, first);

    await next("Third");
    f.setRemoval("partial");
    const partial = await c.terminateAndDelete();
    assert.equal(partial?.ended && partial.outcome, "partial");
    assert.equal(c.getSnapshot().session, undefined);

    const gone = await next("Fourth");
    f.sessions.splice(
      f.sessions.findIndex((session) => session.id === gone),
      1,
    );
    assert.deepEqual(await c.terminateAndDelete(), {
      ended: true,
      outcome: "unconfirmed",
      message: "This session is no longer on this server.",
    });

    f.setRemoval("delete");
    await next("Fifth");
    f.sessions.at(-1)!.status = "exited";
    assert.deepEqual(await c.terminateAndDelete(), { ended: true, outcome: "done" }, "an exited session is deleted");
  } finally {
    await f.close();
  }
});

test("a refused delete of an exited session keeps it as Quick Chat's session", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    await c.changeDraft("First");
    await c.send();
    const id = c.getSnapshot().session!.id;
    f.sessions[0].status = "exited";
    f.setRemoval("refuse");
    const refused = await c.terminateAndDelete();
    assert.equal(refused?.ended, false, "nothing was terminated, so it isn't reported as terminated");
    assert.match(refused?.message ?? "", /busy/);
    assert.equal(c.getSnapshot().session?.id, id);
    assert.equal((await f.store.read(connection.id)).pointer, id);
  } finally {
    await f.close();
  }
});

test("after terminating, staging more context doesn't bind the draft to the ended session again", async () => {
  const f = await fixture();
  try {
    const first = f.controller();
    await first.start();
    await first.changeDraft("First");
    await first.send();
    const id = first.getSnapshot().session!.id;
    first.stop();
    await f.store.transaction(connection.id, async (state, persist) => {
      state.compose = { quick: { context: [], files: [], sessionId: id, launch: "fingerprint" } };
      await persist();
    });
    const c = f.controller();
    await c.start();
    assert.equal(c.getSnapshot().compose.sessionId, id);
    assert.deepEqual(await c.terminate(), { ended: true, outcome: "done" });
    assert.equal(c.getSnapshot().compose.sessionId, undefined);
    await c.stageContext("clipboard", "More");
    assert.equal((await f.store.read(connection.id)).compose?.quick.sessionId, undefined);
  } finally {
    await f.close();
  }
});

test("terminate waits for an unconfirmed operation to be checked", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    await c.changeDraft("First");
    await c.send();
    const id = c.getSnapshot().session!.id;
    await f.store.transaction(connection.id, async (state, persist) => {
      state.pending = { kind: "input", operationId: "op", sessionId: id, text: "x", draftKey: "quick", startedAt: 1 };
      await persist();
    });
    const result = await c.terminate();
    assert.equal(result?.ended, false);
    assert.match(result?.message ?? "", /earlier operation/);
    // The view shows the operation to check, so it doesn't keep offering Terminate.
    assert.equal(c.getSnapshot().pending?.operationId, "op");
    assert.equal(f.sessions[0].status, "running");
    assert.equal((await f.store.read(connection.id)).pointer, id);
  } finally {
    await f.close();
  }
});

test("a new session starts in the workspace, which is prepared first", async () => {
  const f = await fixture();
  try {
    let ensured = 0;
    const c = f.controller(false, false, {
      dir: "/home/me/.waypoint-ai/workspace",
      ensure: async () => void ensured++,
    });
    await c.start();
    await c.changeDraft("Hello");
    await c.send();
    const create = f.requests.find((request) => request.path === "/api/sessions")!;
    assert.equal(create.body.cwd, "/home/me/.waypoint-ai/workspace");
    assert.match(String(create.body.title), /^Quick Chat \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(ensured, 1);
    const broken = f.controller(true, false, {
      dir: "/home/me/.waypoint-ai/workspace",
      ensure: async () => {
        throw new Error("permission denied");
      },
    });
    await broken.start();
    await broken.changeDraft("Kept");
    await broken.send();
    assert.match(broken.getSnapshot().error ?? "", /Could not create the Quick Chat workspace.*permission denied/);
    assert.equal(broken.getSnapshot().draft, "Kept");
    assert.equal((await f.store.read(connection.id)).pending, undefined);
    assert.equal(f.requests.filter((request) => request.path === "/api/sessions").length, 1);
  } finally {
    await f.close();
  }
});

test("a refused terminate restores draft bindings but keeps a destination chosen meanwhile", async () => {
  const f = await fixture();
  try {
    const c = f.controller();
    await c.start();
    await c.changeDraft("First");
    await c.send();
    const id = c.getSnapshot().session!.id;
    await f.store.transaction(connection.id, async (state, persist) => {
      state.compose = { new: { context: [], files: [], sessionId: id, launch: "fingerprint" } };
      await persist();
    });
    f.setTerminate("refuse");
    f.setDuringTerminate(async () => {
      const saved = await f.store.read(connection.id);
      assert.equal(saved.pointer, undefined);
      assert.equal(saved.compose?.new.sessionId, undefined);
      await f.store.transaction(connection.id, async (state, persist) => {
        setPointer(state, "other", 9000);
        await persist();
      });
    });
    assert.equal((await c.terminate())?.ended, false);
    const saved = await f.store.read(connection.id);
    assert.equal(saved.pointer, "other");
    assert.deepEqual(saved.chosen, { sessionId: "other", at: 9000 });
    assert.equal(saved.compose?.new.sessionId, id);
    assert.equal(saved.compose?.new.launch, "fingerprint");
  } finally {
    await f.close();
  }
});
