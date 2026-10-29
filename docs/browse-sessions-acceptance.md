# Browse Sessions acceptance

The macOS Raycast pass used the development extension against an isolated Waypoint API with a disposable password and data directory, added as a temporary server and removed afterwards. It ran Waypoint's actual authentication, sessions, attachments, WebSockets, and Codex adapter, with a fake Codex SDK client in place of the agent. Raycast was driven with keystrokes, and outcomes were checked in screenshots, the accessibility tree, and the input events Waypoint stored. The user's own Waypoint server was not used.

## Desktop coverage

| Scenario                                                                            | Observed result                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Open Conversation on a session Quick Chat doesn't use                               | A chat with a message field opens on that session                                                                                                                              |
| Send from the message field                                                         | Waypoint records the message in that session only                                                                                                                              |
| Type a draft, close Raycast, reopen the session                                     | The draft is restored; another session's chat and Quick Chat have empty message fields                                                                                         |
| Open Quick Chat afterwards                                                          | Quick Chat shows its own new conversation; its destination is unchanged                                                                                                        |
| Compose Message with a file                                                         | The form names the session as its destination; the text and `notes.txt` reach the session as an attachment                                                                     |
| Send to an exited session whose interface can resume it                             | Raycast reattaches the session, then sends; the session runs again with the message                                                                                            |
| Send to an exited session Waypoint can't restore                                    | Waypoint's refusal is shown and the draft is kept; nothing is sent                                                                                                             |
| Actions in a session chat                                                           | Compose, include, and Reconnect Chat actions, then Change Session Settings, Rename, Pin, Interrupt, and Terminate, each once                                                   |
| ⌘N in Browse Sessions, then ⌘⇧N                                                     | New Chat opens on the browsed server, and New Session with Settings opens from it                                                                                              |
| Stage about 1 MB of clipboard context in each of three session chats, then send one | Each save took 8–64 ms as the server's saved Quick Chat data grew to 3 MB; the send's checkpoint save took 78 ms at 4.1 MB, and the 1,020,102-character message arrived intact |

Save times were read from a temporary log in the development build.

![Browse Sessions](screenshots/browse-sessions.jpg)

![Session chat](screenshots/session-chat.jpg)

Not exercised natively: an approval in a session chat, an unconfirmed operation started in one chat and checked from another, a session deleted while its chat is open, a session whose interface can't take messages, and a password SSH target. Tests cover them.

## Automated coverage

`npm run verify` checks formatting, ESLint, strict types, 303 behavior and integration tests, Raycast validation, and build.

Tests cover:

- **Sending:** a session chat sends to its session without creating one or changing Quick Chat's destination; an exited session is reattached first with the restart timeout; a session that ended without a way to resume, or uses a terminal interface, stays readable and sends nothing; that state follows the session as it changes.
- **Drafts:** each session keeps its own message and compose drafts, apart from other sessions, other servers, and Quick Chat; deleting a session removes them, as does a chat finding its session deleted elsewhere, and a chat left open on it doesn't save them again.
- **Unconfirmed operations:** a session chat's unconfirmed send is shown in Quick Chat without switching its conversation, and the reverse; checking names the other session; clearing another chat's operation keeps Quick Chat's destination; only the chat that started an operation can allow a retry; an interaction response belongs to no chat; uploads another chat dropped when clearing aren't written back.
- **Scope:** starting, ending, and new chats stay with Quick Chat; a session chat whose session is gone never switches to a session Quick Chat recovers; the staged parts of several session chats stay one bounded saved value.
