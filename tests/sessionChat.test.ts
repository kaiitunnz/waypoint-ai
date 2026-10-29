import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WaypointClient } from "../src/api/client";
import { parseMetadata } from "../src/api/contracts";
import { createTag, ownerTag, roleTag } from "../src/domain/quickChat";
import { ChatDestination, QuickChatController } from "../src/hooks/quickChatController";
import { SessionManager } from "../src/hooks/sessionManager";
import { restartTimeoutMs } from "../src/hooks/sessionSettingsController";
import { draftKeys, sessionChatDraft } from "../src/storage/drafts";
import { ServerMutex } from "../src/storage/mutex";
import { PendingOperation, QuickChatStore } from "../src/storage/quickChat";
import { eventWire, metadataWire, sessionWire } from "./fixtures/conversation";

const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const connection = { id: "server-a", apiUrl: "http://localhost", name: "A", token: "fixture-token" };
const otherServer = { ...connection, id: "server-b", name: "B" };
const metadataBody = {
  ...metadataWire,
  default_cwd: "/workspace",
  backends: [
    {
      ...metadataWire.backends[0],
      transport_capabilities: { is_structured: true, supports_reattach_after_exit: true },
    },
    metadataWire.backends[1],
    {
      id: "fixed",
      label: "Fixed Agent",
      transport_id: "fixed-rpc",
      default_transport: "fixed-rpc",
      supported_transports: ["fixed-rpc"],
      transport_capabilities: { is_structured: true },
    },
  ],
};
type WireSession = ReturnType<typeof sessionWire> & { tags?: Record<string, string> };
type WireEvent = ReturnType<typeof eventWire>;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "session-chat-"));
  const values = new Map<string, string>();
  const store = new QuickChatStore(
    {
      keys: async () => [...values.keys()],
      entries: async () => [...values],
      removeItem: async (key) => void values.delete(key),
      getItem: async (key) => values.get(key),
      setItem: async (key, value) => void values.set(key, value),
    },
    new ServerMutex(directory),
  );
  const installation = (await store.load(connection.id)).installation;
  const session = (id: string, patch: Partial<WireSession> = {}): WireSession => ({
    ...sessionWire(id),
    status: "idle",
    title: `Session ${id}`,
    ...patch,
  });
  const server = {
    sessions: [
      session("qc", { tags: { [ownerTag]: installation, [roleTag]: "quick-chat" } }),
      session("other"),
      session("second"),
    ],
    events: new Map<string, WireEvent[]>(),
    inputs: [] as { session: string; text: string }[],
    actions: [] as { session: string; action: string }[],
    creates: 0,
    input: "ok" as "ok" | "uncertain",
    action: "ok" as "ok" | "uncertain",
    reads: 0,
    inputGate: undefined as Promise<void> | undefined,
  };
  const client = new WaypointClient(connection.apiUrl, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === "/api/me") return respond(metadataBody);
    if (path === "/api/sessions" && init?.method === "POST") {
      server.creates++;
      return respond({}, 500);
    }
    if (path === "/api/sessions") return respond({ sessions: server.sessions });
    const id = decodeURIComponent(path.split("/")[3]);
    const found = server.sessions.find((item) => item.id === id);
    if (!found) return respond({}, 404);
    if (path.endsWith("/events"))
      return respond({
        events: server.events.get(id) ?? [],
        has_more: false,
        pending_questions: { questions: [], as_of_sequence: 0, revision: 0 },
      });
    if (path.endsWith("/input")) {
      await server.inputGate;
      server.inputs.push({ session: id, text: String(body.text) });
      const events = server.events.get(id) ?? [];
      events.push(eventWire(events.length + 1, "user_input", String(body.text), "", id));
      server.events.set(id, events);
      if (server.input === "uncertain") throw new Error("connection reset");
      return respond({ session: found });
    }
    if (init?.method === "DELETE") {
      server.sessions.splice(server.sessions.indexOf(found), 1);
      return respond({ deleted: id });
    }
    for (const action of ["reattach", "interrupt"])
      if (path.endsWith(`/${action}`)) {
        server.actions.push({ session: id, action });
        if (action === "reattach") found.status = "idle";
        if (server.action === "uncertain") throw new Error("connection reset");
        return respond({ session: found });
      }
    server.reads++;
    return respond({ session: found });
  });
  const timeouts: (number | undefined)[] = [];
  const action = client.action.bind(client);
  client.action = (token, id, kind, timeoutMs) => {
    timeouts.push(timeoutMs);
    return action(token, id, kind, timeoutMs);
  };
  const controller = (destination: ChatDestination, server = connection) =>
    new QuickChatController(
      server,
      store,
      async () => undefined,
      { destination },
      client,
      () => 1_000_000,
    );
  await store.transaction(connection.id, async (saved, persist) => {
    saved.pointer = "qc";
    saved.chosen = { sessionId: "qc", at: 5 };
    await persist();
  });
  return {
    store,
    values,
    server,
    client,
    timeouts,
    metadata: parseMetadata(metadataBody),
    chat: (sessionId: string, at = connection) => controller({ kind: "session", sessionId }, at),
    quick: () => controller({ kind: "quick", resume: true }),
    setPending: (pending: PendingOperation) =>
      store.transaction(connection.id, async (saved, persist) => {
        saved.pending = pending;
        await persist();
      }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("a session chat sends to its session and leaves Quick Chat's destination alone", async () => {
  const f = await fixture();
  const c = f.chat("other");
  await c.start();
  const state = c.getSnapshot();
  assert.equal(state.session?.id, "other");
  assert.equal(state.blocked, undefined);
  assert.equal(c.canSend(), true);
  await c.changeDraft("hello");
  assert.equal(await c.send(), true);
  assert.deepEqual(f.server.inputs, [{ session: "other", text: "hello" }]);
  assert.equal(f.server.creates, 0);
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pointer, "qc");
  assert.deepEqual(saved.chosen, { sessionId: "qc", at: 5 });
  assert.equal(saved.sentAt.other, 1_000_000);
  assert.equal(c.getSnapshot().draft, "");
  await f.close();
});

test("an exited session is reattached before the send, with the restart timeout", async () => {
  const f = await fixture();
  f.server.sessions[1].status = "exited";
  const c = f.chat("other");
  await c.start();
  assert.equal(c.canSend(), true);
  await c.changeDraft("hello");
  assert.equal(await c.send(), true);
  assert.deepEqual(f.server.actions, [{ session: "other", action: "reattach" }]);
  assert.deepEqual(f.timeouts, [restartTimeoutMs]);
  assert.deepEqual(f.server.inputs, [{ session: "other", text: "hello" }]);

  f.server.sessions[1].status = "exited";
  await c.refreshSession();
  await c.action("reattach");
  assert.deepEqual(f.timeouts, [restartTimeoutMs, restartTimeoutMs]);
  assert.equal(c.getSnapshot().session?.status, "idle");
  await f.close();
});

test("a session that can't take messages stays readable and sends nothing", async () => {
  const f = await fixture();
  f.server.sessions.push(
    { ...sessionWire("ended"), backend: "fixed", transport: "fixed-rpc", status: "exited" },
    { ...sessionWire("terminal"), backend: "terminal", transport: "test-terminal" },
  );
  const ended = f.chat("ended");
  await ended.start();
  assert.equal(ended.getSnapshot().session?.id, "ended");
  assert.match(ended.getSnapshot().blocked!, /can't resume it/);
  assert.equal(ended.canSend(), false);
  await ended.changeDraft("hello");
  const reads = f.server.reads;
  assert.equal(await ended.send(), false);
  assert.equal(f.server.reads, reads, "a blocked send doesn't reach Waypoint");
  assert.equal(ended.getSnapshot().error, ended.getSnapshot().blocked);

  const terminal = f.chat("terminal");
  await terminal.start();
  assert.match(terminal.getSnapshot().blocked!, /needs Waypoint/);
  await terminal.action("interrupt");
  assert.deepEqual(f.server.actions, []);
  assert.deepEqual(f.server.inputs, []);
  await f.close();
});

test("blocked follows the session, and a refresh waits for a send in progress", async () => {
  const f = await fixture();
  const c = f.chat("other");
  await c.start();
  Object.assign(f.server.sessions[1], { backend: "fixed", transport: "fixed-rpc", status: "exited" });
  await c.refreshSession();
  assert.match(c.getSnapshot().blocked!, /can't resume it/);
  Object.assign(f.server.sessions[1], { status: "idle" });
  await c.refreshSession();
  assert.equal(c.getSnapshot().blocked, undefined);

  let release!: () => void;
  f.server.inputGate = new Promise<void>((resolve) => (release = resolve));
  await c.changeDraft("hello");
  const sending = c.send();
  while (!c.getSnapshot().busy) await new Promise((resolve) => setImmediate(resolve));
  const reads = f.server.reads;
  await c.refreshSession();
  assert.equal(f.server.reads, reads);
  release();
  assert.equal(await sending, true);
  await f.close();
});

test("each session keeps its own drafts, separate from other servers", async () => {
  const f = await fixture();
  const a = f.chat("other");
  const b = f.chat("second");
  await Promise.all([a.start(), b.start()]);
  await a.changeDraft("for other");
  await b.changeDraft("for second");
  await a.setComposeText("composed for other");
  assert.equal(f.values.get(draftKeys.line(connection.id, sessionChatDraft("other"))), "for other");
  assert.equal(f.values.get(draftKeys.line(connection.id, sessionChatDraft("second"))), "for second");
  assert.equal(f.values.get(draftKeys.compose(connection.id, sessionChatDraft("other"))), "composed for other");
  a.stop();
  const reopened = f.chat("other");
  await reopened.start();
  assert.equal(reopened.getSnapshot().draft, "for other");
  assert.equal(reopened.composeText(), "composed for other");
  const elsewhere = f.chat("other", otherServer);
  await elsewhere.start();
  assert.equal(elsewhere.getSnapshot().draft, "");
  const quick = f.quick();
  await quick.start();
  assert.equal(quick.getSnapshot().draft, "");
  await f.close();
});

test("a session chat's unconfirmed send is shown in Quick Chat without switching it", async () => {
  const f = await fixture();
  const c = f.chat("other");
  await c.start();
  f.server.input = "uncertain";
  await c.changeDraft("hello");
  assert.equal(await c.send(), false);
  assert.equal(c.getSnapshot().pending?.draftKey, sessionChatDraft("other"));
  assert.equal(c.getSnapshot().pendingOwned, true);

  const quick = f.quick();
  await quick.start();
  let state = quick.getSnapshot();
  assert.equal(state.error, undefined);
  assert.equal(state.session?.id, "qc");
  assert.equal(state.pending?.sessionId, "other");
  assert.equal(state.pendingOwned, false);
  assert.equal(quick.canSend(), false);
  await quick.reconcile();
  state = quick.getSnapshot();
  assert.equal(state.session?.id, "qc");
  assert.match(state.notice!, /recorded matching input in “Session other”/);
  await quick.abandonPending();
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pending, undefined);
  assert.equal(saved.pointer, "qc");
  assert.deepEqual(saved.chosen, { sessionId: "qc", at: 5 });
  assert.equal(quick.getSnapshot().session?.id, "qc");
  await f.close();
});

test("an unconfirmed operation started elsewhere doesn't open its session in an empty Quick Chat", async () => {
  const f = await fixture();
  await f.store.transaction(connection.id, async (saved, persist) => {
    saved.pointer = saved.chosen = undefined;
    await persist();
  });
  for (const kind of ["input", "interrupt"] as const) {
    await f.setPending({
      kind,
      operationId: `op-${kind}`,
      sessionId: "other",
      text: "",
      draftKey: sessionChatDraft("other"),
      startedAt: 1,
    });
    const quick = f.quick();
    await quick.start();
    assert.equal(quick.getSnapshot().session, undefined, kind);
    await quick.reconcile();
    assert.equal(quick.getSnapshot().session, undefined, kind);
    assert.match(quick.getSnapshot().notice!, /Session other/, kind);
  }
  await f.close();
});

test("a session chat shows Quick Chat's checkpoint, and clearing it keeps Quick Chat's destination", async () => {
  const f = await fixture();
  const quick = f.quick();
  await quick.start();
  f.server.input = "uncertain";
  await quick.changeDraft("hello");
  assert.equal(await quick.send(), false);
  assert.equal(quick.getSnapshot().pending?.draftKey, "quick");
  f.server.input = "ok";

  const c = f.chat("other");
  await c.start();
  assert.equal(c.getSnapshot().session?.id, "other");
  assert.equal(c.getSnapshot().pendingOwned, false);
  assert.equal(c.canSend(), false);
  await c.reconcile();
  assert.equal(c.getSnapshot().session?.id, "other");
  assert.match(c.getSnapshot().notice!, /“Session qc”/);
  await c.abandonPending();
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pending, undefined);
  assert.equal(saved.pointer, "qc");
  assert.deepEqual(saved.chosen, { sessionId: "qc", at: 5 });
  assert.equal(c.getSnapshot().session?.id, "other");
  assert.equal(c.canSend(), true);
  await f.close();
});

test("a session chat checks Quick Chat's unconfirmed message to its own session in place", async () => {
  const f = await fixture();
  const quick = f.quick();
  await quick.start();
  f.server.input = "uncertain";
  await quick.changeDraft("hello");
  await quick.send();
  const c = f.chat("qc");
  await c.start();
  assert.equal(c.getSnapshot().pendingOwned, false);
  await c.reconcile();
  assert.equal(c.getSnapshot().session?.id, "qc");
  assert.match(c.getSnapshot().notice!, /^Waypoint recorded matching input\. /);
  await f.close();
});

test("a session chat clears its own checkpoint and keeps its session", async () => {
  const f = await fixture();
  const c = f.chat("other");
  await c.start();
  f.server.action = "uncertain";
  f.server.sessions[1].status = "exited";
  await c.refreshSession();
  await c.action("reattach");
  const pending = c.getSnapshot().pending;
  assert.equal(pending?.kind, "reattach");
  assert.equal(pending?.draftKey, sessionChatDraft("other"));
  assert.equal(c.getSnapshot().pendingOwned, true);
  await c.abandonPending();
  assert.equal((await f.store.load(connection.id)).pending, undefined);
  assert.equal(c.getSnapshot().session?.id, "other");
  assert.equal((await f.store.load(connection.id)).pointer, "qc");
  await f.close();
});

test("a session chat whose session is gone never switches to a session Quick Chat recovers", async () => {
  const f = await fixture();
  f.server.sessions.push({
    ...sessionWire("recovered"),
    tags: { [ownerTag]: (await f.store.load(connection.id)).installation, [roleTag]: "quick-chat", [createTag]: "op" },
  });
  await f.setPending({ kind: "create", operationId: "op", text: "", draftKey: "quick", startedAt: 1 });
  const c = f.chat("missing");
  await c.start();
  assert.equal(c.getSnapshot().error, "This session is no longer on this server.");
  assert.equal(c.getSnapshot().blocked, "This session is no longer on this server.");
  assert.equal(c.getSnapshot().pendingOwned, false);
  await c.reconcile();
  assert.equal((await f.store.load(connection.id)).pointer, "recovered");
  assert.equal(c.getSnapshot().session, undefined);
  await f.close();
});

test("an interaction checkpoint belongs to no chat", async () => {
  const f = await fixture();
  await f.setPending({
    kind: "interaction",
    operationId: "op",
    sessionId: "other",
    text: "",
    draftKey: "other:q1:sig",
    startedAt: 1,
    interactionKey: "q1",
    interactionAction: "approve",
  });
  const c = f.chat("other");
  const quick = f.quick();
  await Promise.all([c.start(), quick.start()]);
  assert.equal(c.getSnapshot().pending?.kind, "interaction");
  assert.equal(c.getSnapshot().pendingOwned, false);
  assert.equal(quick.getSnapshot().pendingOwned, false);
  assert.equal(quick.getSnapshot().session?.id, "qc");
  await f.close();
});

test("uploads another view dropped with a checkpoint aren't written back", async () => {
  const f = await fixture();
  const key = sessionChatDraft("other");
  const upload = { sessionId: "other", attachmentId: "att-1", uploadedAt: 1 };
  await f.store.transaction(connection.id, async (saved, persist) => {
    saved.compose = {
      [key]: {
        context: [],
        files: [{ id: "f1", path: "/tmp/f1.txt", name: "f1.txt", size: 1, modifiedMs: 1, upload }],
      },
    };
    await persist();
  });
  await f.setPending({
    kind: "input",
    operationId: "op",
    sessionId: "other",
    text: "hello",
    draftKey: key,
    startedAt: 1,
    attachments: ["att-1"],
  });
  const c = f.chat("other");
  await c.start();
  assert.deepEqual(c.getSnapshot().compose.files[0].upload, upload);
  const quick = f.quick();
  await quick.start();
  await quick.abandonPending();
  assert.equal(quick.getSnapshot().compose.files.length, 0);
  await c.syncPending();
  assert.equal(c.getSnapshot().pending, undefined);
  assert.equal(c.getSnapshot().compose.files[0].upload, undefined);
  assert.equal(await c.stageContext("clipboard", "more"), true);
  assert.equal((await f.store.load(connection.id)).compose?.[key].files[0].upload, undefined);
  await f.close();
});

test("deleting a session forgets its chat drafts, and a chat left open doesn't save them again", async () => {
  const f = await fixture();
  f.server.sessions[1].status = "exited";
  const key = sessionChatDraft("other");
  const line = draftKeys.line(connection.id, key);
  const composed = draftKeys.compose(connection.id, key);
  const c = f.chat("other");
  await c.start();
  await c.changeDraft("kept until deleted");
  await c.setComposeText("composed");
  assert.equal(await c.stageContext("clipboard", "context"), true);
  assert.ok((await f.store.load(connection.id)).compose?.[key]);

  const outcome = await new SessionManager(connection, f.store, f.client).remove("other", f.metadata);
  assert.equal(outcome.kind, "done");
  assert.equal(f.values.has(line), false);
  assert.equal(f.values.has(composed), false);
  assert.equal((await f.store.load(connection.id)).compose?.[key], undefined);

  await c.refreshSession();
  assert.equal(c.getSnapshot().blocked, "This session is no longer on this server.");
  await c.changeDraft("typed after the delete");
  await c.setComposeText("composed after the delete");
  assert.equal(await c.stageContext("clipboard", "more"), false);
  await c.syncPending();
  await f.setPending({ kind: "input", operationId: "op", sessionId: "qc", text: "", draftKey: "quick", startedAt: 1 });
  await c.syncPending();
  assert.equal(c.getSnapshot().blocked, "This session is no longer on this server.");
  assert.equal(f.values.has(line), false);
  assert.equal(f.values.has(composed), false);
  assert.equal((await f.store.load(connection.id)).compose?.[key], undefined);
  await f.close();
});

test("a chat that finds its session deleted elsewhere removes the session's drafts", async () => {
  const f = await fixture();
  const key = sessionChatDraft("other");
  const line = draftKeys.line(connection.id, key);
  const c = f.chat("other");
  await c.start();
  await c.changeDraft("typed before the delete");
  assert.equal(await c.stageContext("clipboard", "context"), true);
  f.server.sessions.splice(1, 1);
  await c.refreshSession();
  assert.equal(c.getSnapshot().blocked, "This session is no longer on this server.");
  for (let wait = 0; wait < 50 && f.values.has(line); wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.values.has(line), false);
  assert.equal((await f.store.load(connection.id)).compose?.[key], undefined);
  assert.equal((await f.store.load(connection.id)).pointer, "qc");
  await f.close();
});

test("a deleted session's drafts are kept while a checkpoint needs it, then removed on the next refresh", async () => {
  const f = await fixture();
  const line = draftKeys.line(connection.id, sessionChatDraft("other"));
  const c = f.chat("other");
  await c.start();
  await c.changeDraft("typed before the delete");
  await f.setPending({
    kind: "input",
    operationId: "op",
    sessionId: "other",
    text: "",
    draftKey: "quick",
    startedAt: 1,
  });
  f.server.sessions.splice(1, 1);
  await c.refreshSession();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.values.get(line), "typed before the delete");
  await f.store.transaction(connection.id, async (saved, persist) => {
    saved.pending = undefined;
    await persist();
  });
  await c.refreshSession();
  for (let wait = 0; wait < 50 && f.values.has(line); wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.values.has(line), false);
  await f.close();
});

test("starting, ending, and new chats belong to Quick Chat", async () => {
  const f = await fixture();
  const c = f.chat("other");
  await c.start();
  await assert.rejects(c.createSession((await f.store.load(connection.id)).defaults), /Quick Chat/);
  await c.newChat();
  assert.equal(c.getSnapshot().session?.id, "other");
  assert.equal(await c.terminate(), undefined);
  assert.equal(await c.terminateAndDelete(), undefined);
  assert.equal(f.server.creates, 0);
  assert.deepEqual(f.server.actions, []);
  await f.close();
});

test("staged context for several session chats stays one bounded state value", async () => {
  const f = await fixture();
  const chunk = "x".repeat(250 * 1024);
  for (const id of ["qc", "other", "second"]) {
    const c = f.chat(id);
    await c.start();
    for (let index = 0; index < 4; index++) assert.equal(await c.stageContext("clipboard", chunk), true, id);
  }
  const stored = f.values.get(`waypoint.quick-chat.${connection.id}`)!;
  assert.ok(stored.length < 3 * 4 * chunk.length + 64 * 1024, `${stored.length} bytes`);
  await f.close();
});
