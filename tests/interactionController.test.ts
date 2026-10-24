import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WaypointClient } from "../src/api/client";
import { parseEvent, parseQuestions, parseSession } from "../src/api/sessions";
import { ownerTag, roleTag } from "../src/domain/quickChat";
import { InteractionController } from "../src/hooks/interactionController";
import { QuickChatController } from "../src/hooks/quickChatController";
import { ConversationSnapshot } from "../src/hooks/sessionFeeds";
import { ServerMutex } from "../src/storage/mutex";
import { QuickChatStore } from "../src/storage/quickChat";
import { eventWire, metadataWire, sessionWire } from "./fixtures/conversation";

const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const connection = { id: "server-a", apiUrl: "http://localhost", name: "A", token: "fixture-token" };
const metadata = {
  ...metadataWire,
  default_cwd: "/workspace",
  backends: metadataWire.backends.map((agent) =>
    agent.id === "test-agent"
      ? {
          ...agent,
          agent_capabilities: {
            approval_decisions: ["approve", "decline"],
            supports_approval_note: true,
            supports_plan_approval: true,
          },
        }
      : agent,
  ),
};
type Wire = Record<string, unknown> & { id: number; sequence: number; metadata: Record<string, unknown> };
const wire = (
  sequence: number,
  kind: string,
  text: string,
  meta: Record<string, unknown> = {},
  session = "agent",
): Wire => ({
  ...eventWire(sequence, kind, text, "", session),
  metadata: meta,
});
const question = (id: string, questions: unknown = [{ question: "Color?", options: [{ label: "Red" }] }]) => ({
  tool_use_id: id,
  availability: "actionable",
  event: wire(90, "tool_call", "AskUserQuestion", { tool_name: "AskUserQuestion", payload: { input: { questions } } }),
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "interaction-tests-"));
  const values = new Map<string, string>();
  let failAcknowledgedWrite = false;
  let readGate: Promise<void> | undefined;
  let reads = 0;
  const storage = {
    getItem: async (key: string) => {
      reads++;
      await readGate;
      return values.get(key);
    },
    setItem: async (key: string, value: string) => {
      const state = JSON.parse(value);
      if (failAcknowledgedWrite && !state.pending && server.posts.length) {
        failAcknowledgedWrite = false;
        throw new Error("Storage unavailable");
      }
      values.set(key, value);
    },
  };
  const server = {
    sessions: {
      agent: { ...sessionWire("agent"), status: "waiting_input" } as Record<string, unknown>,
      chat: { ...sessionWire("chat"), status: "idle", tags: {} as Record<string, string> } as Record<string, unknown>,
    } as Record<string, Record<string, unknown>>,
    events: [] as Wire[],
    questions: [] as ReturnType<typeof question>[],
    revision: 1,
    posts: [] as { path: string; body: Record<string, unknown> }[],
    queries: [] as string[],
    status: 200,
    gate: undefined as Promise<void> | undefined,
    onPost: undefined as (() => void) | undefined,
  };
  const fetcher: typeof fetch = async (url, options) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path === "/api/me") return respond(metadata);
    const id = decodeURIComponent(path.split("/")[3]);
    const session = server.sessions[id];
    if (!session) return respond({}, 404);
    if (options?.method === "POST") {
      const body = options.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : {};
      server.posts.push({ path, body });
      await server.gate;
      server.onPost?.();
      return respond(server.status === 400 ? { detail: "no pending approval request" } : { session }, server.status);
    }
    if (path.endsWith("/events")) {
      server.queries.push(`${id}${parsed.search}`);
      const own = server.events.filter((event) => event.session_id === id);
      const cursor = parsed.searchParams.get("cursor");
      if (cursor !== null)
        return respond({ events: own.filter((event) => event.id > Number(cursor)), has_more: false });
      return respond({
        events: own.slice(-3),
        has_more: own.length > 3,
        pending_questions: {
          as_of_sequence: own.at(-1)?.sequence ?? 0,
          revision: server.revision,
          questions: id === "agent" ? server.questions : [],
        },
      });
    }
    return respond({ session });
  };
  const client = new WaypointClient(connection.apiUrl, fetcher);
  const store = new QuickChatStore(storage, new ServerMutex(directory));
  const controller = (sessionId = "agent") =>
    new InteractionController(
      connection,
      sessionId,
      parseMetadataLoose(),
      store,
      async () => undefined,
      client,
      () => 1000,
    );
  return {
    server,
    store,
    client,
    fetcher,
    values,
    controller,
    setReadGate: (gate: Promise<void> | undefined) => {
      readGate = gate;
    },
    reads: () => reads,
    failAcknowledgedWrite: () => {
      failAcknowledgedWrite = true;
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
function parseMetadataLoose() {
  return { agents: [], targets: [], presets: [], defaultCwd: "" } as unknown as ConstructorParameters<
    typeof InteractionController
  >[2];
}
const approval = (sequence = 1, id = "a1") =>
  wire(sequence, "approval_request", "Run npm test", { approval_id: id, tool_name: "Bash" });
const feed = (overrides: Partial<ConversationSnapshot>): ConversationSnapshot => ({
  events: [],
  loading: false,
  loadingOlder: false,
  hasMore: false,
  stream: "live",
  ...overrides,
});

test("refresh loads full history once for live sessions, then fetches deltas", async () => {
  const f = await fixture();
  f.server.events.push(...[1, 2, 3, 4, 5].map((sequence) => wire(sequence, "agent_output", `part ${sequence}`)));
  f.server.events.push(approval(6));
  const c = f.controller();
  await c.start();
  assert.deepEqual(
    c.getSnapshot().interactions.map((item) => item.key),
    ["approval:a1"],
  );
  assert.ok(f.server.queries.includes("agent?cursor=0"));
  await c.refresh();
  assert.ok(f.server.queries.includes("agent?cursor=106"), f.server.queries.join(" "));
  assert.equal(f.server.queries.filter((query) => query === "agent?cursor=0").length, 1);

  f.server.sessions.chat.status = "idle";
  const idle = f.controller("chat");
  await idle.start();
  assert.ok(!f.server.queries.some((query) => query.startsWith("chat?cursor")), "stopped sessions skip full history");
  await f.close();
});

test("approval submissions post the captured ID and clear their checkpoint and draft", async () => {
  const f = await fixture();
  f.server.events.push(approval());
  const c = f.controller();
  await c.start();
  const captured = c.getSnapshot().interactions[0];
  await c.changeDraft(captured, { note: "Looks safe" });
  f.server.onPost = () => {
    f.server.events.push(wire(2, "system_note", "Approval response sent: approve", { approval_id: "a1" }));
    f.server.sessions.agent.status = "running";
  };
  assert.equal(await c.submit(captured, { note: "Looks safe", decision: "approve" }), true);
  assert.deepEqual(f.server.posts, [
    { path: "/api/sessions/agent/approve", body: { approval_id: "a1", decision: "approve", text: "Looks safe" } },
  ]);
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pending, undefined);
  assert.deepEqual(saved.interactionDrafts, {});
  assert.equal(c.getSnapshot().notice, "Response sent.");
  assert.deepEqual(c.getSnapshot().interactions, []);
  await f.close();
});

test("a request resolved or replaced before submit is never retargeted", async () => {
  const f = await fixture();
  f.server.events.push(approval());
  const c = f.controller();
  await c.start();
  const captured = c.getSnapshot().interactions[0];
  f.server.events.push(
    wire(2, "system_note", "Approval response sent: decline", { approval_id: "a1" }),
    approval(3, "a2"),
  );
  assert.equal(await c.submit(captured, { decision: "approve" }), false);
  assert.match(c.getSnapshot().error!, /resolved or replaced/);
  assert.deepEqual(f.server.posts, []);
  assert.equal((await f.store.load(connection.id)).pending, undefined);
  assert.deepEqual(
    c.getSnapshot().interactions.map((item) => item.key),
    ["approval:a2"],
  );

  f.server.questions = [question("q1")];
  await c.refresh();
  const asked = c.getSnapshot().interactions.find((item) => item.kind === "question")!;
  f.server.questions = [question("q1", [{ question: "Color?", options: [{ label: "Blue" }] }])];
  assert.equal(await c.submit(asked, { selected: { "0": ["Red"] } }), false);
  assert.match(c.getSnapshot().error!, /changed/);
  assert.deepEqual(f.server.posts, []);
  await f.close();
});

test("unconfirmed outcomes keep a durable checkpoint until an explicit release", async () => {
  const f = await fixture();
  f.server.questions = [question("q1")];
  const c = f.controller();
  await c.start();
  const captured = c.getSnapshot().interactions[0];
  f.server.status = 500;
  assert.equal(await c.submit(captured, { selected: { "0": ["Red"] }, notes: { "0": "warm" } }), false);
  assert.match(c.getSnapshot().error!, /did not confirm/);
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pending?.kind, "interaction");
  assert.equal(saved.pending?.interactionAction, "answer-question");
  assert.deepEqual(saved.interactionDrafts?.[c.draftKey(captured)], {
    selected: { "0": ["Red"] },
    notes: { "0": "warm" },
  });

  f.server.status = 200;
  assert.equal(await c.submit(captured, { selected: { "0": ["Red"] } }), false, "no automatic retry");
  assert.equal(f.server.posts.length, 1);
  assert.equal(await c.checkOutcome(), "pending");
  assert.equal(c.getSnapshot().outcome, "pending");
  f.server.questions = [];
  assert.equal(await c.checkOutcome(), "resolved");
  await c.releasePending();
  assert.equal((await f.store.load(connection.id)).pending, undefined);
  assert.equal(c.getSnapshot().outcome, undefined);
  await f.close();
});

