# Contributing

## Setup and checks

Install the locked dependencies with `npm ci`, then run `npm run verify` before committing. The gate runs formatting, ESLint, TypeScript, tests, Raycast validation, and build. Tests include real loopback HTTP requests; Raycast validation fetches its schema and owner metadata.

Use `npm run format` for formatting and `npm run fix-lint` for ESLint fixes. Review their changes before committing. Tests use Node's test runner and TypeScript, with HTTP and storage doubles for focused behavior and loopback servers for network integration. Keep tests in the type-checking gate.

Runtime checks require Raycast and a configured Waypoint server. Use disposable passwords and isolated Waypoint data directories for acceptance checks. Include the scenarios exercised, platform, screenshots, and untested paths in the PR. See [the connection acceptance record](docs/server-connections-acceptance.md) for the current coverage.

## Commits

Use `<type>: <description>` with a space after the colon and a short description in plain language.

Examples:

- `chore: initial commit`
- `feat: add server connections`
- `fix: fix message sending`
- `docs: update setup guide`

Use focused commits and PRs. Include the behavior change, verification results, and relevant screenshots for UI changes in each PR description.

## Dependencies and credentials

Commit `package-lock.json` with dependency changes so installations remain reproducible. Keep passwords, bearer tokens, local environment files, private session content, and unsanitized event captures out of Git. Persist credentials only through Raycast encrypted LocalStorage. Whitelist bootstrap metadata before displaying it; Waypoint responses can contain launch environment values.
