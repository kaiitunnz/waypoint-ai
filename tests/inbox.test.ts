import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, WaypointClient } from "../src/api/client";
import { InboxQuestionBlock, parseInboxFrame, parseInboxItem, parseInboxPage } from "../src/api/inbox";
import {
  addPage,
  answerProblem,
  applyFrame,
  blockChips,
  emptySection,
  InboxSections,
  itemMarkdown,
  itemSummary,
  itemText,
  matchesQuery,
  pendingBlocks,
  questionAnswer,
  removeItems,
  replyBody,
  senderName,
} from "../src/domain/inbox";
import { approvalWire, at, itemWire, questionWire } from "./fixtures/inbox";

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const item = (id: string, overrides: Record<string, unknown> = {}) => parseInboxItem(itemWire(id, overrides));
const sections = (): InboxSections => ({ open: emptySection(), resolved: emptySection() });
const ids = (state: InboxSections) => ({
  open: state.open.items.map((entry) => entry.id),
  resolved: state.resolved.items.map((entry) => entry.id),
});

test("parses every block kind, keeps unknown blocks, and names a person as the sender", () => {
  const parsed = item("a", {
    from_session_id: "",
    from_label: null,
    read_at: at(5),
    blocks: [
      { id: "m", type: "markdown", text: "Hello", reply: { notes: "Seen", attachments: [], created_at: at(1) } },
      {
        id: "f",
        type: "attachment",
        ref: { session_id: "poster", attachment_id: "att", filename: "report.txt", kind: "file" },
      },
      questionWire("q", { multi: true, answer: { selected: ["Unit"], other: "Smoke" }, answered_at: at(2) }),
      approvalWire("p", { answer: { decision: "Approve" } }),
      { id: "x", type: "checklist", items: [] },
    ],
  });
  assert.deepEqual(
    parsed.blocks.map((block) => block.type),
    ["markdown", "attachment", "question", "approval", "unsupported"],
  );
  assert.equal(parsed.blocks[0].reply?.notes, "Seen");
  const question = parsed.blocks[2] as InboxQuestionBlock;
  assert.deepEqual(question.answer, { selected: ["Unit"], other: "Smoke" });
  assert.equal(question.options[1].description, undefined);
  assert.equal(senderName(parsed), "You");
  assert.equal(senderName(item("b")), "Release prep");
  assert.equal(parsed.readAt, at(5));
  assert.throws(() => parseInboxItem({ ...itemWire("c"), status: "archived" }));
  assert.throws(() => parseInboxItem({ ...itemWire("c"), blocks: [{ id: "q", type: "question" }] }));
  const page = parseInboxPage({ items: [itemWire("a")], has_more: true, cursor: "t|a" });
  assert.deepEqual([page.hasMore, page.cursor], [true, "t|a"]);
  const frame = parseInboxFrame({ item_id: "a", unresolved_count: 2, deleted: true, item: null });
  assert.deepEqual(frame, { itemId: "a", unresolvedCount: 2, deleted: true, item: undefined });
});

test("chips count only unanswered required questions and approvals of open items", () => {
  const open = item("a", {
    blocks: [
      questionWire("q1"),
      questionWire("q2"),
      questionWire("q3", { required: false }),
      questionWire("q4", { answer: { selected: ["Unit"], other: null } }),
      approvalWire("p1"),
    ],
  });
  assert.equal(pendingBlocks(open).length, 3);
  assert.deepEqual(blockChips(open), ["2 questions", "1 approval"]);
  assert.deepEqual(blockChips(item("b", { status: "resolved", blocks: [questionWire("q")] })), []);
});

test("answer checks mirror Waypoint's", () => {
  const single = parseInboxItem(itemWire("a", { blocks: [questionWire("q")] })).blocks[0] as InboxQuestionBlock;
  const multi = parseInboxItem(itemWire("a", { blocks: [questionWire("q", { multi: true, required: false })] }))
    .blocks[0] as InboxQuestionBlock;
  assert.equal(answerProblem(single, { selected: ["Unit"], other: "" }), undefined);
  assert.equal(answerProblem(single, { selected: [], other: "  Smoke " }), undefined);
  assert.match(answerProblem(single, { selected: [], other: " " })!, /Choose an option/);
  assert.match(answerProblem(single, { selected: ["Unit", "Integration"], other: "" })!, /one option/);
  assert.match(answerProblem(single, { selected: ["Other"], other: "" })!, /listed options/);
  assert.equal(answerProblem(multi, { selected: ["Unit", "Integration"], other: "" }), undefined);
  assert.equal(answerProblem(multi, { selected: [], other: "" }), undefined);
  assert.deepEqual(questionAnswer({ selected: [], other: " Smoke " }), { selected: [], other: "Smoke" });
  assert.deepEqual(questionAnswer({ selected: ["Unit"], other: "" }), { selected: ["Unit"], other: null });
  assert.equal(questionAnswer({ selected: [], other: " " }), undefined);
});

