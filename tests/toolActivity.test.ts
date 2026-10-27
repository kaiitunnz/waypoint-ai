import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEvent } from "../src/api/sessions";
import { groupRuns, runCallCount } from "../src/domain/chatPresentation";
import { transcript } from "../src/domain/transcript";
import { summarizeRun, toolActivity } from "../src/domain/toolActivity";

let sequence = 0;
// Sequences drive transcript order, so each test starts its own run of events.
const parse = (kind: string, text: string, metadata: Record<string, unknown> = {}) =>
  parseEvent(
    {
      id: 100 + ++sequence,
      session_id: "demo",
      sequence,
      ts: "2026-10-24T08:00:00Z",
      kind,
      text,
      metadata,
    },
    "demo",
  );

// Each case reproduces a real recorded event shape, with the fields the survey found each backend emits.
// They are builders so a test's own events keep their place in the sequence.
const claudeRead = () => [
  parse("tool_call", 'Read\n{"file_path": "/a/one.ts"}', {
    item_id: "r1",
    method: "assistant.tool_use",
    tool_name: "Read",
    payload: { input: { file_path: "/a/one.ts" } },
  }),
  parse("tool_result", "contents", { item_id: "r1", method: "user.tool_result" }),
];
const claudeEdit = () => [
  parse("tool_call", 'Edit\n{"file_path": "/a/two.ts"}', {
    item_id: "e1",
    method: "assistant.tool_use",
    tool_name: "Edit",
    payload: { input: { file_path: "/a/two.ts" } },
  }),
  // Claude reports the counts on the diff-preview result, which is a second event for the same call.
  parse("tool_result", "Edit diff preview", {
    item_id: "e1",
    method: "can_use_tool.diff_preview",
    tool_name: "Edit",
    diff_preview: {
      phase: "proposed",
      total_additions: 42,
      total_deletions: 7,
      files: [{ path: "/a/two.ts", change_type: "update", additions: 42, deletions: 7 }],
    },
  }),
];
// Codex has no payload.input: the command rides inside the raw upstream item.
const codexCommand = () => [
  parse("tool_call", "$ npm run verify", {
    item_id: "c1",
    item_type: "commandExecution",
    method: "item/started",
    tool_name: "Bash",
    payload: { item: { type: "commandExecution", command: "npm run verify" } },
  }),
  parse("tool_result", "$ npm run verify\nok", {
    item_id: "c1",
    item_type: "commandExecution",
    method: "item/completed",
    tool_name: "Bash",
    is_error: false,
  }),
];
// OpenCode reports an edit's counts as structured data, and marks failure by method rather than is_error.
const openCodeEdit = () => [
  parse("tool_call", "Running edit", {
    item_id: "o1",
    item_type: "tool_use",
    method: "tool.running",
    tool_name: "edit",
    tool_input: { filePath: "/a/three.ts" },
  }),
  parse("tool_result", "Result for edit:", {
    item_id: "o1",
    item_type: "tool_result",
    method: "tool.completed",
    tool_name: "edit",
    payload: { state: { metadata: { filediff: { file: "/a/three.ts", additions: 5, deletions: 2 } } } },
  }),
];

test("a single event still classifies on its own", () => {
  assert.equal(toolActivity([parse("tool_call", "x", { tool_name: "Bash" })], "x").kind, "command");
});

test("each backend's call shape classifies with its own target and change counts", () => {
  const read = toolActivity(claudeRead(), "Read\n{}");
  assert.deepEqual(read, {
    kind: "read",
    label: "Read",
    target: "/a/one.ts",
    additions: undefined,
    deletions: undefined,
    error: false,
  });

  const edit = toolActivity(claudeEdit(), "Edit\n{}");
  assert.equal(edit.kind, "edit");
  assert.equal(edit.target, "/a/two.ts");
  assert.equal(edit.additions, 42);
  assert.equal(edit.deletions, 7);

  const command = toolActivity(codexCommand(), "$ npm run verify");
  assert.equal(command.kind, "command");
  assert.equal(command.target, "npm run verify");

  const opencode = toolActivity(openCodeEdit(), "Running edit");
  assert.equal(opencode.kind, "edit");
  assert.equal(opencode.target, "/a/three.ts");
  assert.equal(opencode.additions, 5);
  assert.equal(opencode.deletions, 2);
});

test("Codex item types classify the calls that carry no tool name", () => {
  const cases: [string, string][] = [
    ["commandExecution", "command"],
    ["fileChange", "edit"],
    ["mcpToolCall", "mcp"],
    ["webSearch", "web"],
    ["collabAgentToolCall", "agent"],
    ["subAgentActivity", "agent"],
    ["todo_list", "todo"],
  ];
  for (const [itemType, kind] of cases)
    assert.equal(toolActivity([parse("tool_call", itemType, { item_type: itemType })], itemType).kind, kind, itemType);
});

test("namespaced and unknown tools are recognised as MCP or other", () => {
  for (const name of ["mcp__ccd_pr__get_status", "codex_apps:github_search"])
    assert.equal(toolActivity([parse("tool_call", name, { tool_name: name })], name).kind, "mcp", name);
  assert.equal(toolActivity([parse("tool_call", "Future", { tool_name: "futureThing" })], "Future").kind, "other");
});