test("definitive rejections release the checkpoint and keep the response", async () => {
  for (const status of [401, 409, 422]) {
    const f = await fixture();
    f.server.questions = [question("q1")];
    const c = f.controller();
    await c.start();
    const captured = c.getSnapshot().interactions[0];
    f.server.status = status;
    assert.equal(await c.submit(captured, { selected: { "0": ["Red"] } }), false);
    const saved = await f.store.load(connection.id);
    assert.equal(saved.pending, undefined, String(status));
    assert.deepEqual(saved.interactionDrafts?.[c.draftKey(captured)], { selected: { "0": ["Red"] } });
    assert.match(c.getSnapshot().error!, /kept/);
    await f.close();
  }
});

test("an acknowledged response followed by a storage failure is reported without claiming it is unconfirmed", async () => {
  const f = await fixture();
  f.server.questions = [question("q1")];
  const c = f.controller();
  await c.start();
  const captured = c.getSnapshot().interactions[0];
  f.failAcknowledgedWrite();
  assert.equal(await c.submit(captured, { selected: { "0": ["Red"] } }), false);
  assert.match(c.getSnapshot().error!, /accepted the response/);
  assert.equal((await f.store.load(connection.id)).pending?.kind, "interaction");
  assert.equal(f.server.posts.length, 1);
  await f.close();
});

