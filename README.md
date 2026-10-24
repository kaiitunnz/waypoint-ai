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

The conversation opens at the latest user/assistant exchange, with formatted responses at full width. Previous/Next Exchange navigates turns. Copy Response copies the current answer. Conversation Details shows server-reported context and token usage.

**Conversation History** opens the detailed event inspector with paired tool activity, filtering, older history, and follow-latest controls.

Pending questions appear above the exchange. Use Open in Waypoint for approvals and answers. Older approval details may be outside the loaded history. Native approvals, answers, and sending to sessions opened from search are planned for subsequent changes.

Reconnects recover missed events and preserve loaded history. Expired sign-in offers reauthentication. The conversation content remains in memory and is not saved to extension storage.

![Conversation reader](docs/screenshots/session-conversation.png)

## Quick Chat

Type in the top message field and press Enter to send. The draft and transcript share one screen. Each history row groups a user turn with its assistant response; selecting an older turn keeps the draft visible. Sending returns to the latest turn. Activity details, response copying, full-width reading, and session information are available in Actions.

![Quick Chat](docs/screenshots/quick-chat.png)

Quick Chat continues its own conversation for each saved server. The default timeout is 30 minutes after the last successful user send. Running work and unresolved approvals, questions, or plans keep their conversation. **Quick Chat Defaults** offers Always Continue, Always New, and a configurable timeout. **New Chat** and **Start New Chat** prepare a fresh conversation; creation happens on first send, and existing sessions keep running.

Defaults apply to new conversations. Choose the server preset, execution target, working directory, agent, model, and effort. Advanced settings expose supported transport, account profile, permissions, arguments, and configuration overrides. Inherited settings and private preset values are resolved by Waypoint. Each saved server keeps its own defaults and draft.

Drafts survive closing the command. Reopening catches up with Waypoint without resending. Rejected sends keep the draft and an already-created session. **Interrupt Session** is explicit; exited sessions reattach before sending when their transport supports it.

An unconfirmed operation blocks further sends. **Check Previous Outcome** inspects the session and history without resending. Matching recorded input does not establish agent delivery. **Allow Explicit Retry** warns that another attempt may duplicate work. **Abandon Attempt and Start New Chat** discards the local checkpoint after confirmation; existing sessions keep running. Coordination covers extension commands on this computer, not other devices.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor guidance and [connection acceptance](docs/server-connections-acceptance.md) [conversation acceptance](docs/session-conversations-acceptance.md), and [Quick Chat acceptance](docs/quick-chat-acceptance.md) for runtime coverage.
