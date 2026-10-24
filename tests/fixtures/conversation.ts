export const sessionWire = (id = "demo") => ({
  id,
  backend: "test-agent",
  transport: "test-rpc",
  source: "managed",
  title: "Build a small garden",
  cwd: "/workspace/garden",
  repo_name: "garden",
  branch: "feat/seedlings",
  status: "running",
  pinned_at: null,
  last_event_at: "2026-10-24T08:00:00Z",
  model: "test-model",
  context_usage: { used_tokens: 1200, context_window_tokens: 8000 },
  session_token_usage: { display_total_tokens: 4000 },
  raw_log_path: "/private-not-for-ui/log",
  args: ["secret-argument"],
});
export const eventWire = (
  sequence: number,
  kind = "agent_output",
  text = `part-${sequence}`,
  itemId = "reply",
  sessionId = "demo",
) => ({
  id: 100 + sequence,
  session_id: sessionId,
  sequence,
  ts: "2026-10-24T08:00:00Z",
  kind,
  text,
  metadata: itemId ? { item_id: itemId } : {},
});
export const recording = [
  eventWire(1, "user_input", "Please inspect the garden plan.", ""),
  eventWire(2, "agent_output", "I will inspect ", "thought"),
  eventWire(3, "agent_output", "the plan first.", "thought"),
  { ...eventWire(4, "tool_call", "Read garden.md", "read"), metadata: { item_id: "read", tool_name: "Read file" } },
  {
    ...eventWire(5, "tool_result", "Seed", "read"),
    metadata: { item_id: "read", method: "item/commandExecution/outputDelta" },
  },
  {
    ...eventWire(6, "tool_result", "lings", "read"),
    metadata: { item_id: "read", method: "item/commandExecution/outputDelta" },
  },
  { ...eventWire(7, "tool_result", "Seedlings", "read"), metadata: { item_id: "read", status: "completed" } },
  eventWire(8, "agent_output", "The garden plan ", "final"),
  eventWire(9, "agent_output", "looks healthy.", "final"),
];
export const metadataWire = {
  authenticated: true,
  default_backend: "test-agent",
  launch_targets: [],
  backends: [
    {
      id: "test-agent",
      label: "Test Agent",
      transport_id: "test-rpc",
      default_transport: "test-rpc",
      supported_transports: ["test-rpc", "test-terminal"],
      transport_capabilities: { is_structured: true },
    },
    {
      id: "terminal",
      label: "Terminal",
      transport_id: "test-terminal",
      default_transport: "test-terminal",
      supported_transports: ["test-terminal"],
      transport_capabilities: { is_structured: false },
    },
  ],
};
