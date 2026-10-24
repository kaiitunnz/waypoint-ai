import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEvent, parseEventsPage, parseSession } from "../src/api/sessions";
import { parseMetadata } from "../src/api/contracts";
import { mergeEvents, transcript, selectedRow, newerQuestions } from "../src/domain/transcript";
import { visibleSessions, isStructured, sessionUrl } from "../src/domain/sessions";
import { recording, eventWire, sessionWire, metadataWire } from "./fixtures/conversation";

const parse = (value: unknown) => parseEvent(value, "demo");

test("recorded deltas and tool completion aggregate once in chronological order", () => {
  const events = recording.map(parse);
  const reordered = [...events].reverse();
  const merged = mergeEvents(events.slice(4), [...reordered, ...events], "demo");
  assert.equal(merged.length, events.length);
  const rows = transcript(merged);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(rows[1].text, "I will inspect the plan first.");
  assert.equal(rows[2].text, "Read garden.md\n\nSeedlings");
  assert.equal(rows[3].text, "The garden plan looks healthy.");
});

test("missing numeric IDs do not discard events; wrong-session events never merge", () => {
  const a = parse({ ...eventWire(1), id: undefined });
  const b = parse({ ...eventWire(2), id: undefined });
  const other = parseEvent(eventWire(3, "agent_output", "other", "reply", "other"), "other");
  assert.equal(mergeEvents([a], [b, a, other], "demo").length, 2);
  assert.throws(() => parse(eventWire(3, "agent_output", "other", "reply", "other")));
});

test("interleaved tool call/results pair across history pages without moving selection", () => {
  const recent = recording.slice(4).map(parse);
  const before = transcript(mergeEvents([], recent, "demo"));
  const older = transcript(mergeEvents(recent, recording.slice(0, 4).map(parse), "demo"));
  assert.equal(before[0].id, "tool:read");
  assert.equal(selectedRow(older, before[0].id, false), "tool:read");
  assert.equal(older.find((row) => row.id === "tool:read")?.text, "Read garden.md\n\nSeedlings");
});

test("reasoning, quiet notes, and approvals stay distinct; raw terminal chunks stay hidden", () => {
  const rows = transcript([
    parse({ ...eventWire(1), metadata: { item_id: "reason", item_kind: "reasoning" } }),
    parse(eventWire(2, "approval_request", "Permission to read a file?", "")),
    parse(eventWire(3, "system_note", "Completed", "")),
    parse(eventWire(4, "raw_terminal_chunk", "terminal-private", "")),
  ]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["reasoning", "approval", "note"],
  );
});

test("following selects latest assistant while paused selection survives prepending", () => {
  const rows = transcript(recording.map(parse));
  assert.equal(selectedRow(rows, "sequence:1", true), "assistant:final");
  assert.equal(selectedRow(rows, "sequence:1", false), "sequence:1");
  assert.equal(selectedRow([], undefined, true), undefined);
});

test("session search covers metadata and separates pinned/recent/exited", () => {
  const current = parseSession(sessionWire());
  const exited = { ...current, id: "exited", status: "exited", pinnedAt: "2026-10-23" };
  const pinned = { ...current, id: "pinned", pinnedAt: "2026-10-24" };
  const protectedSession = { ...current, id: "assistant", source: "assistant" };
  assert.deepEqual(
    visibleSessions([current, exited, protectedSession, pinned], "", "active").map((session) => session.id),
    ["pinned", "demo"],
  );
  assert.deepEqual(
    visibleSessions([current, exited], "seedlings garden", "exited").map((session) => session.id),
    ["exited"],
  );
  assert.equal(visibleSessions([current], "test agent running", "all", parseMetadata(metadataWire)).length, 1);
  for (const field of ["/workspace", "garden", "test-agent", "active"])
    assert.equal(visibleSessions([current], field, "active").length, 1);
  assert.ok(!JSON.stringify(current).includes("secret-argument"));
  assert.ok(!JSON.stringify(current).includes("private-not-for-ui"));
});

test("transport capabilities, rather than agent defaults, gate native conversations", () => {
  const metadata = parseMetadata(metadataWire);
  const session = parseSession(sessionWire());
  assert.equal(isStructured(session, metadata), true);
  assert.equal(isStructured({ ...session, transport: "test-terminal" }, metadata), false);
  assert.equal(isStructured({ ...session, transport: "future-transport" }, metadata), false);
  assert.equal(sessionUrl("https://ui.example/proxy", "session/a"), "https://ui.example/proxy/session/session%2Fa");
  assert.equal(sessionUrl(undefined, "a"), undefined);
});

test("question snapshots use sequence/revision and older pages never synthesize an empty snapshot", () => {
  const current = { sequence: 10, revision: 2, questions: [] };
  assert.equal(newerQuestions(current, { sequence: 10, revision: 1, questions: [] }), current);
  assert.equal(newerQuestions(current, { sequence: 9, revision: 99, questions: [] }), current);
  assert.equal(parseEventsPage({ events: [], has_more: false, pending_questions: null }, "demo").questions, undefined);
});

test("completed Codex plan snapshots render their canonical body without concatenation", () => {
  const events = [
    parse({
      ...eventWire(1, "system_note", "Started plan", "plan-a"),
      metadata: { item_id: "plan-a", item_type: "plan" },
    }),
    parse({
      ...eventWire(2, "system_note", "Plan updated", "plan-a"),
      metadata: { plan: { id: "plan-a", text: "First draft" } },
    }),
    parse({
      ...eventWire(3, "system_note", "Completed plan", "plan-a"),
      metadata: { plan: { id: "plan-a", text: "## Final plan\n\n1. Inspect\n2. Validate" } },
    }),
  ];
  const rows = transcript(events);
  const plans = rows.filter((row) => row.title === "Plan");
  assert.equal(plans.length, 1);
  assert.equal(plans[0].text, "## Final plan\n\n1. Inspect\n2. Validate");
  assert.equal(plans[0].id, "plan:plan-a");
  assert.equal(selectedRow(rows, undefined, true), plans[0].id);
});

test("Claude plan approval includes the plan body as readable request context", () => {
  const rows = transcript([
    parse({
      ...eventWire(1, "approval_request", "Exit plan mode", ""),
      metadata: {
        tool_name: "ExitPlanMode",
        approval_id: "approval-plan",
        tool_input: { plan: "Review the seedlings, then update the schedule." },
      },
    }),
  ]);
  assert.equal(rows[0].kind, "approval");
  assert.equal(rows[0].title, "Plan approval request");
  assert.equal(rows[0].text, "Review the seedlings, then update the schedule.");
});
