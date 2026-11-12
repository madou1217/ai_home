# Provider Session State and Title Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider session hooks, Codex questions/errors/interruption, retry/statusline signals, and gateway route state feed one isolated event store and the rotating terminal title.

**Architecture:** A revisioned `ProviderSessionStateStore` owns one snapshot per provider/native-session/project identity and a correlation alias map. Existing hook normalization, Codex interaction observation, retry delivery, and PTY fallback adapters submit normalized events into that store; the existing title Facade reads only a provider-neutral snapshot source and rotates complete frames.

**Tech Stack:** Node.js CommonJS, existing provider contracts and hook sender/receiver, tmux/PTY real smoke checks, temporary `node --test` RED/GREEN checks because the repository intentionally has no committed `test/` tree.

**Spec:** `docs/superpowers/specs/2026-10-25-provider-session-title-state-design.md`

## Global Constraints

- Preserve unrelated working-tree changes; stage only paths for the current checkpoint.
- Do not add a new `AIH_*` environment variable; use existing session intent/correlation and provider context fields.
- Do not add provider-name dispatch branches to the title Facade; use descriptors, registries, and adapters.
- Hook configuration remains explicit and atomic; never overwrite user configuration during server startup.
- No credentials or unbounded prompt/transcript contents are written to state files.
- Every checkpoint uses an explicit pathspec and is reviewed with `git diff --cached --stat`.

### Task 1: Revisioned provider session state store

**Files:**
- Create: `lib/server/provider-session-state-store.js`
- Test: `/tmp/aih-provider-session-state.test.js`
- Verify: `node --check lib/server/provider-session-state-store.js`

**Interfaces:**
- `createProviderSessionStateStore({ fs, path, aiHomeDir, now, maxRecentEvents })`
- `store.apply(event) -> { accepted, reason, state }`
- `store.get(session) -> state|null`
- `store.resolveCorrelation(correlationId) -> session|null`
- `store.subscribe(listener) -> unsubscribe`

- [ ] **Step 1: Write RED checks** for two same-provider sessions remaining isolated, duplicate event IDs being ignored, older revisions being rejected, question clear transitions, and atomic persistence path selection.
- [ ] **Step 2: Run the temporary test and verify it fails because the module is missing.**
- [ ] **Step 3: Implement normalized identity keys, correlation alias binding, monotonic revision/time acceptance, bounded recent events, and atomic JSON snapshot writes under `run/provider-session-state/`.
- [ ] **Step 4: Run the same temporary test and verify it passes.**
- [ ] **Step 5: Run syntax and inspect the diff.**
- [ ] **Step 6: Commit only the store and its design evidence with `feat(session): add revisioned provider session state store`.**

### Task 2: Normalize hook payloads into rich session events

**Files:**
- Modify: `lib/server/provider-hook-event-normalizer.js`
- Modify: `lib/server/webui-session-event-routes.js`
- Modify: `lib/server/session-event-bus.js`
- Test: `/tmp/aih-provider-hook-events.test.js`

**Interfaces:**
- `normalizeProviderHookEvent()` emits `question-opened`, `question-cleared`, `turn-interrupted`, and bounded `statusline-updated` payloads where the provider payload proves them.
- `handleProviderHookSessionEventRequest()` applies the normalized event to the injected state store before publishing to the existing bus.

- [ ] **Step 1: Write RED checks for explicit interruption, question payload, error payload, and statusline fields.**
- [ ] **Step 2: Run the checks and confirm the new event types are absent.**
- [ ] **Step 3: Add provider-neutral payload extraction and call `providerSessionStateStore.apply()` with the normalized event plus correlation ID.**
- [ ] **Step 4: Run the checks and verify the event and state transitions pass.**
- [ ] **Step 5: Run syntax checks and commit `feat(session): normalize rich provider hook events`.**

### Task 3: Wire Codex interaction and retry state into the store

**Files:**
- Modify: `lib/cli/services/pty/codex-interaction-observer.js`
- Modify: `lib/server/webui-session-event-routes.js`
- Modify: `lib/cli/services/pty/pty-runtime-run.js`
- Modify: `lib/server/provider-session-correlation-registry.js`
- Test: `/tmp/aih-codex-session-state.test.js`

**Interfaces:**
- `createCodexInteractionObserver({ publishSessionEvent, ... })` emits provider-neutral question open/clear events in addition to existing WebUI sync.
- Retry delivery emits `retry-updated` into the same store.
- PTY failure/interruption path emits `turn-failed` or `turn-interrupted` with `source: 'pty-fallback'`.

