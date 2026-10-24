# Waypoint AI

A Raycast extension for quick chat and session management through [Waypoint](https://github.com/kaiitunnz/waypoint).

## Status

The repository contains the project skeleton. Application commands will be registered as their implementation lands.

The agreed first release includes:

- Quick Chat with timed reuse, always-new, and always-continue modes.
- Multiple saved Waypoint servers, with one Quick Chat setup per server.
- A native split-view conversation with streaming, approvals, and questions.
- Session browsing, supported session settings, and lifecycle actions.
- Multiline input, explicit selected-text/clipboard context, and supported attachments.

Quick Chat uses dedicated ordinary sessions. Timed reuse defaults to 30 minutes since the last successful user message and preserves ongoing work. Quick Chat defaults affect future sessions; editing a current session is a separate action.

## Development

Use Node.js 22 or newer and npm. Raycast is required to develop and exercise extension commands.

```sh
npm ci
npm run verify
```

The initial verification gate checks formatting and ESLint. Type checking, Raycast manifest validation, and the extension build become applicable when the first command is introduced; that PR must add them to the gate. Automated tests will be introduced with the first testable behavior.

Once a command exists, the available development commands include:

```sh
npm run dev
npm run typecheck
npm run lint:extension
npm run build
```

## Layout

Only directory placeholders exist under the source and test folders:

```text
assets/             Packaged extension assets
src/
  api/              Waypoint HTTP and WebSocket integration
  components/       Reusable Raycast presentation
  domain/           Pure policies, transcript processing, and settings planning
  hooks/            React state and subscription orchestration
  storage/          Versioned local connection, session, and draft state
  views/            Raycast command screens and forms
tests/
  fixtures/         Sanitized API and event examples
```

The local PR-oriented development plan lives under `tmp/plans/`. The entire `tmp/` directory is intentionally ignored by Git.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and the commit convention.
