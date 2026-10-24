# Contributing

## Setup and checks

Install the locked dependencies with `npm ci`, then run `npm run verify` before committing.

This repository currently contains scaffolding only. The first command PR must extend verification to cover type checking, Raycast validation, and building. Each later behavior PR should include the focused tests needed to verify that behavior.

Use `npm run format` for formatting and `npm run fix-lint` for ESLint fixes. Review their changes before committing. Runtime checks require Raycast and a configured Waypoint server once those integrations exist.

## Commits

Use `<type>: <description>` with a space after the colon and a short description in plain language.

Examples:

- `chore: initial commit`
- `feat: add server connections`
- `fix: fix message sending`
- `docs: update setup guide`

Use focused commits and PRs. Include the behavior change, verification results, and relevant screenshots for UI changes in each PR description.

## Dependencies and credentials

Commit `package-lock.json` with dependency changes so installations remain reproducible. Keep passwords, bearer tokens, local environment files, private session content, and unsanitized event captures out of Git.
