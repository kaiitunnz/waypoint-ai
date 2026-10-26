# Session management acceptance

The macOS Raycast pass used the development extension in two setups.

The isolated pass ran an isolated Waypoint API with a disposable password and data directory. It used Waypoint's actual authentication, sessions, WebSockets, and Codex adapter and plugin. A fake Codex SDK client replaced the agent. A fake password-auth SSH target had its ControlMaster connect and status patched, so no SSH connection was made. Fixture endpoints started long or running turns, raised approvals, stalled a send past the client timeout, revoked sign-in tokens, and made a launch in a missing remote directory fail at spawn. A second isolated server covered server switching.

The real-server pass ran against the user's own Waypoint server:

- **Session:** one Codex session (GPT-6-Luna, low effort, Auto review) was created with the Waypoint CLI in a scratch folder outside any git repository, so it had no worktree. A codeword was planted in its first turn.
- **Targeting:** before every action, Search Sessions was filtered to the session's unique title, and the accessibility tree had to show exactly one row with that title. Actions were chosen by name in the Actions panel and checked by screenshot before confirming.
- **Cleanup:** Raycast deleted the session. Afterwards the server's session list matched its baseline: no other session was missing or changed. Quick Chat was not used on that server.

Both passes drove Raycast with keystrokes and read views through macOS accessibility. Each outcome was checked against the server's session record and events.

## Desktop coverage

| Scenario                                                         | Observed result                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rename a session from the list (both servers)                    | An empty title is rejected in the form; the new title shows in the list and on the server                                                                                                                                 |
| Pin and unpin (both servers)                                     | The row moves between Pinned and Recent Sessions; the action label follows                                                                                                                                                |
| Interrupt a running turn (both servers)                          | Waypoint records the interrupt and the session is interrupted; Interrupt is no longer offered                                                                                                                             |
| Terminate from a conversation                                    | Cancelling the confirmation changes nothing; confirming exits the session, and Reattach and Delete appear                                                                                                                 |
| Terminate from the list                                          | The row leaves the active list; the toast's Show Exited Sessions reveals it                                                                                                                                               |
| Reattach (real server)                                           | The session resumes; a later turn recalls the codeword planted before termination                                                                                                                                         |
| Reattach a session whose restore fails                           | The toast names the failure; the conversation says the session stopped with an error                                                                                                                                      |
| Reattach on a password-auth SSH target that isn't connected      | The form asks for the target's password once; the session reattaches                                                                                                                                                      |
| Delete an exited or failed session (both servers)                | The confirmation lists what is removed; the row disappears and the server no longer has the session                                                                                                                       |
| Delete a session Quick Chat still needs to check                 | Nothing is deleted; the toast says to check Quick Chat first                                                                                                                                                              |
| Use for Quick Chat on a session found in search                  | Quick Chat opens on it and a send lands in that session; the row shows a Quick Chat tag and its action becomes Open in Quick Chat; opening other conversations doesn't move it; Quick Chat continues it until the timeout |
| Read a reply over 4,000 characters in a conversation from search | The whole reply shows, with no truncation note                                                                                                                                                                            |
| A session is deleted elsewhere while its conversation is open    | Within 20 seconds the conversation says the session is gone and hides Edit and session actions                                                                                                                            |
| Answer an approval in Quick Chat                                 | The approval row offers Review Request and the conversation's other actions; approving resumes the agent                                                                                                                  |
| A new chat fails to start in a missing remote directory          | The send is reported unconfirmed with the draft kept; Check Previous Outcome says the session failed to start and points to Quick Chat Defaults; the failed session can then be deleted                                   |
| Raycast closes while a send is unconfirmed                       | Reopening shows the unconfirmed operation and resends nothing; Check Previous Outcome reports no matching input; Allow Explicit Retry sends it once                                                                       |
| Sign-in expires                                                  | Loaded sessions stay listed with a sign-in row; signing in again restores the list                                                                                                                                        |
| The server goes offline and returns                              | Quick Chat explains that the API can't be reached and keeps the draft; Reconnect Chat recovers the same conversation                                                                                                      |
| Switch Quick Chat between servers                                | Each server keeps its own draft                                                                                                                                                                                           |
| Release journey                                                  | Sending, a follow-up, an approval, a title change, Use for Quick Chat, and returning to Quick Chat keep the conversation and draft                                                                                        |

The pass found and fixed:

- The terminate toast had no way to reveal the session the active list hides.
- Action failures were titled "Not done" instead of naming the action.
- A conversation opened from search didn't show that its session had exited or failed.
- Session actions stayed available after the session was deleted elsewhere.
- The failed-start explanation disappeared when its checkpoint cleared.

Not exercised natively:

- Windows. The extension declares Windows; only macOS was exercised.
- Include Selected Text, Include Clipboard, and attachments, which the [desktop inputs acceptance](desktop-inputs-acceptance.md) covers on macOS.
- Recovery after a Waypoint server restart with live sessions. The isolated server does not restore sessions on boot, and the real server was not restarted.
- Delete of a session with a git worktree.

## Automated coverage

`npm run verify` checks formatting, ESLint, strict types, 194 behavior and integration tests, Raycast validation, and build.

Session management tests cover:

- **Eligibility:** actions by status, interface, reattach support, source, and Quick Chat state.
- **Actions:** requests, fresh-state checks that refuse stale rows, SSH password targets, refusals, and unconfirmed outcomes.
- **Delete:** refusal while Quick Chat's checkpoint needs the session, including a failed start, and cleanup of Quick Chat's references when the delete completes.
- **Use for Quick Chat:** the explicit choice, its timeout, resume on one server, and clearing a destination that is gone.
- **Failed starts:** recognizing a session that failed to start, and not mistaking an earlier failure for a retry that is still starting.
- **Live state:** mutation results in the list and deletion noticed while a conversation is open.

## Screenshots

![Session actions](screenshots/session-actions.jpg)
