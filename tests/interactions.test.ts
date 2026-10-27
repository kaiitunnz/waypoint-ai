import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMetadata } from "../src/api/contracts";
import { ApiError, WaypointClient } from "../src/api/client";
import { PendingQuestions, parseEvent, parseQuestions, parseSession } from "../src/api/sessions";
import {
  Interaction,
  cancelRequest,
  openInteractionKeys,
  preDispatchDetails,
  interactionRequest,
  latestPlan,
  pendingApprovals,
  sessionInteractions,
} from "../src/domain/interactions";
import { decodeQuickChat } from "../src/storage/quickChat";
import { eventWire, metadataWire, sessionWire } from "./fixtures/conversation";

const capabilities = (agent: Record<string, unknown>) =>
  parseMetadata({
    ...metadataWire,
    backends: metadataWire.backends.map((entry) =>
      entry.id === "test-agent" ? { ...entry, agent_capabilities: agent } : entry,
    ),
  });
const metadata = capabilities({
  approval_decisions: ["approve", "acceptForSession", "decline", "mystery"],
  supports_approval_note: true,
  supports_plan_approval: true,
});
const waiting = parseSession({ ...sessionWire(), status: "waiting_input" });
const event = (sequence: number, kind: string, text: string, metadata: Record<string, unknown> = {}) =>
  parseEvent({ ...eventWire(sequence, kind, text), metadata }, "demo");
const snapshot = (
  questions: { id: string; metadata: Record<string, unknown>; availability?: string }[],
  sequence = 10,
  revision = 1,
): PendingQuestions =>
  parseQuestions(
    {
      as_of_sequence: sequence,
      revision,
      questions: questions.map((entry, index) => ({
        tool_use_id: entry.id,
        availability: entry.availability ?? "actionable",
        event: { ...eventWire(50 + index, "tool_call", "AskUserQuestion"), metadata: entry.metadata },
      })),
    },
    "demo",
  );
const respond400 = (detail: string) => new Response(JSON.stringify({ detail }), { status: 400 });
const ask = (questions: unknown) => ({ tool_name: "AskUserQuestion", payload: { input: { questions } } });
const only = (interactions: Interaction[]) => {
  assert.equal(interactions.length, 1);
  return interactions[0];
};

test("event parsing keeps only the interaction fields the client needs", () => {
  const parsed = parseEvent(
    {
      ...eventWire(1, "approval_request", "Run tests?"),
      metadata: {
        approval: { approval_id: "nested", tool_input: { secret: "value" }, decisions: ["x"] },
        interaction: { kind: "approval", request_id: "nested", title: "Run tests", body: "npm test", choices: [{}] },
        payload: {
          requestID: "nested",
          token: "private",
          input: { questions: [{ question: "Q?", options: [{ label: "A", extra: "drop" }], extra: "drop" }] },
          item: { type: "plan", id: "p", text: "Plan", raw: "drop" },
        },
      },
    },
    "demo",
  );
  assert.deepEqual(parsed.metadata.approval, { approval_id: "nested" });
  assert.deepEqual(parsed.metadata.interaction, {
    kind: "approval",
    request_id: "nested",
    title: "Run tests",
    body: "npm test",
  });
  assert.deepEqual(parsed.metadata.payload, {
    requestID: "nested",
    input: {
      questions: [
        {
          question: "Q?",
          header: undefined,
          multiSelect: undefined,
          options: [{ label: "A", description: undefined }],
        },
      ],
    },
    item: { id: "p", text: "Plan" },
  });
});

test("approval queue resolves by flat, nested and permission IDs, and oldest without an ID", () => {
  const flat = event(1, "approval_request", "A", { approval_id: "a" });
  const nested = event(2, "approval_request", "B", { approval: { approval_id: "b" } });
  const third = event(3, "approval_request", "C", { approval_id: "c" });
  assert.deepEqual(
    pendingApprovals([
      flat,
      nested,
      third,
      event(4, "system_note", "Approval response sent: approve", { approval_id: "b" }),
    ]).map((entry) => entry.sequence),
    [1, 3],
  );
  assert.deepEqual(
    pendingApprovals([
      flat,
      nested,
      event(4, "system_note", "Permission once", { method: "permission.replied", payload: { requestID: "b" } }),
    ]).map((entry) => entry.sequence),
    [1],
  );
  assert.deepEqual(
    pendingApprovals([flat, nested, event(4, "system_note", "Approval response sent: decline")]).map(
      (entry) => entry.sequence,
    ),
    [2],
  );
  assert.deepEqual(
    pendingApprovals([flat, event(4, "system_note", "Stopped", { method: "approval.invalidated", approval_id: "a" })]),
    [],
  );
  assert.deepEqual(
    pendingApprovals([flat, event(4, "system_note", "Permission", { method: "permission.replied" })]).length,
    1,
  );
});

