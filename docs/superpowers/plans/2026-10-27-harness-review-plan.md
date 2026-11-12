# Harness Stability and Layer Boundary Review Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review and stabilize the harness runtime end to end, with particular attention to the WebUI “open CLI” flow, identity/model boundaries, lifecycle ownership, and the distinction between Portable Core, Host Adapter, and Native Projection.

**Architecture:** Treat the account provider, harness, managed application, binary, plugin host, and gateway runtime scope as separate typed concepts. Keep WebUI selection declarative, keep server launch orchestration provider agnostic, and let each harness adapter own only its native projection and lifecycle. Reuse existing gateway/account facts instead of creating a second catalog or account truth.

**Tech Stack:** Node.js CommonJS server and CLI, React/TypeScript WebUI, native CLI subprocesses, existing provider/harness descriptors, offline model snapshots, and existing deterministic demo scripts.

**Spec:** `docs/superpowers/specs/2026-10-25-universal-agent-plugin-design.md` and `docs/architecture/design-patterns.md`.

## Global Constraints

- Do not add a new `AIH_*` environment variable; use existing context, server config, WebUI state, or constants.
- Do not add provider-name dispatch branches; extend descriptors, registries, and strategy/adaptor tables.
- Preserve account identity isolation and explicit `accountRef` pinning for cross-provider harness launches.
- Keep native CLI arguments after `--` byte-for-byte pass-through.
- Treat unsupported, partial, stale, or unknown capability states as observable failures; do not silently fall back to a different account or harness.
- Do not change harness code during this review phase. Implementation starts only after this plan is approved.
- Use existing tests and deterministic native demos for verification; do not create test files unless separately approved.

## Review findings to carry into implementation

1. **WebUI hides valid external harnesses.** `web/src/features/accounts/account-view-model.ts` computes `cliSupported` from the account’s identity provider only. `web/src/pages/Accounts.tsx` therefore hides the CLI action for an account whose provider has no native CLI, even when `Pi` or `DeepSeek Harness` is available as a cross-provider harness.
2. **The missing-install path bypasses harness selection.** In `use-account-actions.ts`, an uninstalled account-provider CLI calls `handleOpenApp(record, 'cli')` directly. The user is sent to install the identity provider’s CLI before seeing the harness picker, so an already-installed external harness cannot be selected.
3. **The same vocabulary crosses all layers.** `provider` is used for identity ownership, upstream routing, harness selection, and installer targets; `harness`, `managedAppId`, `binaryName`, and `pluginHostId` are separate facts but are not represented as a single explicit launch target. This makes the WebUI, `open-app`, installer, and CLI router easy to make inconsistent.
4. **CLI model discovery is not account-scoped.** `lib/harness/gateway-catalog.js` fetches the gateway model list without `x-account-ref`; external harness preparation can therefore choose a model from the global pool that the pinned account cannot serve. `resolvePinnedHarnessDefaultModel()` only protects the empty-model case and relies on a potentially stale persisted cache.
5. **Pi refresh can miss metadata changes.** `lib/harness/aih-model-refresh.mjs` computes updated reasoning metadata but `sameIds()` compares only model IDs, so a changed `aih_reasoning_efforts` set can be treated as `unchanged` and never written to native settings.
6. **Session ownership needs an explicit decision.** `lib/harness/projection.js` links each account projection to the host-wide Pi/DSH sessions directory. This may be correct for product-level sessions, but it can expose histories across pinned account identities unless the native session store is proven identity-neutral. The boundary must be documented and verified before claiming account isolation.
7. **Lifecycle ownership is spread across large modules.** `lib/server/account-app-launcher.js` combines desktop launch, CLI launch, terminal selection, account checks, process markers, and platform spawning. `lib/harness/run.js` combines preparation, environment scrubbing, command resolution, and process supervision. The current behavior is difficult to reason about as one state machine.
8. **External harness adapter coverage is asymmetric.** `lib/harness/adapters.js` currently covers Pi, DSH, and DSH-TUI. The universal plugin design names DeepSeek/OpenCode/Pi/AIH projections, but OpenCode and the Portable Core are not represented by the same harness launch boundary. The review must distinguish “native resource proof” from “harness launch parity.”

## Phase 1: Establish the canonical launch vocabulary

