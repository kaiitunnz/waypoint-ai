# Contributing

## Setup and checks

Install the locked dependencies with `npm ci`, then run `npm run verify` before committing. The gate runs formatting, ESLint, TypeScript, tests, Raycast validation, and build. Tests include real loopback HTTP requests; Raycast validation fetches its schema and owner metadata.

Use `npm run format` for formatting and `npm run fix-lint` for ESLint fixes. Review their changes before committing. Tests use Node's test runner and TypeScript, with HTTP and storage doubles for focused behavior and loopback servers for network integration. Keep tests in the type-checking gate.

Runtime checks require Raycast and a configured Waypoint server. Use disposable passwords and isolated Waypoint data directories for acceptance checks. Include the scenarios exercised, platform, screenshots, and untested paths in the PR. See [connection acceptance](docs/server-connections-acceptance.md), [conversation acceptance](docs/session-conversations-acceptance.md), [Quick Chat acceptance](docs/quick-chat-acceptance.md), [session interactions acceptance](docs/session-interactions-acceptance.md), [desktop inputs acceptance](docs/desktop-inputs-acceptance.md), [session settings acceptance](docs/session-settings-acceptance.md), [session management acceptance](docs/session-management-acceptance.md), [Quick Chat lifecycle acceptance](docs/quick-chat-lifecycle-acceptance.md), [long session acceptance](docs/long-session-acceptance.md), and [tool activity acceptance](docs/tool-activity-acceptance.md) for coverage.

## Branches and commits

Name feature branches `<type>/<slug>`, for example `feat/session-conversations` or `fix/session-reconnect`. Start each PR from the merged default branch.

Use `<type>: <description>` with a space after the colon and a short description in plain language.

Examples:

- `chore: initial commit`
- `feat: add server connections`
- `fix: fix message sending`
- `docs: update setup guide`

Use focused commits and PRs. Include the behavior change, verification results, and relevant screenshots for UI changes in each PR description.

## Dependencies and credentials

Commit `package-lock.json` with dependency changes so installations remain reproducible. Keep passwords, bearer tokens, local environment files, private session content, and unsanitized event captures out of Git. Persist credentials only through Raycast encrypted LocalStorage. Whitelist bootstrap metadata before displaying it; Waypoint responses can contain launch environment values.
