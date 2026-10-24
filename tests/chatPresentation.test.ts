import assert from "node:assert/strict";
import { test } from "node:test";
import { chatExchanges, chatMarkdown } from "../src/domain/chatPresentation";
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
