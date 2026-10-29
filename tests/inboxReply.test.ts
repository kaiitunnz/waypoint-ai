import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WaypointClient } from "../src/api/client";
import { InboxBlock, parseInboxItem } from "../src/api/inbox";
import { initialForm } from "../src/domain/inbox";
import { InboxReplySubmitter } from "../src/hooks/inboxReply";
import { holds, submitBlock } from "../src/hooks/inboxSubmit";
import { loadMenuBar } from "../src/hooks/inboxMenuBar";
import { DraftStore, draftKeys } from "../src/storage/drafts";
import { approvalWire, itemWire, questionWire } from "./fixtures/inbox";

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const connection = { id: "server", token: "fixture-token" };

function memoryDrafts() {
  const stored = new Map<string, string>();
  const drafts = new DraftStore({
    keys: async () => [...stored.keys()],
    entries: async () => [...stored],
    removeItem: async (key) => void stored.delete(key),
    getItem: async (key) => stored.get(key),
    setItem: async (key, value) => void stored.set(key, value),
  });
  return { stored, drafts };
}

// A Waypoint double: `submit` answers block submits, `item` answers re-reads, and uploads get numbered ids.
function waypoint(options: {
  submit: () => Response | Promise<Response>;
  item?: () => Response;
  upload?: () => Response;
}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let uploads = 0;
  const client = new WaypointClient("http://localhost", async (input, init) => {
    const url = String(input).replace("http://localhost", "");
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/attachments") && method === "POST")
      return options.upload?.() ?? respond({ id: `up${++uploads}`, filename: "notes.txt", kind: "file", size: 4 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("/blocks/")) return options.submit();
    return options.item?.() ?? respond({ item: itemWire("i") });
  });
  return { client, calls };
}
const question = (overrides: Record<string, unknown> = {}) =>
  parseInboxItem(itemWire("i", { blocks: [questionWire("q", overrides)] }));
const stats = async () => ({ size: 4, modifiedMs: 1 });
const dir = mkdtempSync(join(tmpdir(), "inbox-reply-"));
const file = (name: string) => {
  const path = join(dir, name);
  writeFileSync(path, "test");
  return path;
};
after(async () => (await import("node:fs/promises")).rm(dir, { recursive: true, force: true }));

test("the saved check compares only what was sent", () => {
  const block = (wire: Record<string, unknown>) => parseInboxItem(itemWire("i", { blocks: [wire] })).blocks[0];
  const answered = block(
    questionWire("q", {
      answer: { selected: ["Integration", "Unit"], other: null },
      reply: { notes: "Run", attachments: [{ session_id: "poster", attachment_id: "up1" }], created_at: "t" },
    }),
  );
  assert.ok(holds(answered, { answer: { selected: ["Unit", "Integration"], other: null } }));
  assert.ok(!holds(answered, { answer: { selected: ["Unit"], other: null } }));
  assert.ok(
    holds(answered, { reply: { notes: "Run", attachments: [{ session_id: "poster", attachment_id: "up1" }] } }),
  );
  assert.ok(
    !holds(answered, { reply: { notes: "Run", attachments: [{ session_id: "poster", attachment_id: "up2" }] } }),
  );
  const approval = block(approvalWire("p", { answer: { decision: "Deny" } }));
  assert.ok(holds(approval, { answer: { decision: "Deny" } }));
  assert.ok(!holds(approval, { answer: { decision: "Approve" } }));
});

test("an unconfirmed submit is settled by reading the item back", async () => {
  const saved = itemWire("i", { blocks: [approvalWire("p", { answer: { decision: "Approve" } })] });
  let api = waypoint({ submit: () => respond({}, 502), item: () => respond({ item: saved }) });
  const confirmed = await submitBlock(api.client, "token", "i", "p", { answer: { decision: "Approve" } });
  assert.equal(confirmed.kind, "saved");
  api = waypoint({
    submit: () => respond({}, 502),
    item: () => respond({ item: itemWire("i", { blocks: [approvalWire("p")] }) }),
  });
  assert.equal(
    (await submitBlock(api.client, "token", "i", "p", { answer: { decision: "Approve" } })).kind,
    "not-saved",
  );
  api = waypoint({ submit: () => respond({}, 502), item: () => respond({}, 500) });
  assert.equal((await submitBlock(api.client, "token", "i", "p", { answer: { decision: "Approve" } })).kind, "unknown");
  api = waypoint({ submit: () => respond({ detail: "decision not in block options" }, 422) });
  const rejected = await submitBlock(api.client, "token", "i", "p", { answer: { decision: "Maybe" } });
  assert.deepEqual(rejected, {
    kind: "rejected",
    message: "Waypoint did not accept this answer: decision not in block options",
  });
  api = waypoint({ submit: () => respond({ detail: "inbox item not found" }, 404) });
  assert.equal(
    (await submitBlock(api.client, "token", "i", "p", { reply: { notes: "x", attachments: [] } })).kind,
    "deleted",
  );
});

test("the form opens on a saved draft, else on the block's answer and reply", () => {
  const block: InboxBlock = question({
    answer: { selected: ["Unit"], other: "Smoke" },
    reply: { notes: "Earlier", attachments: [], created_at: "t" },
  }).blocks[0];
  assert.deepEqual(initialForm(block, undefined), { selected: ["Unit"], other: "Smoke", notes: "Earlier" });
  assert.deepEqual(initialForm(block, JSON.stringify({ selected: [], other: "", notes: "Draft" })), {
    selected: [],
    other: "",
    notes: "Draft",
  });
  assert.deepEqual(initialForm(block, "{broken").notes, "Earlier");
});

test("uploads are reused across retries and deleted when the submit definitely failed", async () => {
  let status = 502;
  const { drafts } = memoryDrafts();
  const api = waypoint({
    submit: () => respond({ detail: "selected option not in block options" }, status),
    item: () => respond({ item: itemWire("i", { blocks: [questionWire("q")] }) }),
  });
  const item = question();
  const form = new InboxReplySubmitter(api.client, connection, item, "q", drafts, stats);
  const answer = { selected: ["Unit"], other: "", notes: "See file" };
  assert.equal((await form.submit(item.blocks[0], answer, [file("notes.txt")], true)).kind, "not-saved");
  assert.equal((await form.submit(item.blocks[0], answer, [file("notes.txt")], true)).kind, "not-saved");
  assert.equal(api.calls.filter((call) => call.url.endsWith("/attachments")).length, 1, "uploaded once");
  const sent = api.calls.filter((call) => call.url.includes("/blocks/")).at(-1)!.body;
  assert.deepEqual(sent, {
    answer: { selected: ["Unit"], other: null },
    reply: { notes: "See file", attachments: [{ session_id: "poster", attachment_id: "up1" }] },
  });
  status = 422;
  assert.equal((await form.submit(item.blocks[0], answer, [file("notes.txt")], true)).kind, "rejected");
  assert.deepEqual(
    api.calls.filter((call) => call.method === "DELETE").map((call) => call.url),
    ["/api/sessions/poster/attachments/up1"],
  );
});

test("closing after an unconfirmed submit keeps the files a saved reply may hold", async () => {
  const { drafts } = memoryDrafts();
  let reread = () => respond({}, 500);
  const api = waypoint({ submit: () => respond({}, 502), item: () => reread() });
  const item = question();
  const form = new InboxReplySubmitter(api.client, connection, item, "q", drafts, stats);
  assert.equal(
    (await form.submit(item.blocks[0], { selected: [], other: "", notes: "x" }, [file("a.txt")], false)).kind,
    "unknown",
  );
  await form.discard();
  assert.equal(api.calls.filter((call) => call.method === "DELETE").length, 0, "kept when the item can't be read");

  const second = new InboxReplySubmitter(api.client, connection, item, "q", drafts, stats);
  await second.submit(item.blocks[0], { selected: [], other: "", notes: "x" }, [file("a.txt"), file("b.txt")], false);
  reread = () =>
    respond({
      item: itemWire("i", {
        blocks: [
          questionWire("q", {
            reply: { notes: "x", attachments: [{ session_id: "poster", attachment_id: "up2" }], created_at: "t" },
          }),
        ],
      }),
    });
  await second.discard();
  assert.deepEqual(
    api.calls.filter((call) => call.method === "DELETE").map((call) => call.url),
    ["/api/sessions/poster/attachments/up3"],
    "only the upload the reply doesn't hold is deleted",
  );
});

test("closing while a reply is sending waits for it before cleaning up", async () => {
  const { drafts } = memoryDrafts();
  let finish!: (response: Response) => void;
  const api = waypoint({
    submit: () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  });
  const item = question();
  const form = new InboxReplySubmitter(api.client, connection, item, "q", drafts, stats);
  const sending = form.submit(item.blocks[0], { selected: [], other: "", notes: "x" }, [file("a.txt")], false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const closing = form.discard();
  finish(
    respond({
      item: itemWire("i", {
        blocks: [
          questionWire("q", {
            reply: { notes: "x", attachments: [{ session_id: "poster", attachment_id: "up1" }], created_at: "t" },
          }),
        ],
      }),
    }),
  );
  assert.equal((await sending).kind, "saved");
  await closing;
  assert.equal(api.calls.filter((call) => call.method === "DELETE").length, 0, "the sent file is kept");
});

test("a saved reply removes the draft, and a deleted posting session leaves notes only", async () => {
  const { stored, drafts } = memoryDrafts();
  const key = draftKeys.inbox("server", "i", "q");
  const api = waypoint({
    submit: () =>
      respond({
        item: itemWire("i", {
          blocks: [questionWire("q", { reply: { notes: "ok", attachments: [], created_at: "t" } })],
        }),
      }),
  });
  const item = question();
  const form = new InboxReplySubmitter(api.client, connection, item, "q", drafts, stats);
  await form.saveDraft({ selected: [], other: "", notes: "ok" });
  assert.ok(stored.has(key));
  assert.equal((await form.submit(item.blocks[0], { selected: [], other: "", notes: "ok" }, [], false)).kind, "saved");
  assert.ok(!stored.has(key));
  assert.equal(
    (await form.submit(item.blocks[0], { selected: [], other: "", notes: " " }, [], false)).kind,
    "invalid",
    "nothing to send",
  );

  const gone = waypoint({ submit: () => respond({ item: itemWire("i") }), upload: () => respond({}, 404) });
  const orphan = new InboxReplySubmitter(gone.client, connection, item, "q", drafts, stats);
  const outcome = await orphan.submit(item.blocks[0], { selected: [], other: "", notes: "x" }, [file("a.txt")], false);
  assert.equal(outcome.kind, "session-gone");
  assert.equal(orphan.filesAllowed, false);
  const human = new InboxReplySubmitter(
    gone.client,
    connection,
    parseInboxItem(itemWire("h", { from_session_id: "" })),
    "q",
    drafts,
    stats,
  );
  assert.equal(human.filesAllowed, false);
});

test("removing an item's drafts removes every block's draft and nothing else", async () => {
  const { stored, drafts } = memoryDrafts();
  await drafts.write(draftKeys.inbox("server", "i", "q"), "a");
  await drafts.write(draftKeys.inbox("server", "i", "p"), "b");
  await drafts.write(draftKeys.inbox("server", "i2", "q"), "c");
  await drafts.removePrefix(draftKeys.inboxItem("server", "i"));
  assert.deepEqual([...stored.keys()], [draftKeys.inbox("server", "i2", "q")]);
});

test("the menu bar shows the active server's open items or what it needs", async () => {
  const server = { id: "s", name: "Lab", apiUrl: "http://lab", token: "t" };
  const state = { version: 1 as const, connections: [server], activeId: "s" };
  const client = (body: () => Response) => () =>
    new WaypointClient("http://lab", async (input) =>
      String(input).endsWith("/unresolved-count") ? respond({ unresolved_count: 2 }) : body(),
    );
  const some = await loadMenuBar(
    state,
    client(() => respond({ items: [itemWire("a"), itemWire("b")], has_more: false })),
  );
  assert.ok(some.kind === "items" && some.count === 2 && some.items.length === 2);
  const none = await loadMenuBar(
    state,
    () =>
      new WaypointClient("http://lab", async (input) =>
        String(input).endsWith("/unresolved-count")
          ? respond({ unresolved_count: 0 })
          : respond({ items: [], has_more: false }),
      ),
  );
  assert.ok(none.kind === "items" && none.count === 0);
  assert.equal(
    (
      await loadMenuBar(
        state,
        client(() => respond({}, 401)),
      )
    ).kind,
    "sign-in",
  );
  assert.equal((await loadMenuBar({ ...state, connections: [{ ...server, token: undefined }] })).kind, "sign-in");
  assert.equal(
    (
      await loadMenuBar(
        state,
        client(() => respond({}, 500)),
      )
    ).kind,
    "unreachable",
  );
  assert.equal((await loadMenuBar({ version: 1, connections: [] })).kind, "no-server");
});
