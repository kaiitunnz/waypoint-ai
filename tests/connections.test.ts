import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUrl, decodeState } from "../src/domain/connections";
import { ConnectionStore, connectionsKey, StorageAdapter } from "../src/storage/connections";

function fixture() {
  const values = new Map<string, string>();
  const adapter: StorageAdapter = {
    getItem: async (key) => values.get(key),
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
  let sequence = 0;
  return { values, store: new ConnectionStore(adapter, () => `server-${++sequence}`), adapter };
}

test("normalizes URLs while rejecting credentials and unsafe destinations", () => {
  assert.equal(normalizeUrl(" HTTPS://Example.COM:443/proxy/// "), "https://example.com/proxy");
  assert.equal(normalizeUrl("http://[::1]:8000/"), "http://[::1]:8000");
  for (const url of [
    "example.com",
    "file:///etc/passwd",
    "ftp://example.com",
    "https://u:p@example.com",
    "https://example.com?token=private",
    "https://example.com/#private",
  ])
    assert.throws(() => normalizeUrl(url));
});

test("versioned storage repairs dangling defaults and rejects unknown or corrupt state", () => {
  assert.deepEqual(decodeState(undefined), { version: 1, connections: [] });
  const data = {
    version: 1,
    connections: [{ id: "a", name: "A", apiUrl: "http://localhost:8000" }],
    defaultId: "deleted",
    activeId: "deleted",
  };
  assert.equal(decodeState(JSON.stringify(data)).activeId, "a");
  for (const raw of [
    "invalid",
    "null",
    JSON.stringify({ ...data, version: 2 }),
    JSON.stringify({ ...data, connections: [...data.connections, ...data.connections] }),
  ])
    assert.throws(() => decodeState(raw), /could not be read/);
});

test("two servers isolate credentials, active/default choices, and reauthentication", async () => {
  const { store, adapter } = fixture();
  const a = await store.save({ name: "Local", apiUrl: "http://localhost:8000" });
  const b = await store.save({ name: "Remote", apiUrl: "https://example.com" });
  await store.authenticate(a.id, a.apiUrl, "token-a");
  await store.authenticate(b.id, b.apiUrl, "token-b");
  await store.select(b.id);
  await store.authenticate(a.id, a.apiUrl, "replacement-a");
  const restored = await new ConnectionStore(adapter).read();
  assert.equal(restored.defaultId, a.id);
  assert.equal(restored.activeId, b.id);
  assert.deepEqual(
    restored.connections.map((item) => item.token),
    ["replacement-a", "token-b"],
  );
  const renamed = await store.save({ name: "Renamed", apiUrl: a.apiUrl, frontendUrl: "https://ui.example.com" }, a.id);
  assert.equal(renamed.id, a.id);
  assert.equal(renamed.token, "replacement-a");
  await store.select(b.id, true);
  assert.equal((await store.read()).defaultId, b.id);
});

test("changing API URL replaces the identity and rejects a late authentication", async () => {
  const { store } = fixture();
  const a = await store.save({ name: "A", apiUrl: "http://localhost:8000" });
  await store.authenticate(a.id, a.apiUrl, "old-token");
  const changed = await store.save({ name: "A", apiUrl: "http://localhost:9000" }, a.id);
  assert.notEqual(changed.id, a.id);
  assert.equal(changed.token, undefined);
  await assert.rejects(store.authenticate(a.id, a.apiUrl, "late-token"), /changed or was removed/);
  const state = await store.read();
  assert.equal(state.activeId, changed.id);
  assert.equal(state.defaultId, changed.id);
  assert.equal(state.connections.length, 1);
});

test("removal clears credentials, repairs selection, and disallows stale edits", async () => {
  const { store, values } = fixture();
  const a = await store.save({ name: "A", apiUrl: "http://localhost:8000" });
  const b = await store.save({ name: "B", apiUrl: "http://localhost:9000" });
  await store.authenticate(a.id, a.apiUrl, "disposable-token");
  await store.remove(a.id);
  assert.equal((await store.read()).activeId, b.id);
  assert.ok(!values.get(connectionsKey)?.includes("disposable-token"));
  await assert.rejects(store.save({ name: "Late edit", apiUrl: a.apiUrl }, a.id), /removed/);
  await store.remove(b.id);
  assert.equal((await store.read()).activeId, undefined);
});

test("serializes overlapping mutations and recovers after failed writes", async () => {
  const { store } = fixture();
  const [a, b] = await Promise.all([
    store.save({ name: "A", apiUrl: "http://localhost:8000" }),
    store.save({ name: "B", apiUrl: "http://localhost:9000" }),
  ]);
  await Promise.all([store.authenticate(a.id, a.apiUrl, "a"), store.authenticate(b.id, b.apiUrl, "b")]);
  assert.equal((await store.read()).connections.length, 2);
  await assert.rejects(store.save({ name: "Duplicate", apiUrl: "http://LOCALHOST:8000/" }), /already saved/);
  await store.select(b.id);
  assert.equal((await store.read()).activeId, b.id);
});

test("storage errors preserve the old data and can be retried", async () => {
  const { store, values, adapter } = fixture();
  await store.save({ name: "A", apiUrl: "http://localhost:8000" });
  const before = values.get(connectionsKey);
  let fail = true;
  const flaky = new ConnectionStore({
    ...adapter,
    setItem: async (key, value) => {
      if (fail) throw new Error("disk unavailable");
      await adapter.setItem(key, value);
    },
  });
  await assert.rejects(flaky.save({ name: "B", apiUrl: "http://localhost:9000" }), /disk unavailable/);
  assert.equal(values.get(connectionsKey), before);
  fail = false;
  await flaky.save({ name: "B", apiUrl: "http://localhost:9000" });
  values.set(connectionsKey, '{"version":2}');
  await assert.rejects(flaky.remove("a"), /could not be read/);
  assert.equal(values.get(connectionsKey), '{"version":2}');
});