**Files to inspect or modify later:**

- `lib/harness/catalog.js`
- `lib/server/account-app-launcher.js`
- `lib/server/webui-account-app-launcher.js`
- `lib/server/app-install-job-manager.js`
- `lib/server/app-installers/index.js`
- `lib/cli/commands/ai-cli/router.js`
- `web/src/features/accounts/account-view-model.ts`
- `web/src/features/accounts/use-account-actions.ts`
- `web/src/features/accounts/CliPickerModal.tsx`

- [ ] Define and document these fields in one launch DTO: `identityProvider`, `accountRef`, `harnessId`, `managedAppId`, `binaryName`, `pluginHostId`, `model`, `runtimeScope`, and `nativeArgs`.
- [ ] Add one descriptor-driven resolver that returns the complete DTO or a stable error (`harness_unknown`, `harness_not_installed`, `cross_provider_unsupported`, `account_model_unavailable`); callers must stop inferring one field from another.
- [ ] Make installer resolution consume `managedAppId` from the descriptor and return the same target shape used by `open-app`; keep `dsh-tui → dsh` as descriptor data, not a special case.
- [ ] Update the universal plugin spec terminology so “Host Adapter” means the lifecycle/port adapter and “Native Projection” means generated host files/configuration; do not call an account CLI launch itself a plugin projection.
- [ ] Add an architecture table mapping WebUI, HTTP route, launcher, adapter, native process, and gateway scope to the DTO fields they are allowed to read.

## Phase 2: Repair the WebUI open-CLI decision flow

**Files to modify:**

- `web/src/features/accounts/account-view-model.ts`
- `web/src/pages/Accounts.tsx`
- `web/src/features/accounts/use-account-actions.ts`
- `web/src/features/accounts/CliPickerModal.tsx`

- [ ] Change CLI action visibility from “identity provider has a CLI” to “at least one declared CLI harness is available or installable for this host.” Keep the account identity row as the pinned target.
- [ ] Route the first click through one capability-loading path even when the identity provider’s own CLI is missing; the picker must list external harnesses and mark uninstalled entries rather than immediately installing the identity provider.
- [ ] Keep double-click semantics explicit: it may use the identity provider’s native harness only when that binary is installed; otherwise show the same picker/error state instead of silently changing harness.
- [ ] Guard asynchronous `listTerminals`, `listAppEntries`, and model-catalog responses with a request generation or selected-account token so an older account cannot overwrite a newer picker state.
- [ ] Preserve draft workdir/model/harness state while capability data refreshes; invalidate only values that are no longer declared valid.
- [ ] Make the picker display identity provider, harness, managed app, and selected model as separate labels so the user can see what changes and what stays pinned.

## Phase 3: Make model and account routing authoritative

**Files to modify:**

- `lib/harness/gateway-catalog.js`
- `lib/harness/pinned-default-model.js`
- `lib/harness/run.js`
- `lib/harness/pi.js`
- `lib/harness/dsh.js`
- `lib/harness/dsh-tui.js`
- `lib/harness/aih-model-refresh.mjs`
- the existing model-cache/account-catalog readers used by WebUI

- [ ] Define whether a harness launch fetches a global pool catalog or an account-scoped catalog. For a pinned account, require the account-scoped fact and carry `x-account-ref` through the same gateway adapter used by the request path.
- [ ] Reject an explicit model that is absent from the pinned account catalog with a stable preflight error; do not silently replace it with the first global model.
- [ ] Make the default selection algorithm use one authoritative source and freshness rule for WebUI, CLI, Pi, and DSH. Record whether the source is a persisted snapshot, a live probe, or a documented fallback.
- [ ] Change model refresh equality from ID-only to a stable projection comparison covering model ID, modalities, context/output limits, reasoning levels, and cost fields that the native harness consumes.
- [ ] Add in-flight cancellation/last-write protection to native refreshers so a slow old catalog cannot overwrite a newer one, and ensure refresh errors retain the previous valid projection.
- [ ] Keep aliases out of the pinned request path unless resolved against the pinned identity provider before spawning; surface alias-provider mismatch instead of passing an unrouteable alias.

## Phase 4: Review lifecycle, process, and session ownership

**Files to inspect and split only where the boundary is proven:**

