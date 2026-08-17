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
- `npm run web:dev`: WebUI dev server (`cd web && npm run dev`, Umi Max).
- `npm run build`: build the WebUI (`cd web && npm run build`, Umi Max/Webpack).
- `cd web && npm run lint`: lint the WebUI.
- `npm run models:sync`: update the `third_party/models.dev` submodule to upstream
  `dev`, then regenerate the Go `modalities.json` snapshot atomically. Model metadata
  (modalities, context window, pricing) comes from that submodule, and a submodule
  is pinned to one commit — upstream ships new models daily, so without syncing a
  newly released model has no metadata and falls back to regex heuristics or shows
  as unknown. The command refuses to overwrite dirty sync inputs and never commits;
  the pointer and generated snapshot remain a reviewable repository change.
- `npm run models:check`: offline-verify that the generated Go snapshot matches the
  pinned submodule commit. It never contacts upstream, so unrelated CI and runtime
  work do not fail while the asynchronous updater is waiting for its next run.
- `.github/workflows/models-dev-sync.yml`: every two hours, asynchronously sync the
  pinned submodule and generated snapshot, verify both, and commit only those two
  files to `main` when they changed. Runtime startup and inference requests always
  use the last verified local snapshot and never wait for GitHub or upstream Git.
- `npm run gateway:routes`: read-only scan of both gateways' HTTP paths and their
  data-plane diff. Backs `docs/architecture/go-node-parity-matrix.md`; `--json`
  for CI. Note it collects path literals, so router scope guards (`/v1/`,
  `/v1beta/`) show up as if they were endpoints — the matrix records which are.
- `npm run gateway:shadow -- --node <url> --go <url> [--include-inference]`:
  send the same requests to both gateways and diff status plus response
  structure. Read-only probes by default (no token cost); `--include-inference`
  adds one minimal request per client protocol. Keys come from flags or
  `AIH_SHADOW_NODE_KEY` / `AIH_SHADOW_GO_KEY` and are never written to disk or
  printed. This is the only evidence that Go can replace Node — unit tests cannot
  see upstream behaviour differences. Re-run it after any change to Canonical
  encode/decode.

## Coding Style & Naming Conventions
- Main body (`lib/`): Node.js CommonJS (`require`, `module.exports`).
- Formatting style in repo: 2-space indentation, semicolons, single quotes.
- File names use kebab-case (for example `account-import-orchestrator.js`).
- Prefer small, composable functions; avoid feature growth in one large file.
- `cli/`: TypeScript ESM, run by Bun (vendored Claude Code source — do not modify unless necessary).
- `web/`: TypeScript + React 18 + Ant Design + Umi Max (Webpack build), ESM.

## UI Visual Constraints
- 全局禁止使用大面积的告警/提示块作为页面主内容，包括黄色、蓝色或灰色的整块 `Alert` 卡片；保留无障碍语义，但统一使用紧凑的行内状态、标签或操作旁说明。
- 全局禁止在卡片、状态项、导航项和列表项上使用粗左侧彩色竖条、`border-left` 装饰条或等价的 `inset` 强调条；状态应通过背景、完整边框、图标、标签或留白表达。
- 新增或修改页面必须遵守上述规则，并通过真实页面检查确认不存在大块提示容器和左侧粗竖条。1px 的功能性分隔线仅可用于明确的控件分界，不得作为状态装饰。

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
- Goal: a CLI session started locally (`aih claude 1`) survives the foreground client and can be explicitly re-attached later — e.g. SSH back into the same host, run `aih claude sessions 1`, and select a compatible exact session. A bare `aih <provider> [id]` launch always creates a fresh session; cwd must never imply re-attach intent. Picker rows marked as legacy runtime or completed/dead intentionally create a fresh compatible replacement instead of attaching.
- **tmux is the engine; we never reinvent a multiplexer.** `lib/runtime/persistent-session.js` has strict foreground operations: fresh launches use `tmux -L <socket> [-f conf] new-session -s <unique-session> -c <cwd> -- <cmd> <args>` without `-A` / `-D`; compatible exact selections use `tmux -L <socket> attach-session [-d] -t <exact-session>` without launching another provider process.
- Addressing model (this is what makes one account run many concurrent windows):
  - **socket = per accountRef** (`aih-<provider>-<accountRef>`): one tmux server per account, created with that account's fully isolated env, so credentials never cross account boundaries (reinforces the isolation model). Secrets ride the process env only — never tmux `-e`/argv (would leak to `ps`).
  - **session = unique launch, grouped by project, or an explicit label**: `p-<basename>-<hash(cwd)>` is a stable project grouping/name prefix, not an implicit re-attach target. Every bare launch allocates an unused exact session name under that prefix. `-S <label>` / `--session <label>` (or `AIH_SESSION=<label>`) is a named upsert for `s-<label>`: create when missing, enter when compatible, or create a replacement sibling when the existing named target is incompatible.
  - **intent controls the operation**: bare launch means strict fresh create. The `sessions` picker / `AIH_SESSION_TARGET` select an exact identity; a successfully probed missing or incompatible exact target fails without creating or substituting a sibling. A picker row already known to be legacy/completed clears the exact target and starts a fresh compatible replacement in that row's project. If an exact identity is already known but the list probe itself is unavailable, attach may still proceed by that identity.
  - **latest selection is separate from exact selection**: `-R` / `-M` select the greatest `session_created` under the current project's generated prefix. An abnormal probe fails closed without attach/create; a healthy empty result may upsert the project base. `-R` takes over the selected latest session and `-M` shares it.
  - The foreground launcher never automatically runs `kill-server`; stale, legacy, incompatible, and unrelated sessions remain untouched. `new-session -A -d` is reserved for reboot restore, where idempotently recreating a registry-owned exact target is required. Normal foreground create/attach paths must not use `-A`.
  - A generated transparent `tmux.conf` (`status off`, `window-size latest`, `escape-time 0`, `extended-keys on` via `-q`) keeps tmux invisible under the aih overlays. Version-sensitive options use `set -gq` so older tmux builds (< 3.2 for `extended-keys`, < 3.5 for `extended-keys-format`) silently skip them — no forced upgrades. The psmux variant of the conf also sets these two options: psmux stores them inertly (its modified-Enter delivery is hardcoded in its own input layer), which makes provider CLIs' `show -gqv extended-keys` probe return `on` and silences their "extended-keys is off" warning.