test("a reply carries earlier attachments and is left out when it has no notes or files", () => {
  const earlier = [{ sessionId: "poster", attachmentId: "old", filename: "old.txt" }];
  const added = [{ sessionId: "poster", attachmentId: "new" }];
  assert.equal(replyBody("  ", earlier, []), undefined);
  assert.deepEqual(replyBody(" Looks good ", earlier, []), {
    notes: "Looks good",
    attachments: [{ session_id: "poster", attachment_id: "old" }],
  });
  assert.deepEqual(replyBody("", earlier, added), {
    notes: null,
    attachments: [
      { session_id: "poster", attachment_id: "old" },
      { session_id: "poster", attachment_id: "new" },
    ],
  });
});

test("markdown shows every block with answers and replies; summaries stay short", () => {
  const full = item("a", {
    subject: "Ship it?",
    blocks: [
      { id: "m", type: "markdown", text: "Line one\nLine two", reply: null },
      { id: "f", type: "attachment", ref: { session_id: "s", attachment_id: "x", filename: null }, reply: null },
      questionWire("q", {
        answer: { selected: ["Integration"], other: "Smoke" },
        reply: {
          notes: "Run it twice",
          attachments: [{ session_id: "s", attachment_id: "y", filename: "log.txt" }],
          created_at: at(1),
        },
      }),
      approvalWire("p"),
    ],
  });
  const markdown = itemMarkdown(full);
  assert.match(markdown, /^# Ship it\?/);
  assert.match(markdown, /📎 Unavailable attachment/);
  assert.match(markdown, /- ✓ Integration/);
  assert.match(markdown, /- Unit — Fast/);
  assert.match(markdown, /Other: Smoke/);
  assert.match(markdown, /> Run it twice\n> 📎 log\.txt/);
  assert.match(markdown, /Waiting for: Approve \/ Deny/);
  assert.equal(itemSummary(full), "# Ship it?\n\nRelease prep · 1 approval\n\nLine one");
  assert.match(itemText(full), /^Ship it\?\n\nLine one/);
});

test("search matches the subject or sender case-insensitively", () => {
  const entry = item("a", { subject: "Deploy Plan", from_label: "Infra Bot" });
  assert.ok(matchesQuery(entry, "deploy"));
  assert.ok(matchesQuery(entry, "BOT"));
  assert.ok(!matchesQuery(entry, "release"));
  assert.ok(matchesQuery(entry, " "));
});

test("pages drop repeated items and keep each item in the section of its newest copy", () => {
  let state = addPage(sections(), "open", {
    items: [item("c", { updated_at: at(3) }), item("b", { updated_at: at(2) })],
    hasMore: true,
    cursor: "2|b",
  });
  // `b` was answered meanwhile: page two repeats it, and the resolved page carries its newer copy.
  state = addPage(state, "open", {
    items: [item("b", { updated_at: at(2) }), item("a", { updated_at: at(1) })],
    hasMore: false,
  });
  assert.deepEqual(ids(state), { open: ["c", "b", "a"], resolved: [] });
  state = addPage(state, "resolved", {
    items: [item("b", { status: "resolved", version: 1, updated_at: at(4) })],
    hasMore: false,
  });
  assert.deepEqual(ids(state), { open: ["c", "a"], resolved: ["b"] });
  assert.equal(state.open.hasMore, false);
  assert.equal(state.resolved.loaded, true);
  // An older copy arriving later doesn't move it back.
  state = addPage(state, "open", { items: [item("b", { updated_at: at(2) })], hasMore: false });
  assert.deepEqual(ids(state), { open: ["c", "a"], resolved: ["b"] });
});

test("live updates move, insert, or wait for paging", () => {
  let state = addPage(sections(), "open", {
    items: [item("d", { updated_at: at(4) }), item("c", { updated_at: at(3) })],
    hasMore: true,
    cursor: "3|c",
  });
  // Sorts below the last loaded row while more pages remain: paging brings it.
  state = applyFrame(state, { itemId: "a", unresolvedCount: 3, deleted: false, item: item("a") }, "");
  assert.deepEqual(ids(state).open, ["d", "c"]);
  // A newer item goes to the top.
  state = applyFrame(
    state,
    { itemId: "e", unresolvedCount: 4, deleted: false, item: item("e", { updated_at: at(5) }) },
    "",
  );
  assert.deepEqual(ids(state).open, ["e", "d", "c"]);
  // Resolving moves it to Resolved once that section is fully loaded.
  state = addPage(state, "resolved", { items: [], hasMore: false });
  const resolved = item("d", { status: "resolved", version: 1, updated_at: at(6) });
  state = applyFrame(state, { itemId: "d", unresolvedCount: 3, deleted: false, item: resolved }, "");
  assert.deepEqual(ids(state), { open: ["e", "c"], resolved: ["d"] });
  // Outside the search: removed from the list.
  state = applyFrame(
    state,
    {
      itemId: "e",
      unresolvedCount: 3,
      deleted: false,
      item: item("e", { subject: "Other", version: 1, updated_at: at(7) }),
    },
    "item",
  );
  assert.deepEqual(ids(state).open, ["c"]);
  state = applyFrame(state, { itemId: "c", unresolvedCount: 2, deleted: true }, "");
  assert.deepEqual(ids(state), { open: [], resolved: ["d"] });
  assert.deepEqual(ids(removeItems(state, ["d"])), { open: [], resolved: [] });
});

test("inbox requests use Waypoint's routes and inbox wording", async () => {
  const requests: { url: string; method: string; body?: string }[] = [];
  let reply: Response = respond({});
  const client = new WaypointClient("http://localhost", async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
    return reply.clone();
  });
  reply = respond({ items: [itemWire("a")], has_more: false, cursor: null });
  await client.inbox("token", { status: "open", q: "deploy plan", limit: 30, cursor: "t|a" });
  assert.equal(requests[0].url, "http://localhost/api/inbox?status=open&limit=30&q=deploy+plan&cursor=t%7Ca");
  reply = respond({ item: itemWire("a/b") });
  assert.equal((await client.inboxItem("token", "a/b")).id, "a/b");
  assert.equal(requests[1].url, "http://localhost/api/inbox/a%2Fb");
  reply = respond({ unresolved_count: 4 });
  assert.equal(await client.inboxCount("token"), 4);
  reply = respond({ item: itemWire("a") });
  await client.answerInboxBlock("token", "a", "q", { answer: { decision: "Approve" } });
  assert.deepEqual([requests[3].method, requests[3].url], ["POST", "http://localhost/api/inbox/a/blocks/q"]);
  assert.deepEqual(JSON.parse(requests[3].body!), { answer: { decision: "Approve" } });
  await client.markInboxRead("token", "a");
  assert.equal(requests[4].url, "http://localhost/api/inbox/a/read");
  reply = respond({ item_id: "a", deleted: true });
  assert.equal(await client.deleteInboxItem("token", "a"), "a");
  assert.equal(requests[5].method, "DELETE");
  reply = respond({ deleted_ids: ["a", "b"], count: 2 });
  assert.deepEqual(await client.deleteResolvedInbox("token"), ["a", "b"]);
  assert.equal(requests[6].url, "http://localhost/api/inbox/delete-resolved");

  const failure = async (response: Response, call: () => Promise<unknown>) => {
    reply = response;
    try {
      await call();
    } catch (error) {
      assert.ok(error instanceof ApiError);
      return error;
    }
    assert.fail("expected a failure");
  };
  const answer = () => client.answerInboxBlock("token", "a", "q", { answer: { selected: ["Nope"] } });
  const invalid = await failure(respond({ detail: "selected option not in block options" }, 422), answer);
  assert.equal(invalid.message, "Waypoint did not accept this answer: selected option not in block options");
  const deleted = await failure(respond({ detail: "inbox item not found" }, 404), answer);
  assert.deepEqual(
    [deleted.kind, deleted.detail, deleted.message],
    ["not-found", "item", "This inbox item was deleted."],
  );
  const block = await failure(respond({ detail: "inbox block not found" }, 404), answer);
  assert.equal(block.detail, "block");
  const unconfirmed = await failure(respond({}, 502), answer);
  assert.equal(unconfirmed.kind, "uncertain");
  const gone = await failure(respond({ detail: "inbox item not found" }, 404), () => client.inboxItem("token", "a"));
  assert.equal(gone.message, "This inbox item was deleted.");
});

test("a pinned upload sends Waypoint's pin field", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "inbox-upload-"));
  try {
    const path = join(dir, "notes.txt");
    await writeFile(path, "synthetic");
    const forms: FormData[] = [];
    const client = new WaypointClient("http://localhost", async (_url, init) => {
      forms.push(init?.body as FormData);
      return respond({ id: "att", filename: "notes.txt", kind: "file", size: 9 });
    });
    await client.uploadAttachment("token", "poster", path, 9, undefined, true);
    await client.uploadAttachment("token", "poster", path, 9);
    assert.equal(forms[0].get("pin"), "true");
    assert.equal(forms[1].get("pin"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