test("approvals use advertised decisions, notes and stable IDs while the session waits for input", () => {
  const request = event(1, "approval_request", "Run npm test", {
    approval_id: "a1",
    tool_name: "Bash",
    interaction: { title: "Run command", body: "npm test" },
  });
  const approval = only(sessionInteractions(waiting, metadata, [request]));
  assert.equal(approval.availability, "actionable");
  assert.deepEqual(approval.decisions, ["approve", "acceptForSession", "decline"]);
  assert.equal(approval.title, "Run command");
  assert.equal(approval.text, "npm test");
  assert.equal(approval.note, true);
  assert.deepEqual(interactionRequest(approval, { decision: "approve", note: "  ok  " }), {
    action: "approve",
    body: { approval_id: "a1", decision: "approve", text: "ok" },
  });
  assert.throws(() => interactionRequest(approval, { decision: "cancel" }), /available decision/);
  for (const status of ["idle", "exited", "error", "interrupted"])
    assert.deepEqual(
      sessionInteractions({ ...waiting, status }, metadata, [request]),
      [],
      `${status} has no live request`,
    );
  for (const status of ["starting", "running"])
    assert.equal(sessionInteractions({ ...waiting, status }, metadata, [request]).length, 1, status);
  assert.equal(
    sessionInteractions({ ...waiting, status: "running" }, metadata, [
      request,
      event(2, "tool_result", "", { status: "running", item_id: "parallel" }),
    ]).length,
    1,
    "a later running event does not resolve a pending approval",
  );
  const noDecisions = only(sessionInteractions(waiting, capabilities({}), [request]));
  assert.equal(noDecisions.availability, "unavailable");
  assert.match(noDecisions.reason!, /Open it in Waypoint/);
  const missingId = only(sessionInteractions(waiting, metadata, [event(1, "approval_request", "Run")]));
  assert.equal(missingId.key, "approval:sequence:1");
  assert.match(missingId.reason!, /no stable ID/);
  const terminal = only(sessionInteractions({ ...waiting, transport: "test-terminal" }, metadata, [request]));
  assert.match(terminal.reason!, /Open this interface/);
  const quiet = only(
    sessionInteractions(waiting, capabilities({ approval_decisions: ["approve", "decline"] }), [request]),
  );
  assert.equal(quiet.note, false);
  assert.deepEqual(interactionRequest(quiet, { decision: "decline", note: "ignored" }).body, {
    approval_id: "a1",
    decision: "decline",
  });
});

test("plan-mode approvals show the plan body and signatures follow displayed context only", () => {
  const exit = event(1, "approval_request", "ExitPlanMode", {
    approval_id: "tool-1",
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. Build\n2. Test" },
  });
  const approval = only(sessionInteractions(waiting, metadata, [exit]));
  assert.equal(approval.title, "Plan approval");
  assert.equal(approval.text, "1. Build\n2. Test");
  const changed = only(sessionInteractions({ ...waiting, transport: "test-terminal" }, metadata, [exit]));
  assert.ok(changed.reason, "handoff reasons do not change the request identity");
  assert.equal(changed.signature, approval.signature);
  const revised = only(
    sessionInteractions(waiting, metadata, [
      event(1, "approval_request", "ExitPlanMode", { ...exit.metadata, tool_input: { plan: "Different" } }),
    ]),
  );
  assert.notEqual(revised.signature, approval.signature);
});

