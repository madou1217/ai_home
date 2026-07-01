# Repository Guidelines

> This is the single source of truth for agent/contributor guidance in this repo. `CLAUDE.md` intentionally links here instead of duplicating content.

## Project Overview
`ai-home` (`aih`) manages multi-account sandboxed runs of Codex / Claude / Gemini / Antigravity (agy) and exposes them uniformly as one OpenAI/Anthropic-compatible gateway. Core capabilities: per-`(account, model)` routing and circuit-breaking, model-alias fallback, persistent tmux CLI sessions, and a React WebUI.

## Project Structure & Module Organization
- `lib/` contains runtime code, CLI commands, server logic, and service modules.
- `lib/cli/commands/` holds command routers and command entry logic.
- `lib/cli/services/` holds business logic (import/export, PTY, account orchestration, etc.).
- `lib/cli/bootstrap/` wires dependencies between commands and services.
- `test/` contains Node test files (`*.test.js`) covering CLI, backup, PTY, server, and wiring behavior.
- `bin/ai-home.js` is the CLI executable entry.
- Root documentation is intentionally limited to `AGENTS.md` and `README.md`.

Fuller layer map:
- `bin/` — CLI executable entry (`ai-home.js` → `lib/cli/app.js`).
- `lib/cli/app.js` — composition root: imports all bootstrap wiring, dispatches commands.
- `lib/cli/commands/` — command routers (root, ai-cli, backup).
- `lib/cli/services/` — business logic (PTY, account orchestration, import/export, server daemon).
- `lib/cli/bootstrap/` — dependency injection via explicit factory functions, no IoC container.
- `lib/cli/config/` — constants, paths, feature flags.
- `lib/server/` — gateway engine (~143 files): request ingestion → protocol translation → provider routing → circuit-breaking.
- `lib/account/` — account domain: loading, identity, state cache, cross-host sync.
- `lib/sessions/` — session reading: `session-reader.js` parses each provider's history.
- `lib/runtime/` — platform abstraction: `persistent-session.js` (tmux), `pty-launch.js`.
- `lib/usage/` — usage tracking, pricing, cycle scheduling.
- `lib/protocol/` — SSE parsing, tool-call adaptation, token counting.
- `web/src/` — React WebUI (pages + hooks + services).
- `cli/src/` — vendored Claude Code (Bun/TypeScript, independent tech stack).
- `test/` — all test files (`*.test.js`, ~155).

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm test`: run full test suite (`node --test test/*.test.js`).
- `node --test test/backup.router.test.js`: run a focused test file during iteration.
- `node bin/ai-home.js --help`: verify CLI bootstrap and command wiring.
- `npm run postinstall`: repair local executable permissions/hooks (already runs after install).
- `npm run web:dev`: WebUI dev server (`cd web && npm run dev`, Vite).
- `npm run build`: build the WebUI (`cd web && tsc && vite build`).
- `cd web && npm run lint`: lint the WebUI.

## Coding Style & Naming Conventions
- Main body (`lib/`): Node.js CommonJS (`require`, `module.exports`).
- Formatting style in repo: 2-space indentation, semicolons, single quotes.
- File names use kebab-case (for example `account-import-orchestrator.js`).
- Prefer small, composable functions; avoid feature growth in one large file.
- `cli/`: TypeScript ESM, run by Bun (vendored Claude Code source — do not modify unless necessary).
- `web/`: TypeScript + React 18 + Ant Design + Vite, ESM.

## Architecture & Layering Principles
- Enforce separation of concerns: each module should have one clear responsibility (composition, domain logic, integration, or I/O).
- Keep orchestration and business logic separate. Flow control modules should delegate behavior to focused service modules.
- Depend inward on abstractions, not outward on concrete implementation details. Avoid circular dependencies across layers.
- Add new behavior by extending focused modules, not by growing “god files.”
- Refactor trigger: if a file mixes unrelated responsibilities or becomes difficult to test in isolation, split it before further feature work.
- Exceptions must be explicit in PR notes, including why boundary-preserving design was not feasible and what follow-up refactor is planned.

## Agent Runtime Compatibility & Advisor Semantics
- Treat `advisor` as a workflow intent (`independent_review_intent`), not as a guaranteed concrete tool name.
- Never hard-fail solely because a copied Claude/Antigravity prompt references an unavailable `advisor` tool. Resolve the intent through the runtime capability chain first.
- Resolution order: `reviewer_subagent` -> `native_review` -> `self_review` -> `plan_check` -> `warning_noop`.
- `warning_noop` must be explicit and observable; do not silently skip review semantics.
- For high-risk operations (commit, push, destructive file/database changes, production API calls, permission/config mutation), missing reviewer/advisor capability must trigger explicit human confirmation or a documented bypass.
- Keep this compatibility in a focused adapter/resolver layer. Do not scatter `advisor`/`review` string replacements across provider launch code, protocol routers, or prompt templates.
- Preferred design: map runtime-specific tool names into stable workflow intents, then map those intents to the current provider's available capability. Tool aliases handle executable tools; workflow aliases handle stages such as plan, review, self-verify, and advisor.
- Preserve the canonical protocol direction: client protocol -> canonical request/intent -> account/model router -> upstream/provider adapter -> canonical result/events -> client renderer.

## Design Pattern Reporting Requirement
- After completing any non-trivial optimization, compatibility change, architecture change, or runtime behavior change, the final report must list where design patterns were used.
- Required format: `file/module -> pattern -> why it was used -> verification evidence`.
- This section defines the reporting rule only. Do not write task-specific pattern inventories or completion results into `AGENTS.md` or `CLAUDE.md`; put them in the final response or PR notes unless the user explicitly asks to update documentation.
- If no design pattern was appropriate, state that explicitly and explain why KISS/YAGNI rejected adding one.
- Pattern claims must be tied to actual changed code or documentation. Do not claim generic SOLID/Clean Code compliance without pointing to the concrete boundary, module, or abstraction.
- At minimum, review each change against SOLID, KISS, DRY, and YAGNI before reporting completion.

## Persistent sessions (tmux integration)
- Goal: a CLI session started locally (`aih claude 1`) survives the foreground client and can be re-attached later — e.g. SSH back into the same host and run `aih claude 1` again to land in the same live session.
- **tmux is the engine; we never reinvent a multiplexer.** `lib/runtime/persistent-session.js` only wraps the inner `{command, args}` from `spawnPty` into a tmux attach-or-create: `tmux -L <socket> [-f conf] new-session -A -D -s <session> -c <cwd> -- <cmd> <args>`.
- Addressing model (this is what makes one account run many concurrent windows):
  - **socket = per account** (`aih-<provider>-<id>`): one tmux server per account, created with that account's fully isolated env, so credentials never cross account boundaries (reinforces the isolation model). Secrets ride the process env only — never tmux `-e`/argv (would leak to `ps`).
  - **session = per project (default) or explicit label**: default session name is `p-<basename>-<hash(cwd)>` so each project dir auto-reattaches; `-S <label>` / `--session <label>` (or `AIH_SESSION=<label>`) opens an additional named window (`s-<label>`). A single account server thus holds many independent sessions — many projects in parallel, many windows per project.
  - `new-session -A -D` attaches the *exact* session if present (detaching only that session's other client, so an SSH takeover is clean) else creates it; other sessions keep running concurrently.
  - A generated transparent `tmux.conf` (`status off`, `window-size latest`, `escape-time 0`) keeps tmux invisible under the aih overlays.
- Discovery / re-attach UX: `aih <provider> sessions [id]` lists an account's live sessions and prints the exact re-attach command for each.
- Gating: best-effort — applied only when a tmux engine is found, stdout is a TTY, the run is not a login/oauth flow, and `AIH_PERSIST_ACTIVE` is unset (avoids nesting). Escape hatch: `AIH_NO_PERSIST=1`.
- Cross-platform: the engine is real tmux on macOS / Linux / WSL. On **native Windows** `detectTmux()` looks for a tmux-compatible binary — `psmux` (native ConPTY, speaks tmux's CLI) first, then an MSYS2/Cygwin `tmux.exe` (`C:\msys64\usr\bin`, `C:\cygwin64\bin`) or anything named `tmux` on PATH. If none is found, persistence degrades to a plain direct spawn and `sessions` prints an install hint (psmux / MSYS2). The Windows wiring is implemented but needs validation on a Windows host.

## Gateway & Account Internals
- Gateway routing (`lib/server/`): request enters → `router.js` (account selection + failure/success accounting) → `capability-router.js` (route by provider capability) → `protocol-*.js` (OpenAI/Anthropic/Gemini protocol translation) → upstream.
- Account unique identity: `accountId` is only a mutable CLI-internal index; the persisted truth is `unique_key` (email for OAuth accounts, url+keyhash for API-key accounts). Single source: `lib/account/account-identity.js`.
- Model alias + circuit-breaking: aliases resolve fallback at runtime and `/v1/models` does not expose the wildcard `claude-*`; 429s trip a circuit breaker at `(account, model)` granularity rather than locking the whole account.
- WebUI real-time push: `session-event-bus.js` → `webui-sse-broadcaster.js` → browser SSE connection.

## Testing Guidelines
- Framework: built-in Node test runner (`node:test`) with `assert/strict`.
- Name tests by behavior, e.g. `test('runGlobalAccountImport reports provider progress callback', ...)`.
- Add/adjust tests for every behavior change, including fallback paths and error handling.
- Run targeted tests first, then run full `npm test` before submitting changes.
- Repository policy tests must keep root generated bundles and non-whitelisted Markdown out of source control.

## Git Worktree & Branch Safety
- Do not create git worktrees or git branches unless the user explicitly approves that operation for the current task.
- Do not use worktree or branch creation as the default isolation strategy for agent work.
- Before merging or cherry-picking from an existing worktree or branch, inspect its status, commit divergence, and diff scope; report the proposed source and affected files first.
- Treat pruning or deleting worktrees as a destructive cleanup step; ask for explicit approval before running it.

## Commit & Pull Request Guidelines
- Follow conventional-style messages seen in history: `feat(...)`, `fix(...)`, `refactor(...)`.
- Keep commits focused (one logical change per commit).
- PRs should include:
  - purpose and scope,
  - key files changed,
  - test evidence (commands + pass result),
  - screenshots/log snippets for CLI UX changes when relevant.

## Security & Configuration Tips
- Never commit real tokens or credential exports.
- Validate import paths and avoid absolute/parent traversal inputs.
- Prefer environment-based configuration for sensitive runtime settings.
