// Synthetic inbox items in Waypoint's wire shape.
export function itemWire(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    from_session_id: "poster",
    from_label: "Release prep",
    subject: `Item ${id}`,
    status: "open",
    read_at: null,
    version: 0,
    created_at: "2026-10-30T10:00:00+00:00",
    updated_at: "2026-10-30T10:00:00+00:00",
    blocks: [{ id: `${id}-note`, type: "markdown", text: "Notes for review", reply: null }],
    ...overrides,
  };
}

export const questionWire = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "question",
  header: "Scope",
  question: "Which suites should run?",
  options: [
    { label: "Unit", description: "Fast" },
    { label: "Integration", description: null },
  ],
  multi: false,
  required: true,
  answer: null,
  answered_at: null,
  reply: null,
  ...overrides,
});

export const approvalWire = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "approval",
  prompt: "Publish the release notes?",
  options: ["Approve", "Deny"],
  required: true,
  answer: null,
  answered_at: null,
  reply: null,
  ...overrides,
});

// An item updated `minute` minutes after the base time, so lists sort predictably.
export const at = (minute: number) => `2026-10-30T10:${String(minute).padStart(2, "0")}:00+00:00`;
