# Repository guidance

This is a TypeScript Raycast extension that integrates with Waypoint through HTTP and WebSockets. Manage Servers, Search Sessions, Quick Chat, and New Chat are implemented.

- Before implementing a phase, read the local development plan under `tmp/plans/` when available. That directory is intentionally ignored; use the task or PR description for scope when the plan is absent.
- Keep command entry points thin. Put network contracts in `src/api/`, pure behavior in `src/domain/`, persistence in `src/storage/`, orchestration in `src/hooks/`, and native Raycast presentation in `src/views/` and `src/components/`.
- Use strict TypeScript, two-space indentation, PascalCase components, and camelCase functions. Preserve the Raycast toolchain and use capability descriptors for agent/transport differences.
- Use `<type>/<slug>` branch names, such as `feat/session-conversations`. Follow CONTRIBUTING.md for verification and commits. Commit subjects use `<type>: <description>`, with a space after the colon and a short description in plain language.
- Run `npm run verify` for formatting, ESLint, types, Node tests, Raycast validation, and build. Add focused tests alongside behavior.
- Keep credentials and raw private session data out of source, logs, and fixtures. Resolve preset secrets on the Waypoint server.
