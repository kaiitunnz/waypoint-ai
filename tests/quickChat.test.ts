import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseMetadata } from "../src/api/contracts";
import { WaypointClient } from "../src/api/client";
import { parseSession, parseEvent } from "../src/api/sessions";
import { createRequest, initialDefaults, ongoing, resumeFor, reuseDecision } from "../src/domain/quickChat";
import { draftKeys } from "../src/storage/drafts";
import { QuickChatStore, decodeQuickChat, lastActivity, setPointer } from "../src/storage/quickChat";
import { ServerMutex } from "../src/storage/mutex";
import { QuickChatController } from "../src/hooks/quickChatController";
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
  const store = new QuickChatStore(
    {
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
      eventQueries.push(new URL(String(url)).search);
      return respond({
        events: [],
        has_more: false,
        pending_questions: { questions: [], as_of_sequence: 0, revision: 0 },
      });
    }
    if (path.endsWith("/input")) {
      await inputGate;
      if (uncertainInput) throw new Error("private connection failure");
      return respond({ session }, inputStatus);
    }
    if (path.endsWith("/reattach")) {
      session.status = "idle";
      return respond({ session });
    }
    sessionReads++;
    await sessionGate;
    return respond({ session });
  });
  const controller = (forceNew = false, resume = false) =>
    new QuickChatController(
      connection,
      store,
      async () => undefined,
      { forceNew, resume },
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