test("a call with no structured fields falls back to its flat text", () => {
  // claude_tty reports pane-scraped calls with no item_id and no payload.
  const scraped = toolActivity(
    [parse("tool_call", "Bash(git status)\nRunning…", { method: "assistant.tool_use", tool_name: "Bash" })],
    "Bash(git status)\nRunning…",
  );
  assert.equal(scraped.target, "git status");
  const bare = toolActivity(
    [parse("tool_call", 'Read\n{\n  "file_path": "/a/four.ts"\n}', { tool_name: "Read" })],
    'Read\n{\n  "file_path": "/a/four.ts"\n}',
  );
  assert.equal(bare.target, "/a/four.ts");
});

test("OpenCode failure is recognised without an is_error field", () => {
  const failed = toolActivity(
    [
      parse("tool_result", "Error: command not found", {
        item_id: "o2",
        item_type: "tool_result",
        method: "tool.error",
        tool_name: "bash",
      }),
    ],
    "Error: command not found",
  );
  assert.equal(failed.error, true);
  assert.equal(failed.kind, "command");
});

test("the summary counts per kind, pluralizes, and orders its clauses", () => {
  const activities = [
    toolActivity(codexCommand(), ""),
    toolActivity(claudeRead(), ""),
    toolActivity(claudeEdit(), ""),
    toolActivity(openCodeEdit(), ""),
  ];
  assert.equal(summarizeRun(activities), "1 command · 1 file read · 2 files edited (+47 −9)");
  assert.equal(summarizeRun([]), "");
  assert.equal(summarizeRun([toolActivity(claudeRead(), "")]), "1 file read");
});

test("reads and edits count distinct targets, other kinds count calls", () => {
  const twice = toolActivity(claudeRead(), "");
  assert.equal(summarizeRun([twice, twice]), "1 file read");
  const commands = [toolActivity(codexCommand(), ""), toolActivity(codexCommand(), "")];
  assert.equal(summarizeRun(commands), "2 commands");
  // A target-less call cannot be deduplicated, so it counts each time.
  const anonymous = toolActivity([parse("tool_call", "x", { tool_name: "Read" })], "x");
  assert.equal(summarizeRun([anonymous, anonymous]), "2 files read");
});

test("a run is a contiguous stretch of tool rows and breaks on other content", () => {
  const rows = transcript([
    parse("user_input", "Fix the build", { item_id: "" }),
    ...claudeRead(),
    ...codexCommand(),
    parse("agent_output", "Halfway there.", { item_id: "reply-1" }),
    ...claudeEdit(),
  ]);
  const entries = groupRuns(rows);
  assert.deepEqual(
    entries.map((entry) => ("run" in entry ? entry.run.summary : entry.row.kind)),
    ["user", "1 command · 1 file read", "assistant", "1 file edited (+42 −7)"],
  );
  const run = entries[1];
  assert.ok("run" in run);
  assert.deepEqual(run.run.rows.length, 2);
});

test("an approval or a plan breaks a run, and a single call still forms one", () => {
  const rows = transcript([
    ...claudeRead(),
    parse("approval_request", "May I read the file?", { approval_id: "a1", tool_name: "Read" }),
    ...codexCommand(),
  ]);
  assert.deepEqual(
    groupRuns(rows).map((entry) => ("run" in entry ? entry.run.summary : entry.row.kind)),
    ["1 file read", "approval", "1 command"],
  );
});

test("a diffstat is omitted when no backend reported counts", () => {
  const edit = toolActivity(
    [
      parse("tool_call", 'Edit\n{"file_path": "/a/five.ts"}', {
        item_id: "e9",
        method: "assistant.tool_use",
        tool_name: "Edit",
        payload: { input: { file_path: "/a/five.ts" } },
      }),
    ],
    "Edit",
  );
  assert.equal(summarizeRun([edit]), "1 file edited");
});

test("lifecycle notes fold into the run they sit inside", () => {
  // Waypoint's own transcript absorbs notes rather than splitting a run at each one.
  const rows = transcript([
    ...claudeRead(),
    parse("system_note", "Turn changes: +414 -20", { method: "turn/diff/updated" }),
    ...codexCommand(),
  ]);
  const entries = groupRuns(rows);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok("run" in entry);
  assert.equal(entry.run.summary, "1 command · 1 file read");
  assert.equal(runCallCount(entry.run), 2);
  // A note with no run around it stays its own row.
  assert.deepEqual(
    groupRuns(transcript([parse("system_note", "Session started", {})])).map((item) =>
      "run" in item ? item.run.summary : item.row.kind,
    ),
    ["note"],
  );
});

test("a call with its own card does not fold into a run", () => {
  for (const tool of ["AskUserQuestion", "SendUserFile"])
    assert.deepEqual(
      groupRuns(
        transcript([
          ...claudeRead(),
          parse("tool_call", tool, { item_id: `x-${tool}`, tool_name: tool }),
          ...codexCommand(),
        ]),
      ).map((entry) => ("run" in entry ? entry.run.summary : entry.row.kind)),
      ["1 file read", "tool", "1 command"],
      tool,
    );
});