test("closing during submission still completes the durable outcome", async () => {
  const f = await fixture();
  f.server.questions = [question("q1")];
  const c = f.controller();
  await c.start();
  const captured = c.getSnapshot().interactions[0];
  let release!: () => void;
  f.server.gate = new Promise((resolve) => (release = resolve));
  const submitting = c.submit(captured, {}, true);
  while (!f.server.posts.length) await new Promise((resolve) => setTimeout(resolve, 5));
  c.stop();
  release();
  assert.equal(await submitting, true);
  assert.deepEqual(f.server.posts[0], { path: "/api/sessions/agent/cancel-question", body: { tool_use_id: "q1" } });
  assert.equal((await f.store.load(connection.id)).pending, undefined);
  await f.close();
});

test("question snapshots follow the feed while a refresh is in flight", async () => {
  const f = await fixture();
  f.server.sessions.agent.status = "idle";
  const c = f.controller();
  await c.start();
  const session = parseSession(f.server.sessions.agent);
  const snapshot = (id: string, sequence: number, revision: number) =>
    parseQuestions({ as_of_sequence: sequence, revision, questions: [question(id)] }, "agent");

  f.server.questions = [question("rest")];
  f.server.revision = 1;
  c.ingest(feed({ session, questions: snapshot("feed", 0, 9) }));
  await c.refresh();
  assert.deepEqual(
    c.getSnapshot().interactions.map((item) => item.id),
    ["rest"],
    "a tail fetched after the last feed snapshot is newer even with a reset revision",
  );

  let release!: () => void;
  f.server.gate = undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = new WaypointClient(connection.apiUrl, async (url, options) => {
    await gate;
    return f.fetcher(url, options);
  });
  const racing = new InteractionController(
    connection,
    "agent",
    parseMetadataLoose(),
    f.store,
    async () => undefined,
    slow,
  );
  racing.ingest(feed({ session, questions: snapshot("old", 0, 1) }));
  const refreshing = racing.refresh();
  racing.ingest(feed({ session, questions: snapshot("live", 0, 5) }));
  release();
  await refreshing;
  assert.deepEqual(
    racing.getSnapshot().interactions.map((item) => item.id),
    ["live"],
    "an older REST tail does not replace a newer live snapshot",
  );
  await f.close();
});

