# Quick Chat lifecycle acceptance

The macOS Raycast pass used the development extension against an isolated Waypoint API with a disposable password and data directory. It ran Waypoint's actual authentication, sessions, WebSockets, and Codex adapter and plugin, with a fake Codex SDK client in place of the agent. The API listened on a loopback address, so it counted as running on this Mac. Fixture endpoints raised an approval, stalled a send past the client timeout, and made a launch in a missing remote directory fail at spawn.

On the user's own Waypoint server, which also runs on this Mac, only read-only checks were made: Quick Chat was opened and its new-conversation panel inspected. Nothing was sent, so its destination and drafts were unchanged.

Raycast was driven with keystrokes and read through macOS accessibility. Outcomes were checked against the server's session records and events, the workspace folder on disk, and the extension's stored keys.

## Desktop coverage

| Scenario                                                     | Observed result                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First send with no working directory                         | The session is titled `Quick Chat <date> <time>` in local time and starts in `~/.waypoint-ai/workspace`; the folder, `AGENTS.md`, and `CLAUDE.md` are created |
| A follow-up                                                  | It goes to the same session                                                                                                                                   |
| A later new session after `AGENTS.md` was edited             | The edit is kept                                                                                                                                              |
| A working directory set in Quick Chat Defaults               | It is used instead of the workspace; the field's placeholder shows the workspace when empty                                                                   |
| Terminate Session                                            | The confirmation explains the effect; the session exits, the toast confirms it, and Quick Chat shows a new conversation with the draft kept                   |
| Reopening Quick Chat after terminating                       | It opens a new conversation; the next send creates a new titled session                                                                                       |
| The terminated session in Search Sessions                    | Shown under exited sessions with Use for Quick Chat, Reattach, and Delete                                                                                     |
| Terminate after the session was deleted elsewhere            | Quick Chat moves to a new conversation and the toast says the session is no longer on the server                                                              |
| A send whose outcome is unconfirmed                          | Terminate Session is not offered until the outcome is checked or retried                                                                                      |
| A new chat that fails to start in a missing remote directory | Check Previous Outcome recognizes the failed session by its new title and explains it                                                                         |
| Remove Server, opened from that server's own Quick Chat      | The confirmation names the Quick Chat data; every stored key for that server is gone, and returning to the open Quick Chat doesn't write them back            |
| Opening Manage Servers                                       | Data left by a server removed earlier is cleared                                                                                                              |
| The real server, read only                                   | A new conversation would start in `~/.waypoint-ai/workspace`                                                                                                  |

Stored keys were checked with temporary logging in a development build, removed afterwards.

Not exercised natively:

- A New Chat send that created a session but never delivered its message, then continued that session. Tests cover the fingerprint that ignores titles.
- A terminate whose result is unconfirmed or refused. Tests cover these.
- A server reached through a tunnel or container on a local port.

## Automated coverage

`npm run verify` checks formatting, ESLint, strict types, 208 behavior and integration tests, Raycast validation, and build.

Tests cover:

- **Titles:** the local-time format, the request title, a fingerprint that ignores titles, and failed-start matching by the stored title, including attempts saved before titles carried a time.
- **Workspace:** loopback detection, the directory precedence, creating the folder and files once without overwriting edits, and a failure that keeps the draft and sends nothing.
- **Terminate:** releasing the destination and bound drafts, a new session on the next send, restoring the destination after a refusal, staying released when the result is unconfirmed or the session is gone, and waiting for an unconfirmed operation.
- **Server data:** removing only removed servers' keys, including damaged state; nothing when the saved servers can't be read; keeping a server saved mid-sweep; and waiting for draft writes in flight.

## Screenshots

The Store screenshots in `metadata/` were recaptured with the new icon.
