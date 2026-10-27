import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { link, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockLostError, ServerMutex } from "../src/storage/mutex";
import { QuickChatStore, decodeQuickChat } from "../src/storage/quickChat";

test("a live-pid lock with a stale heartbeat is reclaimed and its fenced holder can no longer write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutex-lease-"));
  let now = 1_000_000;
  const values = new Map<string, string>();
  const storage = {
    keys: async () => [...values.keys()],
    removeItem: async (key: string) => void values.delete(key),
    getItem: async (key: string) => values.get(key),
    setItem: async (key: string, value: string) => void values.set(key, value),
  };
  const clock = () => now;
  // Separate queues model two commands; a long heartbeat interval stands in for a holder whose work stopped.
  const stalled = new QuickChatStore(
    storage,
    new ServerMutex(directory, 80, { heartbeatMs: 3_600_000, now: clock, queues: new Map() }),
  );
  const other = new QuickChatStore(storage, new ServerMutex(directory, 80, { now: clock, queues: new Map() }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const holder = stalled.transaction("server-a", async (state, persist) => {
    await gate;
    state.drafts.quick = "late write";
    await persist();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const write = (text: string) =>
    other.transaction("server-a", async (state, persist) => {
      state.drafts.quick = text;
      await persist();
    });
  await assert.rejects(write("blocked"), /still active/, "a fresh heartbeat keeps the lock");
  now += 31_000;
  await write("reclaimed");
  release();
  await assert.rejects(holder, LockLostError);
  assert.equal(decodeQuickChat(values.get("waypoint.quick-chat.server-a")).drafts.quick, "reclaimed");
  await rm(directory, { recursive: true, force: true });
});

test("locks without a heartbeat keep the dead-pid rule", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutex-legacy-"));
  const lock = join(directory, createHash("sha256").update("server-a").digest("hex"));
  await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: "legacy" }));
  await assert.rejects(
    new ServerMutex(directory, 80, { now: () => Date.now() + 1e9 }).run("server-a", async () => 1),
    /still active/,
  );
  await rm(directory, { recursive: true, force: true });
});

test("reclaiming a stopped holder removes its lock, heartbeat and owner slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutex-stopped-"));
  const lock = join(directory, createHash("sha256").update("server-a").digest("hex"));
  const record = JSON.stringify({ pid: process.pid, nonce: "stopped" });
  await writeFile(`${lock}.${process.pid}.slot`, record);
  await link(`${lock}.${process.pid}.slot`, lock);
  await writeFile(`${lock}.stopped.heartbeat`, "1000");
  assert.equal(await new ServerMutex(directory, 80, { now: () => 40_000 }).run("server-a", async () => 1), 1);
  assert.deepEqual(await readdir(directory), []);
  await rm(directory, { recursive: true, force: true });
});

test("waiting attempts heartbeat before linking, so a stopped reclaimer's claim goes stale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutex-waiter-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const holding = new ServerMutex(directory, 80, { queues: new Map() }).run("server-a", () => gate);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const waiting = new ServerMutex(directory, 400, { queues: new Map() }).run("server-a", async () => 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await readdir(directory)).filter((name) => name.endsWith(".heartbeat")).length, 2);
  release();
  await holding;
  assert.equal(await waiting, 1);

  const lock = join(directory, createHash("sha256").update("server-a").digest("hex"));
  await writeFile(`${lock}.${process.pid}.held`, JSON.stringify({ pid: process.pid, nonce: "held" }));
  await link(`${lock}.${process.pid}.held`, lock);
  await writeFile(`${lock}.held.heartbeat`, "1000");
  await writeFile(`${lock}.reclaim.held`, JSON.stringify({ pid: process.pid, nonce: "claimer" }));
  await writeFile(`${lock}.claimer.heartbeat`, "1000");
  assert.equal(await new ServerMutex(directory, 80, { now: () => 40_000 }).run("server-a", async () => 2), 2);
  await rm(directory, { recursive: true, force: true });
});

test("released locks leave no heartbeat files, even when a beat is still writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutex-beats-"));
  const mutex = new ServerMutex(directory, 2500, { heartbeatMs: 1, queues: new Map() });
  for (let run = 0; run < 60; run++)
    await mutex.run("server-a", () => new Promise((resolve) => setTimeout(resolve, 15)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await readdir(directory), []);
  await rm(directory, { recursive: true, force: true });
});

test("slow heartbeats run in order and none outlives the release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutex-slow-beats-"));
  const mutex = new ServerMutex(directory, 2500, { heartbeatMs: 1, queues: new Map() });
  const beats = mutex as unknown as { beat(path: string, nonce: string): Promise<unknown> };
  const beat = beats.beat.bind(mutex);
  let calls = 0;
  beats.beat = async (path, nonce) => {
    if (calls++ % 2) await new Promise((resolve) => setTimeout(resolve, 8));
    return beat(path, nonce);
  };
  for (let run = 0; run < 20; run++)
    await mutex.run("server-a", () => new Promise((resolve) => setTimeout(resolve, 15)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await readdir(directory), []);
  await rm(directory, { recursive: true, force: true });
});
