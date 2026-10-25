# Session settings acceptance

The macOS Raycast pass used the development extension in two setups.

The isolated pass ran an isolated Waypoint API with a disposable password and data directory. It used Waypoint's actual authentication, sessions, launch settings, restarts, and the Codex adapter and plugin. A fake Codex SDK client replaced the agent. A fake password-auth SSH target had its ControlMaster connect and status patched, so no SSH connection was made. Fixture middleware rejected one model change or returned one lifecycle conflict on demand.

The real-server pass ran against the user's own Waypoint server:

- **Sessions:** a Codex session (GPT-6-Luna, low effort, Auto review) and a Claude Code session were created in a scratch folder with the Waypoint CLI. Their IDs were recorded, and they were deleted afterwards; the server's session list matched its baseline.
- **Raycast state:** the conversations were opened from Search Sessions, so Quick Chat's state on that server was not touched. The active server was restored afterwards.

Both passes drove Raycast with keystrokes and read the form through macOS accessibility. Each outcome was checked against the session record, its launch settings, and its system events.

## Desktop coverage

| Scenario                                                                     | Observed result                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change the title and effort of a Codex session (real server)                 | The preview reads "Applies now: title, effort."; both apply without a restart or confirmation                                                                                                                                                                       |
| Add an environment variable to a Codex session (real server)                 | The preview and a confirmation say the session restarts and resumes; Waypoint records the restart and the new key, never the value; a follow-up recalls earlier context                                                                                             |
| Change effort on Claude Code's native interface (real server)                | The preview says the session restarts and resumes; the interface options are Claude Code and Claude TUI, without the terminal interface                                                                                                                             |
| Stage a restart while a turn is running                                      | The preview adds "The current turn will be interrupted."                                                                                                                                                                                                            |
| A later change fails after the title applied                                 | The form shows "Partly applied", names the applied title and the rejected model change, and the preview lists only the model; applying again sends only the model                                                                                                   |
| Waypoint reports another lifecycle operation                                 | Nothing is applied, the form says to wait and apply again, and the retry succeeds                                                                                                                                                                                   |
| Restart a session on a password-auth SSH target that isn't connected         | The form names the target; Connect SSH Target takes the password once; applying again restarts the session                                                                                                                                                          |
| Change the working directory from a Search Sessions conversation             | The action becomes Start New Chat with These Settings; a New Chat for that server opens in the new folder, and the first send creates the session there; while it is open, Raycast keeps no live connection for the conversation underneath, and Back reconnects it |
| Change the working directory from Quick Chat                                 | Quick Chat prepares a new conversation in the new folder; the previous session keeps running                                                                                                                                                                        |
| Type a custom model ID                                                       | The model dropdown shows it as a custom choice while typing, and applying sets it on the session                                                                                                                                                                    |
| Type a custom model ID in Quick Chat Defaults that passes through listed IDs | The whole ID stays in the field and the model dropdown shows it as a custom choice                                                                                                                                                                                  |

The pass found and fixed:

- The editor losing its state because its parent rebuilt the connection on every render.
- A typed custom model being reset by the model dropdown on each keystroke, in the editor and in Quick Chat Defaults.

After Connect SSH Target closes, keyboard focus does not return to a form field, so a shortcut submits only after a field is focused.

Not exercised natively:

- Account profile switching, which would move a real session between accounts.
- Interface switching and usage-source changes.
- An apply whose restart outlasts the form.
- Restore failures and reattach.
- Windows.

Unit and integration tests cover these paths.

## Automated coverage

`npm run verify` checks formatting, ESLint, strict types, 168 behavior and integration tests, Raycast validation, and build.

Session settings tests cover:

- **Plans:** change plans for Codex, Claude Code's native and TUI interfaces, and OpenCode, including Waypoint's own captured capability catalog. They also cover restart counting, interruptions, and status gating.
- **Values and choices:** default and custom model choices, the three effort states, and dropdowns that always include the current value.
- **Environment:** protected keys, and variable validation.
- **Applying:** the exact request order and bodies; partial success with step-wise replanning; lifecycle, starting, and SSH conflicts; restore failure and reattach; unconfirmed restarts; and settings or capabilities that changed elsewhere.
- **New chats:** defaults that keep agent-default meanings and only supported arguments, and the next session created with them.

## Screenshots

![Edit Current Session](screenshots/edit-session.jpg)

![Restart confirmation](screenshots/edit-session-restart.jpg)
