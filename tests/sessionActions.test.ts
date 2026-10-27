import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMetadata } from "../src/api/contracts";
import { parseSession } from "../src/api/sessions";
import { SessionActionSet, deleteMessage, sessionActions, titleProblem } from "../src/domain/sessionActions";
import { metadataWire, sessionWire } from "./fixtures/conversation";

const metadata = (reattach: boolean) =>
  parseMetadata({
    ...metadataWire,
    backends: metadataWire.backends.map((backend) => ({
      ...backend,
      transport_capabilities: { ...backend.transport_capabilities, supports_reattach_after_exit: reattach },
    })),
  });
const session = (patch: Record<string, unknown> = {}) => parseSession({ ...sessionWire("s"), ...patch });
const offered = (actions: SessionActionSet) =>
  Object.entries(actions)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .sort();
const idle = { pending: false };

test("session actions follow status, interface, reattach support, and source", () => {
  const caps = metadata(true);
  assert.deepEqual(offered(sessionActions(session({ status: "running" }), caps, idle)), [
    "interrupt",
    "pin",
    "rename",
    "terminate",
    "useForQuickChat",
  ]);
  assert.deepEqual(offered(sessionActions(session({ status: "idle" }), caps, idle)), [
    "pin",
    "rename",
    "terminate",
    "useForQuickChat",
  ]);
  for (const status of ["starting", "waiting_input"])
    assert.equal(sessionActions(session({ status }), caps, idle).interrupt, true);
  assert.deepEqual(offered(sessionActions(session({ status: "exited" }), caps, idle)), [
    "delete",
    "pin",
    "reattach",
    "rename",
    "useForQuickChat",
  ]);
  const error = sessionActions(session({ status: "error" }), caps, idle);
  assert.ok(error.delete && error.terminate && error.reattach);
  const noReattach = sessionActions(session({ status: "exited" }), metadata(false), idle);
  assert.ok(!noReattach.reattach && !noReattach.useForQuickChat && noReattach.delete);
  assert.equal(sessionActions(session({ pinned_at: "2026-10-26T00:00:00Z" }), caps, idle).unpin, true);
  assert.equal(sessionActions(session({ pinned_at: "2026-10-26T00:00:00Z" }), caps, idle).pin, false);
});

test("terminal sessions are never interrupted or used for Quick Chat, and protected ones get no actions", () => {
  const caps = metadata(true);
  const terminal = sessionActions(
    session({ backend: "terminal", transport: "test-terminal", source: "attached_tmux" }),
    caps,
    idle,
  );
  assert.deepEqual(offered(terminal), ["pin", "rename", "terminate"]);
  for (const source of ["assistant", "telemetry"])
    assert.deepEqual(offered(sessionActions(session({ source }), caps, idle)), []);
  assert.equal(sessionActions(session(), undefined, idle).interrupt, false);
});

test("Quick Chat's destination offers Open in Quick Chat, and a pending operation blocks choosing", () => {
  const caps = metadata(true);
  const current = sessionActions(session(), caps, { pointer: "s", pending: false });
  assert.ok(current.openInQuickChat && !current.useForQuickChat);
  const other = sessionActions(session(), caps, { pointer: "other", pending: false });
  assert.ok(other.useForQuickChat && !other.openInQuickChat);
  assert.equal(sessionActions(session(), caps, { pointer: "other", pending: true }).useForQuickChat, false);
  assert.equal(sessionActions(session(), caps, { pointer: "s", pending: true }).openInQuickChat, true);
});

test("titles and delete confirmations", () => {
  assert.equal(titleProblem("  "), "Enter a title.");
  assert.equal(titleProblem("x".repeat(501)), "Use 500 characters or fewer.");
  assert.equal(titleProblem(` ${"x".repeat(500)} `), undefined);
  assert.equal(deleteMessage(session()), "Removes its transcript and attachments. This can't be undone.");
  assert.match(deleteMessage(session(), true), /^Stops it and removes/);
  const worktree = deleteMessage(session({ worktree_path: "/repo/.worktrees/s" }));
  assert.match(worktree, /worktree at \/repo\/\.worktrees\/s/);
  assert.match(worktree, /uncommitted changes/);
});