test("plans follow Waypoint's current-plan rules", () => {
  const planning = { ...waiting, status: "idle", permissionMode: "plan" };
  const plan = (sequence: number, id: string, text: string, extra: Record<string, unknown> = {}) =>
    event(sequence, "system_note", "", { item_type: "plan", plan: { id, text, ...extra } });
  const decided = (sequence: number, id: string, decision = "accept") =>
    event(sequence, "system_note", "Plan approved", { plan_item_id: id, plan_decision: decision });
  assert.equal(latestPlan([plan(1, "a", "A"), plan(2, "b", "B")])?.id, "b");
  assert.equal(latestPlan([plan(1, "a", "Full"), plan(2, "a", "")])?.text, "Full");
  assert.equal(latestPlan([plan(1, "a", "Full"), decided(2, "a")]), undefined);
  assert.equal(latestPlan([plan(1, "a", "A"), decided(2, "b"), plan(3, "b", "B")])?.id, "b");
  assert.equal(latestPlan([plan(1, "a", "A"), decided(2, "a", "unknown")])?.id, "a");
  assert.equal(
    latestPlan([plan(1, "a", "A"), event(2, "agent_output", "", { plan: { id: "x", text: "X" } })])?.id,
    "a",
  );
  assert.equal(latestPlan([plan(1, "a", "A"), plan(2, "b", "")])?.text, "");
  assert.equal(
    latestPlan([event(1, "system_note", "", { item_type: "plan", item_id: "item", payload: { item: { text: "T" } } })])
      ?.id,
    "item",
  );

  const current = only(
    sessionInteractions(planning, metadata, [plan(1, "p", "Do it", { decisions: ["accept", "decline", "x"] })]),
  );
  assert.equal(current.kind, "plan");
  assert.deepEqual(current.decisions, ["accept", "decline"]);
  assert.equal(current.availability, "actionable");
  assert.deepEqual(interactionRequest(current, { decision: "accept", note: "Go" }), {
    action: "approve-plan",
    body: { plan_item_id: "p", decision: "accept", text: "Go" },
  });
  const defaults = only(sessionInteractions(planning, metadata, [plan(1, "p", "Do it")]));
  assert.deepEqual(defaults.decisions, ["accept", "acceptForSession", "decline", "cancel"]);
  assert.deepEqual(
    sessionInteractions({ ...planning, permissionMode: "default" }, metadata, [plan(1, "p", "Do it")]),
    [],
  );
  assert.deepEqual(sessionInteractions(planning, capabilities({}), [plan(1, "p", "Do it")]), []);
  assert.deepEqual(sessionInteractions(planning, metadata, [plan(1, "p", "")]), []);
  assert.deepEqual(
    sessionInteractions({ ...planning, status: "waiting_input" }, metadata, [
      plan(1, "p", "Do it"),
      event(2, "approval_request", "Run", { approval_id: "a" }),
    ]).map((entry) => entry.kind),
    ["approval"],
  );
});

test("question shapes, availability and handoff reasons", () => {
  const valid = ask([{ question: "Pick", header: "Choice", options: [{ label: "A", description: "First" }] }]);
  const question = only(sessionInteractions(waiting, metadata, [], snapshot([{ id: "q1", metadata: valid }])));
  assert.equal(question.kind, "question");
  assert.equal(question.title, "Choice");
  assert.deepEqual(question.questions, [
    { question: "Pick", header: "Choice", options: [{ label: "A", description: "First" }], multiple: false },
  ]);
  const toolInput = only(
    sessionInteractions(
      waiting,
      metadata,
      [],
      snapshot([{ id: "q1", metadata: { tool_input: { questions: [{ question: "Why?" }] } } }]),
    ),
  );
  assert.equal(toolInput.availability, "actionable");
  for (const malformed of [
    [],
    [{ question: "" }],
    [{ question: "Same" }, { question: "Same" }],
    [{ question: "Q", options: [{ label: "A" }, { label: "A" }] }],
    [{ question: "Q", options: [{ label: "" }] }],
    [{ question: "Q", options: "A" }],
    [{ question: "Q", multiSelect: "yes" }],
    [{ question: 4 }],
  ]) {
    const result = only(sessionInteractions(waiting, metadata, [], snapshot([{ id: "q", metadata: ask(malformed) }])));
    assert.equal(result.availability, "unavailable", JSON.stringify(malformed));
    assert.match(result.reason!, /format needs Waypoint/);
  }
  assert.equal(
    only(sessionInteractions(waiting, metadata, [], snapshot([{ id: "q", metadata: valid, availability: "starting" }])))
      .availability,
    "starting",
  );
  assert.equal(
    only(sessionInteractions(waiting, metadata, [], snapshot([{ id: "q", metadata: valid, availability: "odd" }])))
      .availability,
    "unavailable",
  );
  const blocked = sessionInteractions(
    waiting,
    metadata,
    [event(1, "approval_request", "Run", { approval_id: "a" })],
    snapshot([{ id: "q", metadata: valid }]),
  );
  assert.equal(blocked[1].afterApproval, true, "Waypoint decides whether a pending approval blocks an answer");
  assert.equal(blocked[1].availability, "actionable");
  assert.equal(interactionRequest(blocked[1], { selected: { "0": ["A"] } }).action, "answer-question");
});

