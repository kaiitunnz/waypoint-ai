import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClipboardFiles } from "../src/storage/clipboardFiles";
import { ServerMutex } from "../src/storage/mutex";
import { QuickChatStore } from "../src/storage/quickChat";

const hour = 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 29, 12);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clipboard-files-"));
  const root = join(directory, "clipboard-attachments");
  const values = new Map<string, string>();
  const storage = { failEntries: false, scans: 0 };
  const store = new QuickChatStore(
    {
      getItem: async (key) => values.get(key),
      setItem: async (key, value) => void values.set(key, value),
      removeItem: async (key) => void values.delete(key),
      keys: async () => [...values.keys()],
      entries: async () => {
        storage.scans++;
        if (storage.failEntries) throw new Error("Storage unavailable");
        return [...values];
      },
    },
    new ServerMutex(join(directory, "locks")),
  );
  let clock = now;
  const files = new ClipboardFiles(root, store, () => clock);
  // An owned image written `age` ago.
  const image = async (age: number, content = "png") => {
    const { id, path } = await files.create(new Date(clock));
    if (content) await writeFile(path, content);
    const time = new Date(clock - age);
    await utimes(join(root, id), time, time);
    return { id, path };
  };
  const present = async () => (await readdir(root)).filter((name) => name !== ".swept").sort();
  return {
    directory,
    root,
    store,
    clock: () => clock,
    values,
    storage,
    files,
    image,
    present,
    advance: (ms: number) => (clock += ms),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("owned paths are exactly a UUID directory under the root and one file in it", async () => {
  const f = await fixture();
  const { id, path } = await f.files.create(new Date(now));
  assert.equal(f.files.ownedId(path), id);
  assert.equal(f.files.ownedId(join(f.root, id)), undefined);
  assert.equal(f.files.ownedId(join(f.root, "not-a-uuid", "x.png")), undefined);
  assert.equal(f.files.ownedId(join(f.root, id, "..", "..", "elsewhere.png")), undefined);
  assert.equal(f.files.ownedId(join(f.directory, "picked.png")), undefined);
  await f.close();
});

test("release deletes owned files no saved state mentions, keeps mentioned ones, and ignores other paths", async () => {
  const f = await fixture();
  const dropped = await f.image(0);
  const kept = await f.image(0);
  const picked = join(f.directory, "picked.png");
  await writeFile(picked, "png");
  f.values.set("waypoint.draft.server-b.compose.quick", `text naming ${kept.id}`);
  await f.files.release([dropped.path, kept.path, picked]);
  assert.deepEqual(await f.present(), [kept.id]);
  assert.equal((await stat(picked)).isFile(), true);
  const scans = f.storage.scans;
  await f.files.release([picked]);
  assert.equal(f.storage.scans, scans, "no owned path, no storage read");
  await f.close();
});

test("the collector deletes old unreferenced and partial directories and keeps referenced and young ones", async () => {
  const f = await fixture();
  const old = await f.image(2 * hour);
  const partial = await f.image(2 * hour, "");
  const referenced = await f.image(2 * hour);
  const young = await f.image(10 * 60 * 1000);
  await writeFile(join(f.root, "stray.txt"), "not ours");
  await mkdir(join(f.root, "folder"));
  const outside = join(f.directory, "outside");
  await mkdir(outside);
  // A damaged state still protects what it mentions.
  f.values.set("waypoint.quick-chat.server-a", `{"broken": "${referenced.path}"`);
  f.values.set("waypoint.quick-chat.server-b", JSON.stringify({ version: 1, compose: {} }));
  await f.files.sweep();
  assert.deepEqual(await f.present(), [referenced.id, young.id, "folder", "stray.txt"].sort());
  assert.equal((await stat(outside)).isDirectory(), true);
  assert.ok(old && partial);
  await f.close();
});

test("the collector deletes nothing when storage can't be read", async () => {
  const f = await fixture();
  const old = await f.image(2 * hour);
  f.storage.failEntries = true;
  await f.files.sweep();
  assert.deepEqual(await f.present(), [old.id]);
  await f.files.release([old.path]);
  assert.deepEqual(await f.present(), [old.id]);
  await f.close();
});

test("the collector reads storage only when something is past the grace period, at most every ten minutes", async () => {
  const f = await fixture();
  await f.image(10 * 60 * 1000);
  await f.files.sweep();
  assert.equal(f.storage.scans, 0);
  const old = await f.image(2 * hour);
  await f.files.sweep();
  assert.deepEqual(await f.present().then((names) => names.includes(old.id)), true, "throttled");
  f.advance(11 * 60 * 1000);
  const another = new ClipboardFiles(f.root, f.store, () => f.clock() - 5 * 60 * 1000);
  await another.sweep();
  assert.equal(f.storage.scans, 0, "the marker throttles every process");
  await f.files.sweep();
  assert.equal(f.storage.scans, 1);
  assert.equal((await f.present()).includes(old.id), false);
  await f.close();
});

test("images named by a removed server's state are collected once that state is gone", async () => {
  const f = await fixture();
  const image = await f.image(2 * hour);
  f.values.set("waypoint.quick-chat.gone", JSON.stringify({ compose: { quick: { files: [{ path: image.path }] } } }));
  await f.files.sweep();
  assert.deepEqual(await f.present(), [image.id], "still named by saved state");
  f.values.delete("waypoint.quick-chat.gone");
  f.advance(11 * 60 * 1000);
  await f.files.sweep();
  assert.deepEqual(await f.present(), []);
  await f.close();
});
