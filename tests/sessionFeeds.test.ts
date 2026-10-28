import assert from "node:assert/strict";
import { test } from "node:test";
import { WaypointClient } from "../src/api/client";
import { SocketFactory, SocketHandlers, Scheduler, LiveSocket, socketUrl } from "../src/api/liveSocket";
import { ConversationFeed, SessionsFeed, bridgePages, turnPages } from "../src/hooks/sessionFeeds";
import { chatExchanges } from "../src/domain/chatPresentation";
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

const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
// A session whose history is served in pages of `size` events, newest first, as Waypoint does.
// `prompts` are the sequences that are user messages; `hold` delays the next events response.
function pagedServer(size: number, last: number, prompts: number[] = []) {
  const server = {
    last,
    fail: false,
    gone: false,
    queries: [] as string[],
    hold: undefined as Promise<void> | undefined,
  };
  const client = new WaypointClient(connection.apiUrl, async (url) => {
    const path = new URL(String(url));
    if (!path.pathname.endsWith("/events"))
      return server.gone ? response({ detail: "session not found" }, 404) : response({ session: sessionWire() });
    server.queries.push(path.search);
    const hold = server.hold;
    server.hold = undefined;
    await hold;
    if (server.fail) return response({ detail: "unavailable" }, 503);
    const end = Number(path.searchParams.get("before_sequence") ?? server.last + 1) - 1;
    const start = Math.max(1, end - size + 1);
    return response({
      events: range(start, end).map((sequence) =>
        prompts.includes(sequence)
          ? eventWire(sequence, "user_input", `prompt-${sequence}`, "")
          : eventWire(sequence, "agent_output", ".", `item-${sequence}`),
      ),
      has_more: start > 1,
    });
  });
  return { server, client };
}
const sequences = (feed: ConversationFeed) => feed.getSnapshot().events.map((event) => event.sequence);
async function resume(f: ReturnType<typeof fixture>, feed: ConversationFeed, live: number[] = []) {
  feed.stop();
  feed.start();
  f.send("session_state", { session: sessionWire() });
  for (const sequence of live) f.send("event", { event: eventWire(sequence, "agent_output", ".", `item-${sequence}`) });
  for (let index = 0; index < 20; index++) await tick();
}

test("a resumed conversation bridges a small gap from the latest page", async () => {
  const f = fixture();
  const { server, client } = pagedServer(3, 10);
  const feed = new ConversationFeed(connection, "demo", client, f);
  await resume(f, feed);
  assert.deepEqual(sequences(feed), [8, 9, 10]);
  server.last = 20;
  await resume(f, feed);
  assert.deepEqual(sequences(feed), range(8, 20));
  assert.deepEqual(feed.getSnapshot().gaps, []);
  assert.equal(feed.getSnapshot().contiguousFrom, undefined);
  assert.ok(server.queries.every((query) => !query.includes("cursor")));
  feed.stop();
});

test("a gap too large to bridge is acknowledged until Reload Conversation", async () => {
  const f = fixture();
  const { server, client } = pagedServer(3, 10);
  const feed = new ConversationFeed(connection, "demo", client, f);
  await resume(f, feed);
  server.last = 40;
  await resume(f, feed);
  assert.deepEqual(sequences(feed), [8, 9, 10, ...range(23, 40)]);
  assert.equal(server.queries.filter((query) => query.includes("before_sequence")).length, bridgePages);
  assert.deepEqual(feed.getSnapshot().gaps, [23]);
  assert.equal(feed.getSnapshot().contiguousFrom, 23);
  server.last = 41;
  await resume(f, feed);
  assert.deepEqual(feed.getSnapshot().gaps, [23], "a later catch-up keeps the notice");
  server.last = 80;
  await resume(f, feed);
  assert.deepEqual(feed.getSnapshot().gaps, [23, 63], "a second long absence adds its own gap");
  assert.equal(feed.getSnapshot().contiguousFrom, 63);
  feed.reload();
  for (let index = 0; index < 20; index++) await tick();
  assert.deepEqual(sequences(feed), [78, 79, 80]);
  assert.deepEqual(feed.getSnapshot().gaps, []);
  assert.equal(feed.getSnapshot().contiguousFrom, undefined);
  assert.equal(feed.getSnapshot().hasMore, true);
  feed.stop();
});

test("a bridge whose last page starts right after the loaded history leaves no gap", async () => {
  const f = fixture();
  const { server, client } = pagedServer(3, 10);
  const feed = new ConversationFeed(connection, "demo", client, f);
  await resume(f, feed);
  server.last = 10 + 3 * (bridgePages + 1);
  await resume(f, feed);
  assert.deepEqual(sequences(feed), range(8, server.last));
  assert.deepEqual(feed.getSnapshot().gaps, []);
  assert.equal(feed.getSnapshot().contiguousFrom, undefined);
  feed.stop();
});

