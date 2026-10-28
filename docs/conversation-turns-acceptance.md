# Conversation turns acceptance

The macOS Raycast pass used the development extension against an isolated Waypoint API with a disposable password and data directory, added as a temporary server and removed afterwards. It ran Waypoint's actual authentication, paging, WebSockets, and Codex adapter, with a fake Codex SDK client in place of the agent and histories written straight to storage. Waypoint served its default pages of 20 messages, and the server logged every events query. Raycast was driven with keystrokes, and outcomes were checked in screenshots, the accessibility tree, the query log, and the input events Waypoint stored. The user's own Waypoint server was not used.

## Desktop coverage

| Scenario                                                                     | Observed result                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open a 60-turn session from Browse Sessions                                  | The newest 10 turns are listed, the newest selected with its exchange shown; only the latest page was read                                                                                                    |
| Load Earlier Turns                                                           | One earlier page was read; 10 turns were added and the oldest of them selected                                                                                                                                |
| Load Earlier Turns on a turn whose 110 tool calls span more than three pages | The first press read three pages and added no row; the Activity row was selected with 79 calls shown. The second press read two more pages, reached the prompt, retitled the row, and selected the first turn |
| Load Earlier Turns on a session with no prompts                              | Three pages were read to the start of history; the turns show as Activity                                                                                                                                     |
| Stream a reply with an older turn selected                                   | The older turn stays selected; the newest turn shows Working…                                                                                                                                                 |
| Type with an older turn selected                                             | Raycast reported no selection change; the selection and its detail stayed, and Send Message became the default action                                                                                         |
| Send from an older turn                                                      | Waypoint recorded the message; the new turn was selected                                                                                                                                                      |
| A turn arrives from elsewhere while the newest turn is selected              | The new turn is selected                                                                                                                                                                                      |
| A turn arrives from elsewhere with an older turn selected                    | The older turn stays selected                                                                                                                                                                                 |
| ⌘⇧F twice                                                                    | Show Conversation selects the conversation row; Show Latest Turn returns to the newest turn                                                                                                                   |
| Copy Response on an older turn                                               | The clipboard holds that turn's answer, not the latest                                                                                                                                                        |
| Read Conversation at Full Width on an older turn                             | Only that turn is shown, titled by its prompt                                                                                                                                                                 |
| Arrow onto a long turn                                                       | The detail shows the whole exchange at once, with no empty pane                                                                                                                                               |
| Quick Chat on a two-turn session                                             | Both turns are listed with no Load Earlier Turns row                                                                                                                                                          |
| 63 turns loaded while a reply streams and text is typed                      | Renders took 7 ms on average and 18 ms at most; the typed text arrived intact                                                                                                                                 |

Render times were read from a temporary log in the development build.

![Session chat](screenshots/session-chat.jpg)

![Quick Chat](screenshots/quick-chat.jpg)

Not exercised natively: a session whose interface changed while its chat is open, a reload or deletion while earlier turns load, and turns after missing activity. Tests cover them.

## Automated coverage

`npm run verify` checks formatting, ESLint, strict types, 315 behavior and integration tests, Raycast validation, and build.

Tests cover:

- **Earlier turns:** loading stops once an earlier prompt arrives, at the start of history, or after three pages; activity whose prompt is on an earlier page keeps loading; live turns arriving meanwhile don't end it; a failed page stops without retrying; a reload or deletion abandons it and clears the loading state; one load runs at a time.
- **Rows:** titles use the prompt's first line as plain text, or Activity without a prompt; previews stay short and close an open code fence.
- **Selection:** the newest turn is followed until another row is chosen; Raycast echoing the chat's own choice or naming an unlisted row changes nothing; choosing the newest turn follows again; a turn merged into an earlier prompt's turn keeps its selection; rows that disappear fall back to a listed row; a session whose interface changed lists no turns.