test("live approval events trigger a history load and drafts survive filtering until resolution", async () => {
  const f = await fixture();
  f.server.sessions.agent.status = "idle";
  f.server.questions = [question("q1")];
  const c = f.controller();
  await c.start();
  assert.ok(!f.server.queries.includes("agent?cursor=0"));
  const asked = c.getSnapshot().interactions[0];
  await c.changeDraft(asked, { notes: { "0": "keep me" } });
  await c.changeDraft({ ...asked, key: "question:gone", signature: "s" }, { notes: { "0": "stale" } });
  const other = f.controller("chat");
  await other.changeDraft({ ...asked, key: "question:elsewhere", signature: "s" }, { notes: { "0": "other session" } });

  f.server.questions = [{ ...question("q1"), availability: "starting" }];
  f.server.events.push(approval(1));
  f.server.sessions.agent.status = "waiting_input";
  c.ingest(feed({ session: parseSession(f.server.sessions.agent), events: [parseEvent(approval(1), "agent")] }));
  while (!f.server.queries.includes("agent?cursor=0")) await new Promise((resolve) => setTimeout(resolve, 5));
  while (c.getSnapshot().loading) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    c.getSnapshot().interactions.map((item) => item.key),
    ["approval:a1", "question:q1"],
  );
  const drafts = (await f.store.load(connection.id)).interactionDrafts!;
  assert.deepEqual(
    Object.values(drafts)
      .map((draft) => draft.notes?.["0"])
      .sort(),
    ["keep me", "other session"],
  );
  await f.close();
});

test("a request event during a history-less refresh triggers a follow-up history load", async () => {
  const f = await fixture();
  f.server.sessions.agent.status = "idle";
  let release!: () => void;
  f.setReadGate(new Promise<void>((resolve) => (release = resolve)));
  const c = f.controller();
  const starting = c.start();
  while (!f.server.queries.includes("agent?messages=40")) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!f.server.queries.includes("agent?cursor=0"), "the first refresh skipped history");
  f.server.events.push(approval(1));
  f.server.sessions.agent.status = "waiting_input";
  c.ingest(feed({ session: parseSession(f.server.sessions.agent), events: [parseEvent(approval(1), "agent")] }));
  f.setReadGate(undefined);
  release();
  await starting;
  assert.ok(f.server.queries.includes("agent?cursor=0"));
  assert.deepEqual(
    c.getSnapshot().interactions.map((item) => item.key),
    ["approval:a1"],
  );
  await f.close();
});

test("a provably undelivered approval ends without a checkpoint", async () => {
  const f = await fixture();
  f.server.events.push(approval());
  const c = f.controller();
  await c.start();
  f.server.status = 400;
  assert.equal(await c.submit(c.getSnapshot().interactions[0], { decision: "approve" }), false);
  assert.match(c.getSnapshot().error!, /no longer pending/);
  assert.equal((await f.store.load(connection.id)).pending, undefined);
  await f.close();
});

test("interaction checkpoints coordinate with Quick Chat without rebinding it", async () => {
  const f = await fixture();
  const installation = (await f.store.load(connection.id)).installation;
  f.server.sessions.chat.tags = { [ownerTag]: installation, [roleTag]: "quick-chat" };
  await f.store.transaction(connection.id, async (saved, persist) => {
    saved.pointer = "chat";
    await persist();
  });
  f.server.questions = [question("q1")];
  const c = f.controller();
  await c.start();
  f.server.status = 502;
  await c.submit(c.getSnapshot().interactions[0], { selected: { "0": ["Red"] } });
  f.server.status = 200;

  const chat = new QuickChatController(
    connection,
    f.store,
    async () => undefined,
    false,
    f.client,
    () => 1000,
  );
  await chat.start();
  assert.equal(chat.getSnapshot().session?.id, "chat");
  assert.match(chat.getSnapshot().notice!, /request is unconfirmed/);
  await chat.changeDraft("hello");
  await chat.send();
  assert.equal(f.server.posts.length, 1, "Quick Chat does not send past an interaction checkpoint");
  await chat.reconcile();
  assert.match(chat.getSnapshot().notice!, /Build a small garden/);
  await chat.abandonPending();
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pending, undefined);
  assert.equal(saved.pointer, "chat");
  assert.deepEqual(saved.sentAt, {});
  assert.equal(chat.getSnapshot().session?.id, "chat");

  await f.store.transaction(connection.id, async (state, persist) => {
    state.pending = {
      kind: "input",
      operationId: "op",
      sessionId: "chat",
      text: "hi",
      draftKey: "quick",
      startedAt: 1,
    };
    await persist();
  });
  await c.refresh();
  assert.equal(await c.submit(c.getSnapshot().interactions[0], { selected: { "0": ["Red"] } }), false);
  assert.match(c.getSnapshot().error!, /Quick Chat/);
  assert.equal(f.server.posts.length, 1);
  await f.close();
});
