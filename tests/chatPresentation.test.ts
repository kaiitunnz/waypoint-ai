import assert from "node:assert/strict";
import { test } from "node:test";
import { chatExchanges, chatMarkdown, conversationMarkdown, previewMessageLimit } from "../src/domain/chatPresentation";
import { transcript } from "../src/domain/transcript";
import { parseEvent } from "../src/api/sessions";
import { eventWire } from "./fixtures/conversation";

const event = (sequence: number, kind: string, text: string) =>
  parseEvent(eventWire(sequence, kind, text, `item-${sequence}`), "demo");

test("latest exchange keeps its prompt, response and streaming content together", () => {
  const rows = transcript([
    event(1, "user_input", "First question"),
    event(2, "agent_output", "First answer"),
    event(3, "user_input", "Follow-up"),
    event(4, "tool_call", "Tool detail"),
    event(5, "agent_output", "## Complete answer\n\n" + "Content. ".repeat(200)),
  ]);
  const exchanges = chatExchanges(rows);
  assert.equal(exchanges.length, 2);
  const latest = chatMarkdown(exchanges.at(-1));
  assert.ok(latest.includes("Follow&#45;up"));
  assert.ok(latest.includes("## Complete answer"));
  assert.ok(latest.includes("Content. ".repeat(200)));
  assert.ok(!latest.includes("First question"));
  assert.ok(!latest.includes("Tool detail"));
  assert.ok(chatMarkdown(exchanges.at(-1), true).includes("Tool detail"));
});

test("long prompts remain complete and render as plain text", () => {
  const prompt = "# Heading\n\n[link](https://example.com)\n" + "line\n".repeat(100);
  const exchanges = chatExchanges(
    transcript([event(1, "user_input", prompt), event(2, "agent_output", "Visible reply")]),
  );
  const markdown = chatMarkdown(exchanges[0]);
  assert.ok(markdown.includes("> &#35; Heading"));
  assert.equal((markdown.match(/> line/g) || []).length, 100);
  assert.ok(markdown.includes("Visible reply"));
  assert.equal(exchanges[0].prompt?.text, prompt);
  assert.equal(exchanges[0].prompt?.text.length, prompt.length);
});

test("a continuous conversation retains every turn in chronological order", () => {
  const exchanges = chatExchanges(
    transcript([
      event(0, "system_note", "Session started"),
      event(1, "user_input", "Remember the blue garden"),
      event(2, "agent_output", "The blue garden is our topic"),
      event(3, "user_input", "Add herbs"),
      event(4, "agent_output", "Add basil to the garden"),
      event(5, "user_input", "Now add flowers"),
    ]),
  );
  const markdown = conversationMarkdown(exchanges, false, true);
  assert.ok(markdown.startsWith("**You**"));
  assert.ok(!markdown.includes("Session started"));
  assert.ok(conversationMarkdown(exchanges, true, true).includes("Session started"));
  const contents = [
    "Remember the blue garden",
    "The blue garden is our topic",
    "Add herbs",
    "Add basil to the garden",
    "Now add flowers",
    "Waiting for a response",
  ];
  const positions = contents.map((text) => markdown.indexOf(text));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    positions.slice().sort((a, b) => a - b),
  );
  assert.equal((markdown.match(/\*\*You\*\*/g) || []).length, 3);
  assert.equal((markdown.match(/Waiting for a response/g) || []).length, 1);
  exchanges.at(-1)!.rows.push({
    id: "last",
    kind: "assistant",
    title: "Assistant",
    text: "Flowers come next",
    timestamp: "",
    sequence: 6,
  });
  const completed = conversationMarkdown(exchanges);
  assert.ok(completed.includes("The blue garden is our topic"));
  assert.ok(completed.includes("Flowers come next"));
  assert.ok(!completed.includes("Waiting for a response"));
});

test("the preview collapses oversized messages and closes a fence it cuts through", () => {
  const prompt = "p".repeat(5000);
  const answer = "Intro\n\n```ts\n" + "x".repeat(5000) + "\n```\n\nAfter";
  const exchanges = chatExchanges(transcript([event(1, "user_input", prompt), event(2, "agent_output", answer)]));
  const preview = conversationMarkdown(exchanges, false, false, previewMessageLimit);
  assert.ok(preview.length < 2 * previewMessageLimit + 1000);
  assert.match(preview, /\n\n_… 1,000 more characters\. Read Conversation at Full Width to see all of it\._/);
  assert.ok(!/^> .*more characters/m.test(preview), "the note sits outside the quoted prompt");
  const reply = preview.slice(preview.indexOf("**Waypoint**"));
  assert.equal((reply.match(/^```/gm) ?? []).length % 2, 0, "the cut code block is closed");
  assert.match(reply, /more characters/);
  assert.equal(conversationMarkdown(exchanges), conversationMarkdown(exchanges, false, false, undefined));
  assert.ok(conversationMarkdown(exchanges).includes("After"), "the full view keeps everything");
});

test("a clipped reply closes its open fence with the marker that opened it", () => {
  for (const marker of ["~~~", "````"]) {
    const answer = `Intro\n\n${marker}text\n${"x".repeat(5000)}\n${marker}`;
    const exchanges = chatExchanges(transcript([event(1, "user_input", "Q"), event(2, "agent_output", answer)]));
    const reply = conversationMarkdown(exchanges, false, false, previewMessageLimit);
    assert.ok(reply.includes(`${"x".repeat(100)}\n${marker}\n\n_… `), marker);
  }
});

test("activity after a gap starts its own exchange with a marker", () => {
  const rows = transcript([
    event(1, "user_input", "Old prompt"),
    event(2, "agent_output", "Old answer"),
    event(40, "agent_output", "New output"),
    event(41, "user_input", "New prompt"),
  ]);
  const exchanges = chatExchanges(rows, [40]);
  assert.deepEqual(
    exchanges.map((exchange) => [exchange.prompt?.text, exchange.rows.map((row) => row.text), !!exchange.afterGap]),
    [
      ["Old prompt", ["Old answer"], false],
      [undefined, ["New output"], true],
      ["New prompt", [], false],
    ],
  );
  assert.match(conversationMarkdown(exchanges), /Old answer[\s\S]*Earlier activity isn't loaded[\s\S]*New output/);
  assert.equal(chatExchanges(rows.slice(2), [40])[0].afterGap, undefined, "nothing before it, so no marker");
  const twice = chatExchanges(
    transcript([
      event(1, "user_input", "Old prompt"),
      event(20, "agent_output", "After the first gap"),
      event(60, "agent_output", "After the second gap"),
    ]),
    [20, 60],
  );
  assert.deepEqual(
    twice.map((exchange) => !!exchange.afterGap),
    [false, true, true],
    "each gap is marked",
  );
});