- `lib/server/account-app-launcher.js`
- `lib/server/webui-account-app-launcher.js`
- `lib/harness/run.js`
- `lib/harness/projection.js`
- `lib/runtime/shared-store-linker.js`
- `lib/runtime/persistent-session.js`
- `lib/cli/commands/ai-cli/router.js`

- [ ] Draw the lifecycle state machine: `discovered → preflight → projected → spawned → running → draining → disposed`, including install-required, cancellation, spawn failure, and child-exit paths.
- [ ] Separate pure launch planning from side effects: account eligibility, model preflight, native projection, environment construction, terminal spawn, and process supervision must have explicit boundaries.
- [ ] Decide and document whether host-wide native sessions are intentionally shared across account projections. If they are shared, require identity-neutral session metadata and prevent credential/account data from entering the shared store. If they are not shared, change the projection to account-scoped storage.
- [ ] Verify cleanup on cancellation, terminal close, child signal, and failed projection. Temporary files, watchers, timers, and native profile overrides must not survive a failed launch without an observable reason.
- [ ] Ensure Windows and POSIX command construction use argv/launcher files consistently; no shell-string quoting logic may be duplicated between WebUI and CLI launchers.
- [ ] Keep process markers and runtime scope in existing context contracts; do not add a new environment variable.

## Phase 5: Align host adapters and native projections with the plugin spec

**Files to inspect or modify:**

- `lib/harness/adapters.js`
- `lib/harness/pi.js`
- `lib/harness/dsh.js`
- `lib/harness/dsh-tui.js`
- `lib/native-resources/host-plugin-runtime.js`
- `lib/native-resources/native-plugin-adapters.js`
- `docs/superpowers/specs/2026-10-25-universal-agent-plugin-design.md`
- `docs/architecture/design-patterns.md`

- [ ] For each host, list the Portable Core inputs, Host Adapter responsibilities, and Native Projection outputs. Keep host-specific objects out of Portable Core.
- [ ] Mark OpenCode native MCP/plugin evidence separately from the external harness launch path; do not report a native resource demo as proof of WebUI harness parity.
- [ ] Require every projection to be reversible or drainable: withdraw visible contributions first, then stop watchers/processes, then remove owned files only when ownership checks pass.
- [ ] Make capability reports distinguish supported, partial, unsupported, and installable-but-not-installed. Do not represent “binary missing” as “provider unsupported.”
- [ ] Keep `managedAppId` and native package metadata in descriptors; no second mapping in WebUI or installer code.

## Phase 6: Verification matrix before implementation completion

- [ ] Run existing focused Node suites for account-app launch, provider descriptors, harness projection, native resource lifecycle, model catalog/cache, and CLI routing. Reuse current files; do not add test files in this review pass.
- [ ] Run deterministic probes for: provider-without-CLI + Pi available; provider-CLI-missing + Pi installed; DSH-TUI install target; explicit unavailable model; stale model refresh metadata; concurrent picker responses; projection ownership conflict; cancellation during catalog fetch and native spawn.
- [ ] Run the existing native demos for Pi/DSH/OpenCode/Codex/Claude/Gemini where the binary is available, recording host version and evidence level separately.
- [ ] Perform WebUI build and modified-file lint for any eventual WebUI implementation; perform real-page checks for the account CLI action and picker states.
- [ ] Report each surface as implemented, tested, native-observed, or still unverified. A passing local unit suite is not evidence of cross-host launch parity.

## Checkpoint and review discipline

- [ ] Keep implementation commits small: vocabulary/descriptor boundary, WebUI flow, catalog authority, lifecycle ownership, then host projection alignment.
- [ ] Before every checkpoint, stage only affected paths and inspect `git diff --cached` and `git status`.
- [ ] Do not reset, revert, or overwrite concurrent work. Stop after the plan until the user approves execution.

## Self-review of this plan

- **Spec coverage:** portable boundary, host adapter, native projection, capability negotiation, generation/lifecycle cleanup, and WebUI/account launch integration are all assigned to phases.
- **Placeholder scan:** no task depends on an unspecified file, provider branch, or unnamed test; each phase names concrete modules and evidence.
- **KISS/YAGNI:** the plan introduces one launch DTO/resolver and one projection comparison boundary; it does not propose a universal superclass or a second gateway/account catalog.
