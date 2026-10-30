import assert from "node:assert/strict";
import { test } from "node:test";
import { WaypointClient } from "../src/api/client";
import { Scheduler, SocketFactory, SocketHandlers } from "../src/api/liveSocket";
import { InboxFeed } from "../src/hooks/inboxFeed";
import { ReadPolicy } from "../src/hooks/inboxRead";
import { at, itemWire } from "./fixtures/inbox";

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tick = async () => {
  for (let index = 0; index < 5; index++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const connection = { id: "server", name: "Test", apiUrl: "http://localhost", token: "fixture-token" };

function sockets() {
  const open: SocketHandlers[] = [];
  const factory: SocketFactory = (_url, handlers) => {
    open.push(handlers);
    return { close: () => undefined };
  };
  const jobs = new Map<number, () => void>();
  let id = 0;
  const scheduler: Scheduler = {
    set: (callback) => (jobs.set(++id, callback), id),
    clear: (job) => void jobs.delete(job as number),
  };
  const send = (type: string, payload: unknown) => open.at(-1)!.message(JSON.stringify({ type, payload }));
  return { open, factory, scheduler, send, jobs };
}

// A Waypoint inbox whose pages the test controls.
function server(pages: Record<string, unknown[]>) {
  const requests: string[] = [];
  const held: { url: string; resolve: () => void }[] = [];
  let hold = false;
  const client = new WaypointClient(connection.apiUrl, async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/api/me")) return respond({ authenticated: true, backends: [], launch_targets: [] });
    if (url.endsWith("/unresolved-count")) return respond({ unresolved_count: 7 });
    const match = /\/api\/inbox\/([^/?]+)$/.exec(url);
    if (match) {
      const found = Object.values(pages)
        .flat()
        .find((entry) => (entry as { id: string }).id === match[1]);
      return found ? respond({ item: found }) : respond({ detail: "inbox item not found" }, 404);
    }
    const params = new URL(url).searchParams;
    const key = `${params.get("status")}:${params.get("cursor") ?? ""}:${params.get("q") ?? ""}`;
    const page = pages[key] ?? [];
    const body = {
      items: page,
      has_more: !!pages[`${key}:more`],
      cursor: (pages[`${key}:more`] as string[] | undefined)?.[0],
    };
    if (hold) await new Promise<void>((resolve) => held.push({ url, resolve }));
    return respond(body);
  });
  return {
    client,
    requests,
    held,
    hold: (value: boolean) => {
      hold = value;
    },
  };
}
const ids = (feed: InboxFeed) => ({
  open: feed.getSnapshot().sections.open.items.map((item) => item.id),
  resolved: feed.getSnapshot().sections.resolved.items.map((item) => item.id),
});
const inboxRequests = (requests: string[]) =>
  requests.filter((url) => url.includes("/api/inbox?")).map((url) => new URL(url).search);

test("Resolved loads only once shown, then as soon as Open is exhausted; the count is seeded", async () => {
  const s = sockets();
  const api = server({
    "open::": [itemWire("b", { updated_at: at(2) })],
    "resolved::": [itemWire("a", { status: "resolved" })],
  });
  const feed = new InboxFeed(connection, api.client, s);
  feed.start();
  await tick();
  assert.deepEqual(ids(feed), { open: ["b"], resolved: [] });
  assert.deepEqual(inboxRequests(api.requests), ["?status=open&limit=30"]);
  assert.equal(feed.getSnapshot().unresolvedCount, 7);
  assert.equal(feed.getSnapshot().loading, false);
  feed.setShowResolved(true);
  await tick();
  assert.deepEqual(ids(feed), { open: ["b"], resolved: ["a"] });
  // A search reads Resolved again while it's shown.
  feed.setQuery("x");
  await tick();
  assert.deepEqual(inboxRequests(api.requests).slice(-2), [
    "?status=open&limit=30&q=x",
    "?status=resolved&limit=30&q=x",
  ]);
  feed.stop();
});

test("paging continues Open before Resolved, and a search starts over", async () => {
  const s = sockets();
  const api = server({
    "open::": [itemWire("c", { updated_at: at(3) })],
    "open:::more": ["3|c"],
    "open:3|c:": [itemWire("b", { updated_at: at(2) })],
    "open::deploy": [itemWire("d", { subject: "deploy" })],
  });
  const feed = new InboxFeed(connection, api.client, s);
  feed.setShowResolved(true);
  feed.start();
  await tick();
  assert.deepEqual(ids(feed).open, ["c"]);
  feed.loadMore();
  await tick();
  assert.deepEqual(ids(feed).open, ["c", "b"]);
  assert.ok(inboxRequests(api.requests).includes("?status=open&limit=30&cursor=3%7Cc"));
  assert.ok(inboxRequests(api.requests).includes("?status=resolved&limit=30"));
  feed.setQuery("deploy");
  await tick();
  assert.deepEqual(ids(feed).open, ["d"]);
  assert.ok(inboxRequests(api.requests).includes("?status=resolved&limit=30&q=deploy"));
  feed.stop();
});

test("a stale page doesn't bring back an item deleted while it loaded", async () => {
  const s = sockets();
  const api = server({ "open::": [itemWire("a"), itemWire("b", { updated_at: at(1) })] });
  api.hold(true);
  const feed = new InboxFeed(connection, api.client, s);
  feed.start();
  s.send("session_list_update", { sessions: [] });
  await tick();
  s.send("inbox_update", { item_id: "a", unresolved_count: 1, deleted: true, item: null });
  api.held.splice(0).forEach((request) => request.resolve());
  await tick();
  assert.deepEqual(ids(feed).open, ["b"]);
  assert.equal(feed.getSnapshot().unresolvedCount, 1);
  feed.stop();
});

test("live updates merge, unreadable updates are skipped, and a reconnect reads the first pages again", async () => {
  const s = sockets();
  const api = server({ "open::": [itemWire("a")] });
  const feed = new InboxFeed(connection, api.client, s);
  feed.start();
  s.send("session_list_update", { sessions: [] });
  await tick();
  s.send("inbox_update", {
    item_id: "n",
    unresolved_count: 2,
    deleted: false,
    item: itemWire("n", { updated_at: at(9) }),
  });
  s.send("inbox_update", { item_id: "x", unresolved_count: 2, deleted: false, item: { id: "x" } });
  s.send("event", { event: {} });
  assert.deepEqual(ids(feed).open, ["n", "a"]);
  assert.equal(s.open.length, 1, "the connection stays up");
  const before = inboxRequests(api.requests).length;
  s.open[0].close(1006);
  [...s.jobs.values()].forEach((job) => job());
  s.send("session_list_update", { sessions: [] });
  await tick();
  assert.ok(inboxRequests(api.requests).length > before);
  assert.deepEqual(ids(feed).open, ["a"]);
  feed.stop();
});

test("Refresh reads the first pages once, even as the connection comes back", async () => {
  const s = sockets();
  const api = server({ "open::": [itemWire("a")] });
  const feed = new InboxFeed(connection, api.client, s);
  feed.start();
  s.send("session_list_update", { sessions: [] });
  await tick();
  const before = inboxRequests(api.requests).length;
  feed.retry();
  s.send("session_list_update", { sessions: [] });
  await tick();
  assert.equal(inboxRequests(api.requests).length - before, 1, "one Open page");
  feed.stop();
});

test("an item opened from the menu bar loads even when paging hasn't reached it", async () => {
  const s = sockets();
  const api = server({
    "open::": [itemWire("c", { updated_at: at(3) })],
    "open:::more": ["3|c"],
    extra: [itemWire("old", { updated_at: at(0) })],
  });
  const feed = new InboxFeed(connection, api.client, s);
  feed.start();
  await tick();
  assert.equal(await feed.fetchItem("old"), "found");
  assert.deepEqual(ids(feed).open, ["c", "old"]);
  assert.equal(await feed.fetchItem("missing"), "deleted");
  feed.stop();
});

function policy() {
  const jobs = new Map<number, () => void>();
  let id = 0;
  const scheduler: Scheduler = {
    set: (callback) => (jobs.set(++id, callback), id),
    clear: (job) => void jobs.delete(job as number),
  };
  const marked: string[] = [];
  const read = new Set<string>();
  const reads = new ReadPolicy(
    async (item) => {
      marked.push(item);
      read.add(item);
    },
    (item) => !read.has(item),
    scheduler,
  );
  const elapse = () => {
    const pending = [...jobs.values()];
    jobs.clear();
    pending.forEach((job) => job());
  };
  return { reads, marked, read, elapse, jobs };
}

test("Raycast's own selections never mark an item read", () => {
  const { reads, marked, elapse } = policy();
  reads.visible(["a", "b"]);
  reads.select("a");
  elapse();
  // `a` was deleted; Raycast selects the next row.
  reads.visible(["b"]);
  reads.select("b");
  elapse();
  // A search empties and refills the list, then Raycast selects its first row.
  reads.reset();
  reads.visible([]);
  reads.visible(["c", "b"]);
  reads.select("c");
  elapse();
  assert.deepEqual(marked, []);
});

test("a move the user made marks the item after the dwell, once", () => {
  const { reads, marked, elapse, jobs } = policy();
  reads.visible(["a"]);
  reads.select("a");
  // Resolved loads after the first selection.
  reads.visible(["a", "b", "c"]);
  reads.select("b");
  assert.equal(jobs.size, 1);
  reads.select("c");
  assert.equal(jobs.size, 1, "moving on cancels the earlier dwell");
  elapse();
  assert.deepEqual(marked, ["c"]);
  reads.select("b");
  reads.select("c");
  elapse();
  assert.deepEqual(marked, ["c"], "an item is marked once");
  reads.acted("a");
  assert.deepEqual(marked, ["c", "a"]);
  // Moving to a row that isn't an item, such as the connection status, ends the dwell.
  reads.select("b");
  reads.select(undefined);
  elapse();
  assert.deepEqual(marked, ["c", "a"]);
});

test("a selection the view makes doesn't count, even when Raycast skips its event", () => {
  const { reads, marked, elapse } = policy();
  reads.visible(["a", "b", "c"]);
  reads.select("a");
  reads.expect("c");
  reads.select("c");
  elapse();
  assert.deepEqual(marked, []);
  // Already selected: no event follows, and the next move still counts.
  reads.expect("c");
  reads.select("b");
  elapse();
  assert.deepEqual(marked, ["b"]);
});
