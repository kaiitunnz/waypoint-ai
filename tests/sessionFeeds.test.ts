import assert from "node:assert/strict";
import { test } from "node:test";
import { WaypointClient } from "../src/api/client";
import { SocketFactory, SocketHandlers, Scheduler, LiveSocket, socketUrl } from "../src/api/liveSocket";
import { ConversationFeed, SessionsFeed } from "../src/hooks/sessionFeeds";
import { transcript } from "../src/domain/transcript";
import { eventWire, sessionWire, metadataWire } from "./fixtures/conversation";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const sockets: { handlers: SocketHandlers; closed: boolean }[] = [];
  const jobs = new Map<number, () => void>();
  let jobId = 0;
  const scheduler: Scheduler = {
    set: (callback) => {
      jobs.set(++jobId, callback);
      return jobId;
    },
    clear: (id) => {
      jobs.delete(id as number);
    },
  };
  const factory: SocketFactory = (_url, handlers) => {
    const socket = { handlers, closed: false };
    sockets.push(socket);
    return {
      close: () => {
        socket.closed = true;
      },
    };
  };
  const send = (type: string, payload: unknown, index = sockets.length - 1) =>
    sockets[index].handlers.message(JSON.stringify({ type, payload }));
  const reconnect = () => {
    const callbacks = [...jobs.values()];
    jobs.clear();
    callbacks.forEach((callback) => callback());
  };
  return { sockets, jobs, factory, scheduler, send, reconnect };
}
const connection = { id: "server", name: "Test", apiUrl: "http://localhost", token: "fixture-token" };

test("hydrates only after authenticated snapshot and merges buffered REST/WS overlap", async () => {
  const f = fixture();
  let resolvePage: (response: Response) => void = () => undefined;
  const page = new Promise<Response>((resolve) => {
    resolvePage = resolve;
  });
  const calls: string[] = [];
  const client = new WaypointClient(connection.apiUrl, async (url) => {
    calls.push(String(url));
    return String(url).includes("/events") ? page : response({ session: sessionWire() });
  });
  const feed = new ConversationFeed(connection, "demo", client, f);
  feed.start();
  assert.equal(calls.length, 0);
  f.send("session_state", { session: sessionWire() });
  f.send("event", { event: eventWire(2, "agent_output", "world") });
  resolvePage(
    response({
      events: [eventWire(1, "agent_output", "Hello "), eventWire(2, "agent_output", "world")],
      has_more: true,
    }),
  );
  await tick();
  assert.equal(transcript(feed.getSnapshot().events)[0].text, "Hello world");
  assert.equal(feed.getSnapshot().hasMore, true);
  feed.stop();
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.jobs.size, 0);
});

test("reconnect catches a gap larger than one tail page from REST-confirmed ID, not live maximum", async () => {
  const f = fixture();
  const queries: string[] = [];
  const client = new WaypointClient(connection.apiUrl, async (url) => {
    const path = new URL(String(url));
    if (!path.pathname.endsWith("/events")) return response({ session: sessionWire() });
    queries.push(path.search);
    return response({
      events: path.searchParams.has("cursor")
        ? Array.from({ length: 80 }, (_, index) => eventWire(index + 2, "agent_output", ".", `gap-${index + 2}`))
        : [eventWire(1, "agent_output", "start")],
      has_more: false,
    });
  });
  const feed = new ConversationFeed(connection, "demo", client, f);
  feed.start();
  f.send("session_state", { session: sessionWire() });
  await tick();
  f.send("event", { event: eventWire(81, "agent_output", ".", "gap-81") });
  f.sockets[0].handlers.close(1006);
  f.reconnect();
  f.send("session_state", { session: sessionWire() });
  f.send("event", { event: eventWire(82, "agent_output", "end", "end") });
  await tick();
  assert.ok(queries.some((query) => query.includes("cursor=101")));
  assert.equal(feed.getSnapshot().events.length, 82);
  assert.equal(
    transcript(feed.getSnapshot().events)
      .map((row) => row.text)
      .join(""),
    `start${".".repeat(80)}end`,
  );
  feed.stop();
});

test("a socket question snapshot wins over stale REST and resets revision after reconnect", async () => {
  const f = fixture();
  let release: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let first = true;
  const client = new WaypointClient(connection.apiUrl, async (url) =>
    String(url).includes("/events")
      ? first
        ? pending
        : response({ events: [], has_more: false })
      : response({ session: sessionWire() }),
  );
  const feed = new ConversationFeed(connection, "demo", client, f);
  feed.start();
  f.send("session_state", { session: sessionWire() });
  f.send("pending_questions", { questions: [], as_of_sequence: 10, revision: 8 });
  release(
    response({
      events: [eventWire(10)],
      has_more: false,
      pending_questions: {
        questions: [{ tool_use_id: "old", event: eventWire(1, "tool_call", "question"), availability: "actionable" }],
        as_of_sequence: 1,
        revision: 1,
      },
    }),
  );
  await tick();
  assert.equal(feed.getSnapshot().questions?.questions.length, 0);
  first = false;
  f.sockets[0].handlers.close(1006);
  f.reconnect();
  f.send("session_state", { session: sessionWire() });
  f.send("pending_questions", { questions: [], as_of_sequence: 10, revision: 1 });
  await tick();
  assert.equal(feed.getSnapshot().questions?.revision, 1);
  feed.stop();
});