test("a failed resume counts requests only past the hole until a later resume bridges it", async () => {
  const f = fixture();
  const { server, client } = pagedServer(4, 10);
  const feed = new ConversationFeed(connection, "demo", client, f);
  await resume(f, feed);
  assert.deepEqual(sequences(feed), [7, 8, 9, 10]);
  server.fail = true;
  await resume(f, feed, [22]);
  assert.deepEqual(sequences(feed), [7, 8, 9, 10, 22]);
  assert.equal(feed.getSnapshot().contiguousFrom, 11);
  await resume(f, feed);
  assert.equal(feed.getSnapshot().contiguousFrom, 23, "a second failure moves past the newer hole");
  server.fail = false;
  server.last = 25;
  await resume(f, feed);
  assert.deepEqual(sequences(feed), range(7, 25), "the bridge reaches back to the first hole");
  assert.equal(feed.getSnapshot().contiguousFrom, undefined);
  assert.deepEqual(feed.getSnapshot().gaps, []);

  server.fail = true;
  await resume(f, feed, [40]);
  server.fail = false;
  server.last = 100;
  await resume(f, feed);
  assert.deepEqual(feed.getSnapshot().gaps, [26, 77], "a hole the bridge doesn't reach is marked with the gap past it");
  assert.equal(feed.getSnapshot().contiguousFrom, 77);

  const empty = pagedServer(4, 10);
  empty.server.fail = true;
  const fresh = new ConversationFeed(connection, "demo", empty.client, f);
  await resume(f, fresh);
  assert.ok(fresh.getSnapshot().error);
  assert.equal(fresh.getSnapshot().contiguousFrom, undefined, "a failure with nothing loaded leaves no hole");
  feed.stop();
  fresh.stop();
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
  assert.deepEqual(beforeQueries, ["5"], "a page starting right after the held history joins it");
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

test("pausing a hidden conversation closes subscriptions and resuming catches up", async () => {
  const f = fixture();
  let resume = false;
  const client = new WaypointClient(connection.apiUrl, async (url) =>
    String(url).includes("/events")
      ? response({ events: [eventWire(resume ? 2 : 1)], has_more: false })
      : response({ session: sessionWire() }),
  );
  const feed = new ConversationFeed(connection, "demo", client, f);
  feed.start();
  f.send("session_state", { session: sessionWire() });
  await tick();
  feed.stop();
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.jobs.size, 0);
  f.send("event", { event: eventWire(2) }, 0);
  assert.equal(feed.getSnapshot().events.length, 1);
  resume = true;
  feed.start();
  f.send("session_state", { session: sessionWire() });
  await tick();
  assert.deepEqual(
    feed.getSnapshot().events.map((event) => event.sequence),
    [1, 2],
  );
  feed.stop();
});

test("retrying a stopped conversation opens no socket until it starts again", () => {
  const f = fixture();
  const client = new WaypointClient(connection.apiUrl, async () => response({ session: sessionWire() }));
  const feed = new ConversationFeed(connection, "demo", client, f);
  feed.start();
  feed.stop();
  const opened = f.sockets.length;
  feed.retry();
  assert.equal(f.sockets.length, opened);
  assert.ok(f.sockets.every((socket) => socket.closed));
  feed.start();
  assert.equal(f.sockets.length, opened + 1);
  feed.stop();
});

test("mutation results show at once and an older refresh never overwrites them", async () => {
  const f = fixture();
  let release: (value: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const client = new WaypointClient(connection.apiUrl, async (url) =>
    String(url).endsWith("/api/me") ? response(metadataWire) : pending,
  );
  const feed = new SessionsFeed(connection, client, f);
  feed.start();
  f.send("session_list_update", { sessions: [sessionWire("a"), sessionWire("b")] });
  feed.apply({ ...feed.getSnapshot().sessions[0], title: "Renamed" });
  feed.remove("b");
  release(response({ sessions: [sessionWire("a"), sessionWire("b")] }));
  await tick();
  await tick();
  assert.deepEqual(
    feed.getSnapshot().sessions.map((session) => [session.id, session.title]),
    [["a", "Renamed"]],
  );
  f.send("session_list_update", { sessions: [sessionWire("a"), sessionWire("c")] });
  assert.deepEqual(
    feed.getSnapshot().sessions.map((session) => session.id),
    ["a", "c"],
  );
  feed.stop();
});

test("an open conversation notices its session was deleted elsewhere", async () => {
  const f = fixture();
  const watch = fixture();
  let exists = true;
  let checks = 0;
  const client = new WaypointClient(connection.apiUrl, async (url) => {
    if (String(url).includes("/events")) return response({ events: [], has_more: false });
    checks++;
    return exists ? response({ session: sessionWire() }) : response({ detail: "session not found" }, 404);
  });
  const feed = new ConversationFeed(connection, "demo", client, { ...f, watch: watch.scheduler });
  feed.start();
  f.send("session_state", { session: sessionWire() });
  await tick();
  assert.equal(watch.jobs.size, 1);
  const before = checks;
  watch.reconnect();
  await tick();
  assert.equal(checks, before + 1);
  assert.equal(feed.getSnapshot().error, undefined);
  assert.equal(watch.jobs.size, 1);
  exists = false;
  watch.reconnect();
  await tick();
  assert.equal(feed.getSnapshot().error?.kind, "not-found");
  assert.equal(f.sockets[0].closed, true);
  assert.equal(watch.jobs.size, 0);
  feed.stop();
  const idle = fixture();
  const hidden = new ConversationFeed(connection, "demo", client, { ...idle, watch: idle.scheduler });
  hidden.start();
  hidden.stop();
  assert.equal(idle.jobs.size, 0);
});

const olderQueries = (server: { queries: string[] }) =>
  server.queries.filter((query) => query.includes("before_sequence")).length;
const exchangeIds = (feed: ConversationFeed) =>
  chatExchanges(transcript(feed.getSnapshot().events), feed.getSnapshot().gaps).map((exchange) => exchange.id);
function released() {
  let release = () => undefined as void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { hold, release };
}

test("loading an earlier turn reads past activity whose prompt is on an earlier page", async () => {
  const f = fixture();
  const { server, client } = pagedServer(3, 12, [5, 11]);
  const feed = new ConversationFeed(connection, "demo", client, f);
  await resume(f, feed);
  assert.deepEqual(exchangeIds(feed), ["assistant:item-10", "sequence:11"]);
  assert.equal(await feed.loadOlderTurn(), "loaded");
  assert.equal(olderQueries(server), 2);
  assert.deepEqual(exchangeIds(feed), ["assistant:item-4", "sequence:5", "sequence:11"]);
  assert.equal(feed.getSnapshot().loadingOlder, false);
  feed.stop();
});

test("loading an earlier turn stops at the page cap or the start of history", async () => {
  const f = fixture();
  const long = pagedServer(3, 30);
  const feed = new ConversationFeed(connection, "demo", long.client, f);
  await resume(f, feed);
  assert.equal(await feed.loadOlderTurn(), "loaded");
  assert.equal(olderQueries(long.server), turnPages);
  assert.equal(feed.getSnapshot().hasMore, true);
  feed.stop();

  const short = pagedServer(3, 6);
  const shortFeed = new ConversationFeed(connection, "demo", short.client, f);
  await resume(f, shortFeed);
  assert.equal(await shortFeed.loadOlderTurn(), "loaded");
  assert.equal(olderQueries(short.server), 1);
  assert.equal(shortFeed.getSnapshot().hasMore, false);
  assert.equal(await shortFeed.loadOlderTurn(), "skipped");
  shortFeed.stop();
});

test("a failed page stops loading an earlier turn without retrying", async () => {
  const f = fixture();
  const { server, client } = pagedServer(3, 30);
  const feed = new ConversationFeed(connection, "demo", client, f);
  await resume(f, feed);
  server.fail = true;
  assert.equal(await feed.loadOlderTurn(), "failed");
  assert.equal(olderQueries(server), 1);
  assert.equal(feed.getSnapshot().loadingOlder, false);
  assert.ok(feed.getSnapshot().error);
  feed.stop();
});

test("reloading while an earlier turn loads abandons the walk", async () => {
  const f = fixture();
  const { server, client } = pagedServer(3, 30);
  const feed = new ConversationFeed(connection, "demo", client, f);
  await resume(f, feed);
  const { hold, release } = released();
  server.hold = hold;
  const walk = feed.loadOlderTurn();
  await tick();
  feed.reload();
  release();
  assert.equal(await walk, "stale");
  for (let index = 0; index < 20; index++) await tick();
  assert.equal(olderQueries(server), 1);
  assert.deepEqual(sequences(feed), [28, 29, 30]);
  assert.equal(feed.getSnapshot().loadingOlder, false);
  feed.stop();
});

test("a session deleted while an earlier turn loads stops loading", async () => {
  const f = fixture();
  const watch = fixture();
  const { server, client } = pagedServer(3, 30);
  const feed = new ConversationFeed(connection, "demo", client, { ...f, watch: watch.scheduler });
  await resume(f, feed);
  const { hold, release } = released();
  server.hold = hold;
  const walk = feed.loadOlderTurn();
  server.gone = true;
  watch.reconnect();
  await tick();
  release();
  assert.equal(await walk, "stale");
  assert.equal(feed.getSnapshot().error?.kind, "not-found");
  assert.equal(feed.getSnapshot().loadingOlder, false);
  feed.stop();
});

test("one earlier turn loads at a time and live turns don't end the walk", async () => {
  const f = fixture();
  const { server, client } = pagedServer(3, 30);
  const feed = new ConversationFeed(connection, "demo", client, f);
  await resume(f, feed);
  const { hold, release } = released();
  server.hold = hold;
  const loading: boolean[] = [];
  const unsubscribe = feed.subscribe(() => loading.push(feed.getSnapshot().loadingOlder));
  const walk = feed.loadOlderTurn();
  assert.equal(feed.loadOlderTurn(), walk);
  assert.equal(await feed.loadOlder(), "skipped");
  f.send("event", { event: eventWire(31, "user_input", "live prompt", "") });
  release();
  assert.equal(await walk, "loaded");
  unsubscribe();
  assert.equal(olderQueries(server), turnPages);
  assert.deepEqual(loading.slice(0, -1), Array(loading.length - 1).fill(true));
  assert.equal(loading.at(-1), false);
  feed.stop();
});
