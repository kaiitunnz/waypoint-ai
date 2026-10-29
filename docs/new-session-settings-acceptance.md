# New Session with Settings acceptance

The macOS Raycast pass used the development extension against an isolated Waypoint API with a disposable password and data directory, added as a temporary server and removed afterwards. It ran Waypoint's actual authentication, sessions, WebSockets, and Codex adapter, with a fake Codex SDK client in place of the agent. A fixture switch made the next session create a definite refusal with a reason. Raycast was driven with keystrokes, and outcomes were checked in screenshots, the accessibility tree, and the server's session list. The user's own Waypoint server was not used.

## Desktop coverage

| Scenario                                                            | Observed result                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ⌘⇧N in Quick Chat                                                   | The form opens with Quick Chat Defaults: server default preset, Local target, the workspace as the folder placeholder, Codex |
| Change folder and model, close Raycast, reopen Quick Chat, ⌘⇧N      | The folder and model are restored                                                                                            |
| Start Session when Waypoint refuses the create                      | The form stays open with "Waypoint: preset blocked by policy"; no session is created                                         |
| Start Session                                                       | One session with the chosen folder and model, titled with its creation time and tagged as Quick Chat's; Quick Chat shows it  |
| The new session before any message                                  | The conversation shows its title, agent, model, target, and folder                                                           |
| Quick Chat Defaults afterwards                                      | Folder and model are still empty                                                                                             |
| Reopen Quick Chat (timed, then Always New) before the first message | The same session both times                                                                                                  |
| Send the first message                                              | It reaches the created session; no other session is created                                                                  |
| Reopen in Always New after the first message                        | A new conversation                                                                                                           |
| New Chat → ⌘⇧N                                                      | The form starts from the defaults again, since the previous start cleared the draft                                          |
| Start Session in New Chat, close, reopen New Chat                   | The same session                                                                                                             |
| Start New Chat from that unused session, close, reopen New Chat     | A new conversation                                                                                                           |
| Discard Draft (⌃⇧X), then reopen the form                           | The form is back to the defaults both times                                                                                  |

![New Session with Settings](screenshots/new-session-settings.jpg)

Not exercised natively: an unconfirmed create and its recovery, a password SSH target that needs connecting first, and a failed storage write after a create. Tests cover them.

## Automated coverage

`npm run verify` checks formatting, ESLint, strict types, 282 behavior and integration tests, Raycast validation, and build.

Tests cover:

- **Starting:** a create with the chosen settings and no message, defaults unchanged, the session shown and made Quick Chat's destination; the next send going to it; the workspace created for an empty folder on this Mac's server; refusals while loading, busy, or unconfirmed; starting when the saved destination is gone.
- **Reopening:** an unused started session continued in every reuse mode and in New Chat, with timed reuse counting from its start; Always New and New Chat moving on after the first message; Start New Chat moving on in every mode, also after reopening; Use for Quick Chat and a New Chat send keeping precedence; staging context and discarding a compose draft keeping the session.
- **Failures:** a refusal shown with Waypoint's reason and no checkpoint; an unconfirmed create kept as a checkpoint, recovered with the session shown and bound, and timing out from its attempt; a failed storage write after the create reported as unconfirmed; a password SSH target asked for without retrying, then one create on the next start; a send's stale SSH retry cleared by a start.
- **Origins:** New Session with Settings clears its draft on start and on recovery; a create saved by an earlier version's Edit Current Session still decodes and reconciles; form errors don't point at Quick Chat Defaults; the saved settings and create origins are validated when read back.