test("open interaction keys ignore visibility filters", () => {
  const planning = [
    event(1, "system_note", "", { item_type: "plan", plan: { id: "p", text: "" } }),
    event(2, "approval_request", "Run", { approval: { approval_id: "n" } }),
    event(3, "approval_request", "Run"),
  ];
  assert.deepEqual(
    [...openInteractionKeys(planning, snapshot([{ id: "q", metadata: ask("bad"), availability: "starting" }]))],
    ["approval:n", "approval:sequence:3", "plan:p", "question:q"],
  );
});

test("answer payloads match Waypoint's serialization", () => {
  const question = only(
    sessionInteractions(
      waiting,
      metadata,
      [],
      snapshot([
        {
          id: "tool-1",
          metadata: ask([
            { question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] },
            { question: "Extras?", multiSelect: true, options: [{ label: "Tests" }, { label: "Docs" }] },
            { question: "Name?" },
            { question: "Skip?", options: [{ label: "Yes" }] },
          ]),
        },
      ]),
    ),
  );
  assert.deepEqual(
    interactionRequest(question, {
      selected: { "0": ["Blue"], "1": ["Docs", "Tests"] },
      notes: { "0": "", "1": " both ", "2": " Ada " },
    }),
    {
      action: "answer-question",
      body: {
        tool_use_id: "tool-1",
        answers: [
          { question: "Color?", answer: "Blue" },
          { question: "Extras?", answer: "Tests, Docs", notes: "both" },
          { question: "Name?", answer: "Ada" },
        ],
        answer: '"Color?"="Blue", "Extras?"="Tests, Docs" user notes: both, "Name?"="Ada"',
      },
    },
  );
  assert.deepEqual(interactionRequest(question, { notes: { "0": "Green" } }).body, {
    tool_use_id: "tool-1",
    answers: [{ question: "Color?", answer: null, notes: "Green" }],
    answer: '"Color?"=(no option selected) user notes: Green',
  });
  assert.throws(() => interactionRequest(question, {}), /Enter an answer/);
  assert.throws(() => interactionRequest(question, { selected: { "0": ["Red", "Blue"] } }), /available answer/);
  assert.throws(() => interactionRequest(question, { selected: { "0": ["Purple"] } }), /available answer/);
  assert.deepEqual(cancelRequest(question), { action: "cancel-question", body: { tool_use_id: "tool-1" } });
});

test("positional-answer agents need every answer, plain labels and unsplit free text", () => {
  const opencode = { ...waiting, backend: "opencode", transport: "test-rpc" };
  const catalog = parseMetadata({
    ...metadataWire,
    backends: [...metadataWire.backends, { ...metadataWire.backends[0], id: "opencode", label: "OpenCode" }],
  });
  const derive = (questions: unknown) =>
    only(sessionInteractions(opencode, catalog, [], snapshot([{ id: "que_1", metadata: ask(questions) }])));
  const grouped = derive([
    { question: "One?", options: [{ label: "A" }] },
    { question: "Two?", options: [{ label: "B" }] },
  ]);
  assert.equal(grouped.positionalAnswers, true);
  assert.throws(() => interactionRequest(grouped, { selected: { "0": ["A"] } }), /Answer every question/);
  assert.equal(
    interactionRequest(grouped, { selected: { "0": ["A"] }, notes: { "1": "custom" } }).action,
    "answer-question",
  );
  assert.match(derive([{ question: "One?", options: [{ label: "A, B" }] }]).reason!, /labels need Waypoint/);
  assert.match(derive([{ question: "One?", options: [{ label: " A" }] }]).reason!, /labels need Waypoint/);
  assert.deepEqual(interactionRequest(derive([{ question: "Name?" }]), { notes: { "0": "Ada, Lovelace" } }).body, {
    tool_use_id: "que_1",
    answers: [{ question: "Name?", answer: null, notes: "Ada, Lovelace" }],
    answer: '"Name?"=(no option selected) user notes: Ada, Lovelace',
  });
});

