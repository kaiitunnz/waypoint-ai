# Waypoint Inbox acceptance

The macOS Raycast pass used the development extension against an isolated Waypoint API with a disposable password and data directory, added as a temporary server and removed afterwards. It ran Waypoint's actual authentication, inbox, attachments, wake subscriptions, WebSockets, and Codex adapter, with a fake Codex SDK client in place of the agent. Items were synthetic and posted through Waypoint's inbox runtime, from a fake session with an inbox wake subscription and as a person. The fake agent never finishes a turn, so a fixture marked its session idle before each check that a wake was delivered. Raycast was driven with keystrokes, and outcomes were checked in screenshots, the accessibility tree, and the items, attachments, and session inputs Waypoint stored. The previously active server was restored; the user's own servers were not used for the pass.

## Desktop coverage

| Scenario                                                                  | Observed result                                                                                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Waypoint Inbox                                                       | Only open items, with the server's open count; tags read “1 question” and “1 approval”                                                       |
| Show Resolved Items (⌘⇧E), then hide them again                           | The Resolved section appeared below Open, then went away; Delete Resolved Items was offered only while it was shown                          |
| Approve an item while resolved items are hidden                           | Waypoint resolved it and it left the list; with them shown, it moved to Resolved and stayed selected                                         |
| Wait on the row Raycast selects on open, and on the first row of a search | Neither item was marked read                                                                                                                 |
| Move to an item with nothing to answer and stay                           | Waypoint marked it read and resolved it after the dwell; the row moved to Resolved, which was shown                                          |
| Restart the Waypoint API while the inbox is open, then post items         | The list reconnected and reloaded; new items appeared live and the open count followed                                                       |
| Answer a single-choice question with notes                                | Waypoint stored the option and the notes, resolved and read the item, and woke the posting session                                           |
| Answer a multiple-choice question with two options and no notes           | Waypoint stored both options and no reply, and woke the session                                                                              |
| Approve, then Change Decision to Deny                                     | Waypoint stored each decision; the first resolved the item and woke the session                                                              |
| Reply with notes and a generated file                                     | Waypoint stored the notes and the file by name, pinned the upload in the posting session, and woke the session                               |
| Reply again with new notes                                                | The form opened with the earlier notes and listed the earlier file; Waypoint stored the new notes with the same file                         |
| Reply to an item a person posted                                          | The form offered notes only                                                                                                                  |
| Choose an item from the menu bar                                          | The menu read “Inbox E2E · 5 open” with the five subjects and senders; the chosen item opened selected in Waypoint Inbox and was marked read |
| Open the item with an attachment block                                    | The detail named the attachment                                                                                                              |
| Open Session                                                              | The posting session's conversation opened, showing the wake input                                                                            |
| Delete Item, and delete another item in Waypoint                          | Both left the server and the list                                                                                                            |
| With resolved items shown, Delete Resolved Items                          | Waypoint removed every resolved item; only open ones remained                                                                                |

Waypoint wakes a session for a change made while it's busy once it's idle again; wakes for items a person posted go to no session.

Not exercised natively: a submit Waypoint doesn't confirm, an answer Waypoint rejects, an upload to a deleted posting session, closing a form after an unconfirmed reply, and Open in Waypoint (the temporary server had no frontend URL). Tests cover the first four.

## Automated coverage

`npm run verify` checks formatting, ESLint, strict types, 364 behavior and integration tests, Raycast validation, and build.

Inbox tests cover:

- **Parsing:** every block kind, unknown blocks kept as unsupported, items a person posted, pages, and live updates.
- **Presentation:** tags count only unanswered required blocks of open items; the detail shows options, chosen answers, other answers, decisions, replies, and attachment names; search matches subjects and senders.
- **Answers:** checks that mirror Waypoint's; a reply is sent only with notes or files and carries the earlier files; the form opens on a saved draft, else on the current answer and reply.
- **Loading:** Resolved loads only while shown, then as soon as Open is exhausted; paging and searches; repeated items and items moved between sections appear once; an item deleted while a page loads stays deleted; live updates insert, move, or wait for paging; a reconnect reads the first pages again; an item opened from the menu bar loads even when paging hasn't reached it.
- **Reading:** Raycast's own selections, including after a delete, a search, or a selection the view makes, never mark an item read; a move the user makes marks it once after the dwell.
- **Outcomes:** an unconfirmed submit is settled by reading the item back, for answers, replies, and approvals; uploads are reused across retries, deleted when a submit definitely failed, and kept when closing after an unconfirmed reply that can't be checked; drafts are removed after sending and with their item.
- **Menu bar:** open items, none, sign-in, an unreachable server, and no server.

## Screenshots

![Waypoint Inbox](screenshots/inbox.jpg)

![Answer Question](screenshots/inbox-answer.jpg)