- Discovery / re-attach UX: `aih <provider> sessions [id]` lists an account's live sessions. The interactive picker passes a compatible selected identity into the exact-target path; legacy/completed rows instead request a fresh compatible replacement. Unnamed parallel siblings must never be entered by emitting a bare command that relies on cwd selection.
- Gating: best-effort — applied only when a tmux engine is found, stdout is a TTY, the run is not a login/oauth flow, and `AIH_PERSIST_ACTIVE` is unset (avoids nesting). Escape hatch: `AIH_NO_PERSIST=1`.
- Cross-platform: the engine is real tmux on macOS / Linux / WSL. On **native Windows** `detectTmux()` looks for a tmux-compatible binary — `psmux` (native ConPTY, speaks tmux's CLI) first, then an MSYS2/Cygwin `tmux.exe` (`C:\msys64\usr\bin`, `C:\cygwin64\bin`) or anything named `tmux` on PATH. If none is found, persistence degrades to a plain direct spawn and `sessions` prints an install hint (psmux / MSYS2). The Windows wiring is implemented but needs validation on a Windows host.
- **Reboot survival (registry + restore)**: tmux servers are in-memory, so every persistent launch also records a small JSON entry under `$AIH_HOME/run/persistent-sessions/` (`lib/runtime/persistent-session-registry.js` — addressing metadata only, never credentials). After a reboot the restore engine (`lib/cli/services/ai-cli/persistent-session-restore.js`) reconciles entries against live servers and re-creates reboot-killed sessions detached, spawning `aih <provider> <cliAccountId>` children with `AIH_PERSIST_DETACHED=1` + `AIH_SESSION_TARGET=<session>` so the full normal launch pipeline (env isolation, config sync) is reused; conversation continuity uses provider-native resume (`codex /resume` by cwd, `claude --continue`). Triggers: server startup (`aih server serve`, covers `aih server autostart` reboots) and lazily on `aih ss`. Sessions whose server is alive but session gone, or whose entry was last seen alive during the current boot, are dropped, not restored.

## Headless CLI runs (`aih <provider> <id> -p …`)
- A non-interactive invocation is a **Unix command, not a session**: stdout carries the model's answer and nothing else, every aih-owned line goes to stderr, no ANSI/OSC is injected, and the child's exit code is propagated (Ctrl-C → 130).
- **Detection has one source of truth.** The per-provider trigger table lives in the Go contract (`core/providers/builtins.go` → `cli.headless` in `contracts/providers/manifest.json`) and is read through `lib/provider-catalog.js` (`getProviderHeadlessConfig`). `lib/cli/services/pty/headless-invocation.js` is the only place that answers "is this call headless?" — never re-derive it inline. Current triggers: claude `-p`/`--print`, codex `exec`, opencode `run`, agy/qoder/qodercn `--print`, grok `--single`; **gemini has no headless entry** and always uses the PTY path.
- A headless run skips the whole interactive shell: no PTY, no tmux wrapper (`lib/cli/services/pty/headless-spawn.js` spawns directly), no raw mode, no resumed stdin, no boot spinner, no usage/clipboard watchers, and no terminal icon / OSC title / iTerm profile / Warp agent mapping (`lib/cli/commands/ai-cli/router.js`).
- Child stdout and stderr stay **separate** (`onData` / `onErrorData`); stderr text still feeds the auth/error scan buffer. stdin is only connected for `--input-format stream-json`.
- Exit waits for stdout/stderr to drain before `process.exit` (`exitAfterFlush` in `pty/runtime.js`) — `process.exit()` discards queued pipe writes, which silently truncated `out=$(aih … -p …)`.
- **Never clear terminal rows on teardown.** The shell drawer only clears rows it actually painted (`shell-drawer-controller.js`); the old unconditional teardown wiped the bottom of the screen on every exit, which erased a `-p` answer as soon as the process ended.
- Waiting must look alive: `lib/cli/services/pty/headless-progress.js` animates the `Running …` line with a spinner + elapsed seconds and replaces it with `✔ … 首字节 <n>s` on the first byte from the child (stdout or stderr). It writes **only to stderr and only when stderr is a TTY**, so `out=$(aih … -p …)` still animates on screen while the captured stdout stays clean, and a redirected stderr gets the plain one-line banner instead. Escape hatch: `AIH_HEADLESS_SPINNER=0`; Windows falls back to ASCII frames.
- Escape hatch: `AIH_HEADLESS_DIRECT_SPAWN=0` forces the PTY path. Side effect: on a TTY that run then falls back into the tmux persistent wrapper, since `shouldPersist` does not inspect argv.

## Gateway & Account Internals
- Gateway routing (`lib/server/`): request enters → `router.js` (account selection + failure/success accounting) → `capability-router.js` (route by provider capability) → `protocol-*.js` (OpenAI/Anthropic/Gemini protocol translation) → upstream.
- Account unique identity: `accountRef` is the persisted DB primary key and the only identity used by server, WebUI, runtime, events, and usage. `cliAccountId` is only a mutable numeric alias for CLI input/display. Registration derives `accountRef` once from the provider identity seed through `lib/account/account-registration.js`; no `unique_key` column or profile-directory identity fallback exists.
- Model alias + circuit-breaking: aliases resolve fallback at runtime and `/v1/models` does not expose the wildcard `claude-*`; 429s trip a circuit breaker at `(account, model)` granularity rather than locking the whole account.
- WebUI real-time push: `session-event-bus.js` → `webui-sse-broadcaster.js` → browser SSE connection.

## Testing Guidelines
- Framework: built-in Node test runner (`node:test`) with `assert/strict`.
- Name tests by behavior, e.g. `test('runGlobalAccountImport reports provider progress callback', ...)`.
- Add/adjust tests for every behavior change, including fallback paths and error handling.
- Run targeted tests first, then run full `npm test` before submitting changes.
- Repository policy tests must keep root generated bundles and non-whitelisted Markdown out of source control.

## Git Worktree & Branch Safety
- **Only `main` may be kept long-term.** Do not keep feature branches around: once work lands on `main`, delete the temporary branch. Never leave commits that exist only on a side branch or a detached HEAD.
- Do not create git worktrees or git branches unless the user explicitly approves that operation for the current task.
- Do not use worktree or branch creation as the default isolation strategy for agent work.
- If a worktree is used, it must not be released (removed/pruned) until all of its commits have been merged into the main project's `main`. Verify with `git cherry main <worktree-head>` (or `git log main..<head>`) that nothing remains before releasing it.
- Resolve integration inside the worktree first: rebase/merge `main` into the worktree branch and resolve conflicts there, run tests there, so landing on `main` in the primary workspace is a clean fast-forward (or trivial merge) with minimal conflict probability.
- Before merging or cherry-picking from an existing worktree or branch, inspect its status, commit divergence, and diff scope; report the proposed source and affected files first.
- Treat pruning or deleting worktrees as a destructive cleanup step; ask for explicit approval before running it.
- **Never discard local unpushed commits.** When a rebase hits conflicts, prefer `git rebase --abort` and re-plan; never `git reset --hard origin/main` (or any hard reset) while the branch carries unpushed work. Before any destructive history operation, tag the current HEAD as a backup (e.g. `backup/<date>-<topic>`) and confirm the operation with the user.
  - Background: on 2026-08-14 a session aborted a conflicting rebase and then ran `reset --hard origin/main`, silently dropping 13 local commits (~17k insertions, including the full kimi integration) plus leaving a 3k-line stash. Recovery cost far exceeded the merge it was trying to avoid.
- When multiple agent sessions share this repository, each session must assume another session may hold unpushed commits; check `git reflog` for recent `reset`/`rebase` operations before rewriting history, and never reset past commits you did not create.

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