- [ ] **Step 1: Write RED checks for Codex prompt open/clear, retry update, and interruption state.**
- [ ] **Step 2: Run them and confirm the state store receives none of these events.**
- [ ] **Step 3: Add an injected publisher boundary; keep existing WebUI sync behavior unchanged while publishing normalized events.**
- [ ] **Step 4: Run the checks and verify dedupe and session isolation.**
- [ ] **Step 5: Commit `feat(codex): publish interaction and retry session state`.**

### Task 4: Add provider-neutral title state source and frames

**Files:**
- Modify: `lib/cli/services/pty/usage-status-runtime.js`
- Modify: `lib/cli/services/pty/terminal-title/sources/index.js`
- Modify: `lib/cli/services/pty/terminal-title/contract.js`
- Test: `/tmp/aih-title-state-source.test.js`

**Interfaces:**
- `collectTitleContext()` exposes a bounded `sessionState` object, never the store itself.
- New sources consume `ctx.sessionState` and return complete frames for question, retry, statusline, error, and interruption.

- [ ] **Step 1: Write RED checks for stable frame order and complete frames such as `? question`, `↻ retry`, `⚠ interrupted`, and `context 68%`.**
- [ ] **Step 2: Run them and confirm the sources do not exist.**
- [ ] **Step 3: Add provider-neutral source strategies and bounded formatting; preserve existing source priority and rotation.**
- [ ] **Step 4: Run the checks and verify no provider-specific branches were added to the Facade.**
- [ ] **Step 5: Commit `feat(title): rotate provider session state frames`.**

### Task 5: Connect live PTY and hook state to title context

**Files:**
- Modify: `lib/cli/services/pty/pty-runtime-run.js`
- Modify: `lib/cli/services/pty/usage-status-runtime.js`
- Modify: `lib/server/persistent-session-runtime.js` or composition root where the state store is available
- Test: `/tmp/aih-live-title-state.test.js`

**Interfaces:**
- Live PTY runtime resolves its own native session identity and correlation alias, then reads only that session's snapshot.
- Hook receiver and PTY runtime share the same injected store for the active server process.

- [ ] **Step 1: Write a RED integration check with two session identities and distinct state snapshots.**
- [ ] **Step 2: Run it and verify title context is currently unaware of state.**
- [ ] **Step 3: Inject the store into the composition boundary and add a fail-soft `getSessionState()` resolver.**
- [ ] **Step 4: Run the integration check and verify the two sessions never cross-talk.**
- [ ] **Step 5: Commit `feat(title): bind live PTY titles to isolated session state`.**

### Task 6: Verify official hook capability and Codex remote boundary

**Files:**
- Modify only if evidence requires it: `lib/server/codex-app-server-hook-wrapper.js`, `lib/server/codex-app-server-stdio-proxy.js`, provider hook descriptor files
- Create: `scripts/verify-provider-session-title-smoke.js`
- Verify: real CLI/tmux commands and changed-file lint

- [ ] **Step 1: Run `claude --help`, `codex --help`, `cline --help`, and `opencode --help` capability probes; record event names and hook paths in the smoke script.**
- [ ] **Step 2: Run a real Claude hook sender/receiver probe and verify `session:turn-*` reaches the state store.**
- [ ] **Step 3: Run a real Codex PTY question/interruption probe and verify question/error frames.**
- [ ] **Step 4: Run two concurrent same-provider tmux sessions and verify each pane title only shows its own state.**
- [ ] **Step 5: Probe Codex remote/WS correlation; if the upstream cannot carry the key, verify the proxy-side hook path instead of claiming HTTP header coverage.**
- [ ] **Step 6: Run all changed-file syntax/lint checks and commit `test(session): add real provider title smoke verification`.**

### Task 7: Documentation and final audit

**Files:**
- Modify: `docs/architecture/design-patterns.md`
- Modify: `docs/providers/agent-cli-usage.md` only if provider help facts changed
- Verify: `git status`, `git diff --check`, `go build ./...` if Go contracts changed, real smoke output

- [ ] **Step 1: Document the concrete Facade / Strategy / Registry / Adapter / Observer boundaries and evidence.**
- [ ] **Step 2: Run repository-wide stale-path, U+FFFD, and provider-branch scans for changed areas.**
- [ ] **Step 3: Run the completion audit requirement-by-requirement; report any unsupported provider capability explicitly.**
- [ ] **Step 4: Commit documentation as a separate checkpoint.**
