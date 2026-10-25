# Waypoint AI

Connect Raycast to your [Waypoint](https://github.com/kaiitunnz/waypoint) servers. **Quick Chat** sends messages to a dedicated conversation. **New Chat** starts fresh. **Search Sessions** reads live conversations, and **Manage Servers** configures your connections.

![Manage Servers](docs/screenshots/manage-servers.png)

## Setup

1. Run a Waypoint API server and note its API URL and server password.
2. Run this extension in Raycast and open **Manage Servers**.
3. Choose **Add Server**, enter a name and API URL, and save. Add a frontend URL if you want **Open in Waypoint** browser handoff.
4. Choose **Sign in** and enter the Waypoint server password.

The API URL must include `http://` or `https://`. Use its final address: redirects are rejected to protect credentials. Embedded credentials, query strings, and fragments are rejected. URL paths are supported for APIs behind a reverse proxy.

Local execution runs on the API server's machine. SSH execution targets are discovered from that server; they are separate from your saved API connections.

## Managing connections

Select a row to inspect a server. **Use Server** changes the active connection; **Make Default Server** chooses the fallback when the active connection is removed. Reopening restores the active connection. A blue check marks the active server; a star marks the default.

Use Actions to edit, retry, sign in again, remove a connection, or open its configured frontend. Common shortcuts include Add, Edit, Refresh, and Remove. Sign in uses Command-Shift-L on macOS / Control-Shift-L on Windows; Make Default uses Command-Shift-D / Control-Shift-D.

Reauthentication preserves the connection's identity and setup. Changing its API URL creates a fresh identity and requires sign-in, including when returning to a previously used URL. Removing a connection clears its saved credentials and leaves sessions running on Waypoint.

Bearer tokens are kept in [Raycast's encrypted local storage](https://developers.raycast.com/api-reference/storage). Passwords are used only during sign-in. Connection failures preserve the saved configuration; use Retry Connection or Sign in Again to recover. Unknown or damaged saved-data formats are reported without overwriting the original data.

## Search Sessions

Find sessions by title, working directory, repository, branch, agent, or status. The server dropdown switches API connections and keeps the current search. Pinned sessions appear first. Show Exited Sessions includes finished sessions; Show Only Exited Sessions narrows the list to them. Protected assistant and telemetry sessions are excluded.

Open structured sessions in the native conversation reader. Terminal and unknown interfaces offer Open in Waypoint using the configured frontend URL.

![Search Sessions](docs/screenshots/search-sessions.png)

The conversation displays loaded user and assistant turns together in chronological order, with formatted responses at full width. Show Latest Response focuses the newest turn when needed. Copy Latest Response copies the current answer. Conversation Details shows server-reported context and token usage.

**Conversation History** opens the detailed event inspector with paired tool activity, filtering, older history, and follow-latest controls.

Sending to sessions opened from search is planned for a subsequent change.

Reconnects recover missed events and preserve loaded history. Expired sign-in offers reauthentication. The conversation content remains in memory and is not saved to extension storage.

![Conversation reader](docs/screenshots/session-conversation.png)

## Approvals and questions

Pending approvals, plan approvals, and agent questions appear under **Needs Attention** above the conversation in Quick Chat, the conversation reader, and Conversation History. Review a request to see its context and respond: approvals offer the decisions the agent supports and an optional note where supported; plans accept a note; questions take single or multiple choices, notes, and free-text answers. Answers in progress are saved, so closing the form keeps them. **Cancel Question** tells the agent to continue without an answer; closing the form does not.

A form stays bound to the request it opened. If the request is answered elsewhere or replaced, the form shows that and sends nothing. Requests the agent's interface cannot handle natively, such as unsupported question formats or requests without a stable ID, offer **Open in Waypoint**.

If Waypoint does not confirm a response, nothing is retried. **Check Previous Outcome** shows whether the request is still pending. **Clear Checkpoint** continues once it is resolved; **Allow Another Attempt** warns that responding again can repeat its effect. Until then, other responses and Quick Chat sends on that server wait.

![Approval decisions](docs/screenshots/interaction-approval.jpg)

## Quick Chat

Type in the top message field and press Enter to send. Follow-ups continue the same Waypoint session. The transcript keeps loaded turns together in chronological order, alongside the draft. The conversation row shows its turn count; Latest Response is an optional focused view. Sending returns to the continuous conversation. Activity details, copying or pasting the latest response, full-width reading, and session information are available in Actions. The side panel shows the first 4,000 characters of a very long message; full-width reading shows all of it.

![Quick Chat](docs/screenshots/quick-chat.jpg)

Quick Chat continues its own conversation for each saved server. The default timeout is 30 minutes after the last successful user send. Running work and unresolved approvals, questions, or plans keep their conversation. **Quick Chat Defaults** offers Always Continue, Always New, and a configurable timeout. **New Chat** and **Start New Chat** prepare a fresh conversation; creation happens on first send, and existing sessions keep running.

Defaults apply to new conversations. Choose the server preset, execution target, working directory, agent, model, and effort. Advanced settings expose supported transport, account profile, permissions, arguments, and configuration overrides. Inherited settings and private preset values are resolved by Waypoint. Each saved server keeps its own defaults and draft.

Drafts survive closing the command. Reopening catches up with Waypoint without resending. Rejected sends keep the draft and an already-created session. **Interrupt Session** is explicit; exited sessions reattach before sending when their transport supports it.

Sends to one server run one at a time across extension commands. A command waits a few seconds for another one's send to finish; a command that stopped mid-send releases the server after 30 seconds.

An unconfirmed operation blocks further sends. **Check Previous Outcome** inspects the session and history without resending. Matching recorded input does not establish agent delivery. **Allow Explicit Retry** warns that another attempt may duplicate work. **Abandon Attempt and Start New Chat** discards the local checkpoint after confirmation; existing sessions keep running. Coordination covers extension commands on this computer, not other devices.

## Composing messages

**Compose Message** opens a multiline form for the current Quick Chat or New Chat destination, which it names at the top. Text already typed in the message field moves into an empty draft. Each saved server keeps one compose draft for Quick Chat and one for New Chat; closing the form keeps it, and **Discard Draft** removes it.

**Include Selected Text** and **Include Clipboard** read the selection or clipboard once and stage it in the form, where it can be reviewed or removed before sending. Each item is sent verbatim in a fenced block after the message. An item can be up to 256 KB, and a draft can hold up to 1 MB.

Files and images can be attached when the agent accepts attachments. They upload to Waypoint when you send, up to 25 MB each, and the message carries the uploaded files. Agents on a remote execution target receive only the files Waypoint can deliver there: OpenCode takes files and images, Claude Code takes images, and other agents take none. If a send fails, the draft keeps its files, and uploads that are still valid are reused on retry.

![Compose Message](docs/screenshots/compose-message.jpg)

When a send needs a password-auth SSH target that is not connected, **Connect SSH Target** asks for its password. Waypoint uses it once to connect, then the send or reattach continues. The password is not saved.

## Development

Use Node.js 22 or newer and npm. Raycast is required to run the extension.

```sh
npm ci
npm run dev
```

Run the full gate before committing:

```sh
npm run verify
```

The gate checks formatting, ESLint, strict TypeScript, behavior and HTTP integration tests, Raycast manifest/icon validation, and the extension build. HTTP tests require permission to bind loopback sockets; Raycast validation requires network access. `npm test` runs the focused tests separately.

Source is organized into thin command entries, `api/`, `domain/`, `storage/`, `hooks/`, `views/`, and `components/`. Tests compile into an ignored temporary build directory using the installed TypeScript compiler and Node's test runner.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor guidance and [connection acceptance](docs/server-connections-acceptance.md), [conversation acceptance](docs/session-conversations-acceptance.md), [Quick Chat acceptance](docs/quick-chat-acceptance.md), [session interactions acceptance](docs/session-interactions-acceptance.md), and [desktop inputs acceptance](docs/desktop-inputs-acceptance.md) for runtime coverage.
