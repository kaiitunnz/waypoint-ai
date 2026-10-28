import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionsKey } from "../src/storage/connections";
import { DraftStore } from "../src/storage/drafts";
import { ServerMutex } from "../src/storage/mutex";
import { QuickChatStore } from "../src/storage/quickChat";

const saved = (...ids: string[]) =>
  JSON.stringify({
    version: 1,
    connections: ids.map((id, index) => ({ id, name: id, apiUrl: `http://127.0.0.1:${8000 + index}` })),
  });

async function fixture(values: Map<string, string>, getItem?: (key: string) => string | undefined) {
  const directory = await mkdtemp(join(tmpdir(), "server-data-tests-"));
  const store = new QuickChatStore(
    {
      getItem: async (key) => (getItem ? getItem(key) : values.get(key)),
      setItem: async (key, value) => void values.set(key, value),
      keys: async () => [...values.keys()],
      removeItem: async (key) => void values.delete(key),
    },
    new ServerMutex(directory),
  );
  return { store, close: () => rm(directory, { recursive: true, force: true }) };
}

test("removed servers lose their Quick Chat state and drafts, even when damaged", async () => {
  const values = new Map([
    [connectionsKey, saved("kept")],
    ["waypoint.quick-chat.kept", "{}"],
    ["waypoint.draft.kept.line.quick", "hello"],
    ["waypoint.quick-chat.gone", "{not json"],
    ["waypoint.draft.gone.line.quick", "old"],
    ["waypoint.draft.gone.compose.new", "old"],
    ["waypoint.draft.gone.interactions.s1", "{}"],
    ["unrelated", "x"],
  ]);
  const f = await fixture(values);
  try {
    await f.store.sweep();
    assert.deepEqual(
      [...values.keys()].sort(),
      [connectionsKey, "unrelated", "waypoint.draft.kept.line.quick", "waypoint.quick-chat.kept"].sort(),
    );
    await f.store.sweep();
    assert.equal(values.size, 4);
  } finally {
    await f.close();
  }
});

test("nothing is removed unless the saved servers can be read", async () => {
  const values = new Map([["waypoint.quick-chat.a", "{}"]]);
  const f = await fixture(values);
  try {
    await f.store.sweep();
    assert.ok(values.has("waypoint.quick-chat.a"));
    values.set(connectionsKey, "{broken");
    await assert.rejects(f.store.sweep());
    assert.ok(values.has("waypoint.quick-chat.a"));
  } finally {
    await f.close();
  }
});

test("a server saved while sweeping keeps its data", async () => {
  const values = new Map([
    [connectionsKey, saved()],
    ["waypoint.quick-chat.new", "{}"],
  ]);
  let reads = 0;
  const f = await fixture(values, (key) => {
    if (key === connectionsKey && ++reads === 2) values.set(connectionsKey, saved("new"));
    return values.get(key);
  });
  try {
    await f.store.sweep();
    assert.ok(values.has("waypoint.quick-chat.new"));
  } finally {
    await f.close();
  }
});

test("forgetting drafts drops queued writes and waits for one in flight", async () => {
  const values = new Map<string, string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const drafts = new DraftStore({
    keys: async () => [...values.keys()],
    removeItem: async (key) => void values.delete(key),
    getItem: async (key) => values.get(key),
    setItem: async (key, value) => {
      await gate;
      values.set(key, value);
    },
  });
  void drafts.write("waypoint.draft.gone.line.quick", "first");
  void drafts.write("waypoint.draft.gone.line.quick", "second");
  let forgotten = false;
  const forget = drafts.forget("waypoint.draft.gone.").then(() => (forgotten = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forgotten, false);
  release();
  await forget;
  assert.equal(values.get("waypoint.draft.gone.line.quick"), "first");
});
