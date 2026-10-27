import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetadata } from "../src/api/contracts";
import { isLoopback } from "../src/domain/connections";
import {
  createRequest,
  initialDefaults,
  launchContext,
  launchFingerprint,
  quickChatTitle,
} from "../src/domain/quickChat";
import { localWorkspace } from "../src/storage/workspace";
import { metadataWire } from "./fixtures/conversation";

const metadata = parseMetadata({
  ...metadataWire,
  default_cwd: "~/",
  launch_targets: [{ id: "lab", name: "Lab", supported_backends: ["test-agent"], default_cwd: "/home/lab" }],
});

test("titles name the creation minute in local time", () => {
  assert.equal(quickChatTitle(new Date(2026, 9, 7, 9, 5, 59)), "Quick Chat 2026-10-07 09:05");
  const request = createRequest(initialDefaults(), metadata, "i", "o", { createdAt: new Date(2026, 0, 1, 23, 0) });
  assert.equal(request.title, "Quick Chat 2026-01-01 23:00");
});

test("the launch fingerprint ignores the title and tags", () => {
  const first = createRequest(initialDefaults(), metadata, "i", "a", { createdAt: new Date(2026, 0, 1, 8, 0) });
  const second = createRequest(initialDefaults(), metadata, "i", "b", { createdAt: new Date(2026, 5, 1, 9, 30) });
  assert.equal(launchFingerprint(first), launchFingerprint(second));
  const moved = createRequest({ ...initialDefaults(), cwd: "/elsewhere" }, metadata, "i", "a");
  assert.notEqual(launchFingerprint(first), launchFingerprint(moved));
});

test("the workspace applies to the Local target only when no directory is chosen", () => {
  const workspace = "/Users/me/.waypoint-ai/workspace";
  assert.equal(launchContext(initialDefaults(), metadata, workspace).cwd, workspace);
  assert.equal(launchContext(initialDefaults(), metadata).cwd, "~/");
  assert.equal(launchContext({ ...initialDefaults(), cwd: "/project" }, metadata, workspace).cwd, "/project");
  assert.equal(launchContext({ ...initialDefaults(), target: "lab" }, metadata, workspace).cwd, "/home/lab");
  assert.equal(createRequest(initialDefaults(), metadata, "i", "o", { workspace }).cwd, workspace);
});

test("only loopback API URLs are treated as this Mac", () => {
  for (const url of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787", "http://127.1.2.3"])
    assert.equal(isLoopback(url), true, url);
  for (const url of ["https://waypoint.example.com", "http://192.168.1.4:8787", "http://127.0.0.1.example.com"])
    assert.equal(isLoopback(url), false, url);
});

test("the workspace is created once and keeps edited guidance files", async () => {
  const home = await mkdtemp(join(tmpdir(), "quick-chat-home-"));
  try {
    assert.equal(localWorkspace("https://waypoint.example.com", home), undefined);
    const workspace = localWorkspace("http://127.0.0.1:8787", home)!;
    assert.equal(workspace.dir, join(home, ".waypoint-ai", "workspace"));
    await workspace.ensure();
    assert.match(await readFile(join(workspace.dir, "AGENTS.md"), "utf8"), /Quick Chat workspace/);
    assert.equal(await readFile(join(workspace.dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    await writeFile(join(workspace.dir, "AGENTS.md"), "My own notes\n");
    await workspace.ensure();
    assert.equal(await readFile(join(workspace.dir, "AGENTS.md"), "utf8"), "My own notes\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
