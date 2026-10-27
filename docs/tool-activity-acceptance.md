# Tool activity acceptance

The macOS Raycast desktop pass used the development extension and an isolated Waypoint API instance. The instance ran the real backend's authentication, session, history, and WebSocket routes, with recorded events published in each agent's real wire shape. Its agent-launch lifespan was disabled, so no agents ran and no private sessions were read.

## What each agent reports

The classifier reads the fields each backend actually emits, established by surveying 168,968 recorded tool events across the four backend/transport pairs:

|             | Codex                                            | Claude Code (structured)    | Claude TUI                  | OpenCode                         |
| ----------- | ------------------------------------------------ | --------------------------- | --------------------------- | -------------------------------- |
| Tool name   | on `item/*` events                               | yes                         | yes                         | yes                              |
| Arguments   | `payload.item.command`, `payload.item.changes[]` | `payload.input`             | `payload.input`             | `tool_input`                     |
| Edit counts | `diff_preview` (`proposed`, then `applied`)      | `diff_preview` (`proposed`) | `diff_preview` (`applied`)  | `state.metadata.filediff`        |
| Reads       | none — a read arrives as a shell command         | `Read`                      | `Read`                      | `read`                           |
| Failure     | `is_error` on `item/completed`                   | `is_error` on `tool_result` | `is_error` on `tool_result` | no flag; the `tool.error` method |

## Desktop coverage

| Scenario                                     | Observed result                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Open a conversation with mixed tool calls    | Consecutive calls collapse into one line in chronological position, between the turns they sit among |
| Show Activity                                | Each call expands to its own command, path, or pattern, with `+A −R` for an edit                     |
| Hide Activity                                | The summary line returns; the previous "N activity items" line is gone                               |
| A run of one call                            | Still summarized, e.g. `1 file read`                                                                 |
| An assistant message inside a burst of calls | The run splits into two summaries either side of the message                                         |
| A lifecycle note inside a burst of calls     | The note folds into the run rather than splitting it                                                 |
| An approval request between calls            | The run splits; the approval keeps its own card                                                      |
| AskUserQuestion and SendUserFile             | Stay their own rows and never fold into a run                                                        |
| Open Conversation History                    | The same runs collapse into one row each, subtitled with the call count                              |
| Search a path inside a collapsed run         | The run row stays visible                                                                            |
| Search while a run is selected               | The selection holds as the query narrows                                                             |
| View Tool Activity                           | Opens the expanded list; Copy Tool Activity copies every call's text                                 |
| A call with no classifiable tool name        | Counts as a tool call rather than disappearing                                                       |
| Quick Chat transcript                        | Collapses and expands the same way as the conversation reader                                        |

The keyboard paths exercised Show Activity/Hide Activity, Show Conversation and Show Latest Response, Conversation History, Load Earlier Messages, Refresh, and Follow Latest. The Actions popup itself was not opened through computer use; its items are covered by tests. Real agent execution was not exercised in this pass.

## Automated coverage

`npm run verify` checks formatting, ESLint, strict types, 221 behavior and integration tests, Raycast manifest/icon validation, and build. Tests cover classification for each backend's real event shape, Codex item-type classification where no tool name is present, MCP and unknown-tool fallbacks, the flat-text fallback for a call with no structured fields, OpenCode's method-based failure, clause ordering and pluralization, distinct-target counting for reads and edits, run boundaries across assistant text, approvals, notes, and standalone cards, and the omitted diffstat when no backend reported counts.

## Screenshots

The summary line appears in the conversation reader and Quick Chat, whose acceptance screenshots are records of earlier phases.