test("interaction HTTP outcomes separate definitive rejections from unconfirmed delivery", async () => {
  const outcome = async (status: number | "network", body: unknown = { session: sessionWire() }) => {
    const client = new WaypointClient("http://localhost", async () => {
      if (status === "network") throw new Error("socket closed with private detail");
      return new Response(JSON.stringify(body), { status });
    });
    try {
      await client.interaction("token", "demo", "approve", { approval_id: "a", decision: "approve" });
      return "ok";
    } catch (error) {
      assert.ok(error instanceof ApiError);
      assert.doesNotMatch(error.message, /private|HTTP/);
      return error.kind;
    }
  };
  assert.equal(await outcome(200), "ok");
  const proven = async (detail: string, known: string[]) => {
    const client = new WaypointClient("http://localhost", async () => respond400(detail));
    try {
      await client.interaction("token", "demo", "approve", {}, known);
    } catch (error) {
      assert.ok(error instanceof ApiError);
      return error.kind;
    }
  };
  assert.equal(await proven("no pending approval request", ["no pending approval request"]), "rejected");
  assert.equal(await proven("no pending approval request", []), "uncertain");
  assert.equal(await proven("failed to answer question", ["question is no longer open"]), "uncertain");
  assert.equal(await outcome(401), "expired-token");
  assert.equal(await outcome(404), "not-found");
  assert.equal(await outcome(409), "rejected");
  assert.equal(await outcome(422), "rejected");
  assert.equal(await outcome(400, { detail: "no pending approval request" }), "uncertain");
  assert.equal(await outcome(500), "uncertain");
  assert.equal(await outcome(502), "uncertain");
  assert.equal(await outcome("network"), "uncertain");
  assert.equal(await outcome(200, { session: sessionWire("other") }), "uncertain");
  assert.equal(await outcome(200, { nope: true }), "uncertain");
});

test("pre-dispatch details depend on the request kind and agent", () => {
  const request = event(1, "approval_request", "Run", { approval_id: "a" });
  const approval = only(sessionInteractions(waiting, metadata, [request]));
  assert.deepEqual(preDispatchDetails(approval, "codex"), ["no pending approval request"]);
  assert.deepEqual(preDispatchDetails(approval, "opencode"), []);
  const question = only(
    sessionInteractions(waiting, metadata, [], snapshot([{ id: "q", metadata: ask([{ question: "Q?" }]) }])),
  );
  assert.ok(preDispatchDetails(question, "opencode").includes("question is no longer open"));
});

test("interaction storage validates nested drafts and checkpoints without losing version-1 data", () => {
  const base = {
    version: 1,
    installation: "install",
    defaults: decodeQuickChat().defaults,
    sentAt: {},
    drafts: {},
  };
  assert.equal(decodeQuickChat(JSON.stringify(base)).interactionDrafts, undefined);
  const drafts = {
    "demo:question:q:sig": { selected: { "0": ["A"] }, notes: { "0": "n" }, decision: "approve", note: "" },
  };
  assert.deepEqual(decodeQuickChat(JSON.stringify({ ...base, interactionDrafts: drafts })).interactionDrafts, drafts);
  const pending = {
    kind: "interaction",
    operationId: "op",
    sessionId: "demo",
    interactionKey: "question:q",
    interactionAction: "answer-question",
    draftKey: "demo:question:q:sig",
    text: "",
    startedAt: 1,
  };
  assert.equal(decodeQuickChat(JSON.stringify({ ...base, pending })).pending?.kind, "interaction");
  for (const corrupt of [
    { interactionDrafts: [] },
    { interactionDrafts: { key: "text" } },
    { interactionDrafts: { key: { selected: { "0": "A" } } } },
    { interactionDrafts: { key: { selected: { "0": [1] } } } },
    { interactionDrafts: { key: { notes: { "0": 1 } } } },
    { interactionDrafts: { key: { decision: 1 } } },
    { pending: { ...pending, interactionAction: "delete-session" } },
    { pending: { ...pending, sessionId: undefined } },
    { pending: { ...pending, interactionKey: 3 } },
  ])
    assert.throws(() => decodeQuickChat(JSON.stringify({ ...base, ...corrupt })), /could not be read/);
});
