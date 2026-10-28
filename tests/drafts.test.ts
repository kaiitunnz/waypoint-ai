import assert from "node:assert/strict";
import { test } from "node:test";
import { DraftStore } from "../src/storage/drafts";

test("draft writes coalesce to the latest value with one write in flight", async () => {
  const stored: string[] = [];
  let release!: () => void;
  let gate: Promise<void> | undefined = new Promise<void>((resolve) => (release = resolve));
  const drafts = new DraftStore({
    keys: async () => ["k"],
    entries: async () => [],
    removeItem: async () => undefined,
    getItem: async () => stored.at(-1),
    setItem: async (_key, value) => {
      await gate;
      stored.push(value);
    },
  });
  const writes = ["a", "ab", "abc", "abcd"].map((value) => drafts.write("k", value));
  assert.equal(await drafts.read("k"), "abcd", "reads see the queued value");
  gate = undefined;
  release();
  await Promise.all(writes);
  assert.deepEqual(stored, ["a", "abcd"]);
  assert.equal(await drafts.read("k"), "abcd");
});

test("a failed draft write rejects its callers and the next write retries with the latest value", async () => {
  const stored = new Map<string, string>();
  let fail = true;
  const drafts = new DraftStore({
    keys: async () => [...stored.keys()],
    entries: async () => [...stored],
    removeItem: async (key) => void stored.delete(key),
    getItem: async (key) => stored.get(key),
    setItem: async (key, value) => {
      if (fail) throw new Error("Storage unavailable");
      stored.set(key, value);
    },
  });
  await assert.rejects(drafts.write("k", "kept"), /unavailable/);
  assert.equal(await drafts.read("k"), "kept", "the unsaved value is still the draft");
  fail = false;
  await drafts.write("k", "kept!");
  assert.equal(stored.get("k"), "kept!");
});

test("removing a draft drops a queued value and waits for the write in flight", async () => {
  const stored = new Map<string, string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const drafts = new DraftStore({
    keys: async () => [...stored.keys()],
    entries: async () => [...stored],
    removeItem: async (key) => void stored.delete(key),
    getItem: async (key) => stored.get(key),
    setItem: async (key, value) => {
      await gate;
      stored.set(key, value);
    },
  });
  void drafts.write("k", "first");
  void drafts.write("k", "second");
  const removed = drafts.remove("k");
  release();
  await removed;
  assert.equal(stored.has("k"), false);
  assert.equal(await drafts.read("k"), undefined);
});
