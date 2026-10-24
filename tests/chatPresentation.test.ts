import assert from "node:assert/strict";
import { test } from "node:test";
import { chatExchanges, chatMarkdown, conversationMarkdown } from "../src/domain/chatPresentation";
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
