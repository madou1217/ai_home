# Server Runtime Architecture

## Goal

Keep server behavior implemented in one place only, so CLI entry changes do not fork runtime behavior.

## Single Execution Chain

`aih server ...` now follows this path:

1. `lib/cli/app.js`
2. `lib/server/entry.js`
3. `lib/server/command-handler.js`
4. `lib/server/server.js` and other `lib/server/*` modules

`app.js` is only an adapter for wiring process/runtime dependencies.

## Ownership Boundaries

- `lib/cli/app.js`
  - CLI argument top-level dispatch.
  - Dependency wiring (fs/http/process paths, daemon adapters).
  - Must not implement server request routing/business logic.

- `lib/server/entry.js`
  - Composition layer.
  - Bridges injected dependencies to command/runtime modules.

- `lib/server/command-handler.js`
  - `server` subcommand behavior (`start/stop/status/restart/serve/sync-codex/env`).

- `lib/server/server.js`
  - HTTP server runtime.
  - request handling, health/readiness, auth checks, management + v1 routing.
  - owns `account_state.db` mutation lifecycle (single-writer).

- `lib/server/*` (others)
  - upstream routing, metrics, management payloads, args parsing helpers.

## Contribution Rules

- If behavior is visible at server runtime, change `lib/server/*`, not `lib/cli/app.js`.
- Do not add direct SQLite writes in CLI paths; use `/v0/management/state-index/*`.
- If adding a new `aih server` action, implement command semantics in `lib/server/command-handler.js`.
- If adding startup wiring dependencies, update `lib/server/entry.js` and its tests.
- Keep smoke coverage in `test/server.smoke.test.js` for user-visible HTTP behavior.

## Refactor Safety Checklist

- Run:
  - `node --test test/server.entry.test.js test/server.smoke.test.js test/server.v1-router.test.js`
  - `npm test`
- Verify `aih server serve` still exposes:
  - `/healthz`
  - `/readyz`
  - `/v0/management/*`
  - `/v1/*`
