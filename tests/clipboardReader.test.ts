import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipboardReader, pasteboardScript } from "../src/hooks/clipboardReader";
import { maxContextBytes } from "../src/domain/compose";

function sources(native: string | Error, raycast: { text: string; file?: string }, spillStore = "/nowhere") {
  const calls: { script: string; args: string[] }[] = [];
  return {
    calls,
    spillStore,
    runScript: async (script: string, args: string[]) => {
      calls.push({ script, args });
      if (native instanceof Error) throw native;
      return native;
    },
    readRaycast: async () => raycast,
  };
}

test("the native read reports every copied file and passes the image path as an argument", async () => {
  const fake = sources(JSON.stringify({ files: ["/a b/one.txt", "/two.png"], image: "none" }), {
    text: "one.txt",
    file: "/a b/one.txt",
  });
  const reading = await clipboardReader(fake).read("/root/id/Clipboard image.png");
  assert.deepEqual(reading, { files: ["/a b/one.txt", "/two.png"], image: "none", text: "one.txt" });
  assert.deepEqual(fake.calls, [{ script: pasteboardScript, args: ["/root/id/Clipboard image.png"] }]);
  await clipboardReader(fake).read();
  assert.deepEqual(fake.calls[1].args, [], "no path, so the image is only reported");
});

test("a failed native read falls back to Raycast's file, then its text, and says it failed", async () => {
  assert.deepEqual(await clipboardReader(sources(new Error("timeout"), { text: "a.pdf", file: "/a.pdf" })).read("/p"), {
    files: ["/a.pdf"],
    image: "none",
    text: "a.pdf",
    failed: true,
  });
  assert.deepEqual(await clipboardReader(sources("not json", { text: "" })).read("/p"), {
    files: [],
    image: "none",
    text: "",
    failed: true,
  });
  assert.deepEqual(
    await clipboardReader(sources(JSON.stringify({ files: [], image: "present", failed: true }), { text: "" })).read(
      "/p",
    ),
    { files: [], image: "present", text: "", failed: true },
    "an image the script couldn't save",
  );
});

test("Raycast's spilled text is read as text and never becomes a copied file", async () => {
  const store = await mkdtemp(join(tmpdir(), "clipboard-store-"));
  const file = join(store, "long.txt");
  await writeFile(file, "x".repeat(maxContextBytes + 10));
  const native = JSON.stringify({ files: [file], image: "none" });
  const reading = await clipboardReader(sources(native, { text: "long.txt", file }, store)).read();
  assert.equal(reading.text.length, maxContextBytes + 1);
  assert.equal(reading.spilled, file);
  const fallback = await clipboardReader(sources(new Error("x"), { text: "long.txt", file }, store)).read();
  assert.deepEqual(fallback.files, []);
  await rm(store, { recursive: true, force: true });
});