test("late REST session state and older history do not overwrite live state or questions", async () => {
  const f = fixture();
  let release: (response: Response) => void = () => undefined;
  const delayed = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const client = new WaypointClient(connection.apiUrl, async (url) => {
    const path = new URL(String(url));
    if (path.pathname.endsWith("/events"))
      return response({
        events: [eventWire(path.searchParams.has("before_sequence") ? 1 : 2)],
        has_more: !path.searchParams.has("before_sequence"),
        pending_questions: null,
      });
    return delayed;
  });
  const feed = new ConversationFeed(connection, "demo", client, f);
  feed.start();
  f.send("session_state", { session: sessionWire() });
  f.send("session_state", { session: { ...sessionWire(), status: "idle" } });
  f.send("pending_questions", { questions: [], as_of_sequence: 2, revision: 3 });
  release(response({ session: sessionWire() }));
  await tick();
  await feed.loadOlder();
  assert.equal(feed.getSnapshot().session?.status, "idle");
  assert.equal(feed.getSnapshot().questions?.revision, 3);
  assert.deepEqual(
    feed.getSnapshot().events.map((event) => event.sequence),
    [1, 2],
  );
  feed.stop();
});

test("late HTTP browser list cannot resurrect a session deleted in a newer WS snapshot", async () => {
  const f = fixture();
  let release: (response: Response) => void = () => undefined;
  const delayed = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const client = new WaypointClient(connection.apiUrl, async (url) =>
    String(url).endsWith("/api/me") ? response(metadataWire) : delayed,
  );
  const feed = new SessionsFeed(connection, client, f);
  feed.start();
  f.send("session_list_update", { sessions: [] });
  release(response({ sessions: [sessionWire()] }));
  await tick();
  assert.deepEqual(feed.getSnapshot().sessions, []);
  assert.ok(feed.getSnapshot().metadata);
  feed.stop();
});

test("4401 and auth_revoked stop retries and ignore late data", async () => {
  for (const revoke of [false, true]) {
    const f = fixture();
    const statuses: string[] = [];
    const socket = new LiveSocket(
      socketUrl(connection.apiUrl, connection.token),
      "session_list_update",
      () => undefined,
      (value) => statuses.push(value),
      f.factory,
      f.scheduler,
    );
    socket.start();
    if (revoke) f.send("auth_revoked", {});
    else f.sockets[0].handlers.close(4401);
    assert.equal(statuses.at(-1), "auth-error");
    assert.equal(f.jobs.size, 0);
    f.sockets[0].handlers.close(1006);
    assert.equal(f.jobs.size, 0);
    socket.stop();
  }
});

test("switch/unmount ignores old hydration and cleanup removes retry jobs", async () => {
  const f = fixture();
  let release: (response: Response) => void = () => undefined;
  const delayed = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const client = new WaypointClient(connection.apiUrl, async () => delayed);
  const feed = new ConversationFeed(connection, "demo", client, f);
  feed.start();
  f.send("session_state", { session: sessionWire() });
  let updates = 0;
  const unsubscribe = feed.subscribe(() => {
    updates++;
  });
  feed.stop();
  const before = updates;
  release(response({ events: [eventWire(1)], has_more: false }));
  f.send("event", { event: eventWire(2) });
  await tick();
  assert.equal(updates, before);
  assert.equal(f.jobs.size, 0);
  unsubscribe();
});

test("malformed frames reconnect safely and unknown envelopes have no effect", () => {
  const f = fixture();
  let received = 0;
  const socket = new LiveSocket(
    "ws://localhost",
    "session_state",
    () => {
      received++;
    },
    () => undefined,
    f.factory,
    f.scheduler,
  );
  socket.start();
  f.send("future_message", {});
  assert.equal(received, 1);
  f.sockets[0].handlers.message("not-json-with-private-content");
  assert.equal(f.jobs.size, 1);
  assert.equal(f.sockets[0].closed, true);
  socket.stop();
  assert.equal(f.jobs.size, 0);
});

test("ID-less reconnect pages backward until the prior sequence is bridged", async () => {
  const f = fixture();
  let reconnecting = false;
  const beforeQueries: string[] = [];
  const client = new WaypointClient(connection.apiUrl, async (url) => {
    const path = new URL(String(url));
    if (!path.pathname.endsWith("/events")) return response({ session: sessionWire() });
    const before = path.searchParams.get("before_sequence");
    if (before) beforeQueries.push(before);
    const sequences = !reconnecting ? [1, 2] : before === "5" ? [3, 4] : before === "3" ? [1, 2] : [5, 6];
    return response({
      events: sequences.map((sequence) => ({ ...eventWire(sequence), id: undefined })),
      has_more: reconnecting && before !== "3",
    });
  });
  const feed = new ConversationFeed(connection, "demo", client, f);
  feed.start();
  f.send("session_state", { session: sessionWire() });
  await tick();
  reconnecting = true;
  f.sockets[0].handlers.close(1006);
  f.reconnect();
  f.send("session_state", { session: sessionWire() });
  await tick();
  assert.deepEqual(beforeQueries, ["5", "3"]);
  assert.deepEqual(
    feed.getSnapshot().events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  feed.stop();
});

test("REST history remains readable when the socket cannot subscribe", async () => {
  const f = fixture();
  const client = new WaypointClient(connection.apiUrl, async (url) =>
    String(url).includes("/events")
      ? response({ events: [eventWire(1)], has_more: true })
      : response({ session: sessionWire() }),
  );
  const feed = new ConversationFeed(connection, "demo", client, f);
  feed.start();
  f.sockets[0].handlers.error();
  await tick();
  assert.equal(feed.getSnapshot().events.length, 1);
  assert.equal(feed.getSnapshot().stream, "reconnecting");
  assert.equal(feed.getSnapshot().loading, false);
  feed.stop();
});
