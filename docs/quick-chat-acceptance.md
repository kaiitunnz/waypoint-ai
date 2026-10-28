# Quick Chat acceptance

The macOS Raycast pass used the development extension, disposable Waypoint API instances, and an authenticated local Waypoint instance for a real Codex check. The chat instance used Waypoint's actual authentication, preset resolution, session/input/action routes, storage, WebSockets, and session-state broadcaster. A deterministic in-process transport replaced agent execution; agent launch and monitoring were disabled. The isolated pass used no private sessions or model calls. A separate real-agent check used a new Codex session in an empty temporary Git repository: the first message supplied a harmless marker, and the second asked for it without repeating it. The agent recalled the marker.

## Desktop coverage

| Scenario                                          | Observed result                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Open Quick Chat before first send                 | Prepared view; database session count remained zero                                                              |
| Save defaults                                     | Native form saves reuse timeout and returns to the same conversation                                             |
| Close and reopen with a draft                     | Message text restores without sending                                                                            |
| Reconnect immediately after editing               | The current draft remains visible and is not sent                                                                |
| Three consecutive turns                           | All three inputs used the same session ID; the default transcript retained every turn                            |
| First send and follow-up                          | One created session, multiple input events; successful sends clear the input                                     |
| Read earlier turns with a draft                   | Draft stays visible while scrolling; Enter sends to the current session and returns to the continuous transcript |
| Stream assistant output                           | Response appends in the continuous transcript; earlier turns and composer remain available                       |
| Open New Chat command                             | Prepares a fresh conversation with a separate draft                                                              |
| Read an exchange at full width during generation  | The delayed response appears without leaving the reader                                                          |
| Start New Chat                                    | Predecessor remains; creation waits for the first send                                                           |
| Reopen an expired idle session                    | Prepares a new conversation                                                                                      |
| Reopen expired running work                       | Keeps the running conversation                                                                                   |
| Switch saved servers and return                   | The second server has a separate draft; the first server restores its text                                       |
| Reject input                                      | Draft remains; retry uses the existing session                                                                   |
| Input times out after server recording            | Recovery blocks Send; checking the outcome and authorizing retry produces no automatic resend                    |
| Creation times out after storing a tagged session | Outcome check recovers the created session; its input count stays zero until an explicit send                    |
| Interrupt running work                            | Session status becomes interrupted                                                                               |
| Reattach an exited session                        | Same session becomes idle without an input event                                                                 |

The native composition field and transcript share one List view. The conversation row contains all loaded user/assistant turns in chronological order, and each turn has its own row below it; tools remain secondary. Server and session browsing retain the existing Raycast design. Native Markdown preserves selectable text; custom bubble styling is unsupported by Raycast. There is no separate default composition page.

## Real-agent multi-turn check

The native chat sent a marker instruction to Codex and received `Remembered.`. A follow-up that omitted the marker received `amber-kite-47`. Both turns remained in the continuous transcript. The temporary workspace contained no user project files, and the prompts requested no tool use. The real saved API connection remains available as **Waypoint**; the deterministic transport is named **Quick Chat Lab**.

## Automated coverage

`npm run verify` covers formatting, ESLint, strict TypeScript, 73 behavior/integration tests, Raycast validation, and build. Quick Chat tests cover timeout boundaries and all reuse modes, unresolved interaction evidence, preset omission and ownership tags, concurrent opens, per-session send clocks, draft isolation, rejected and uncertain writes, create recovery, missing destinations, explicit abandonment, late acknowledgements, final storage-write failure, cross-process coordination, dead owners, and a process killed during reclamation. Chat presentation tests preserve complete user text and assistant Markdown while grouping turns.

## Coverage limits

SSH launch/password flows were not exercised. Real-agent memory was checked with Codex. The real server's default Claude TUI preset exited before accepting input; the Codex check used a separate preset and session. Model discovery loaded against the authenticated server; all model/profile override combinations were not exercised. The isolated API has no initialized model adapter, so it also covers the recoverable discovery error. Always Continue/Always New and deleted-target abandonment are covered by controller tests. The Actions popup and browser handoff were not verified with computer use; native shortcuts exercised the tested secondary actions. No automated desktop suite is present.

## Screenshots

![Quick Chat with inline composer](screenshots/quick-chat.jpg)
