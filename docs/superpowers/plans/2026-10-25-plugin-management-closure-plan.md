# Plugin Management and Provider Closure Implementation Plan

**Repository policy override (2026-10-26):** The user's instruction forbids new
test files and asks for real runtime verification. All test-file creation and
test-writing steps below are superseded by the checked-in executable demos and
isolated native-host probes. The 13 test files previously introduced by this
task have been removed; existing repository tests may still be run as regression
checks. No new unit tests are required or authorized by this historical plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing AIH plugin runtime into a user-visible, end-to-end management system for AIH plugins, native plugins, skills, and MCP servers, with descriptor-driven coverage reports for every supported provider and runnable demos proving install, enable, use, disable, and removal.

**Architecture:** Keep AIH's existing Plugin Host, artifact verification, management API, Cordis lifecycle, and generation snapshots as the AIH runtime. Add a provider-neutral resource management facade whose adapters are selected from the canonical provider descriptor: native plugin projection, skill projection, and MCP configuration/connection. The facade exposes one CLI contract (`aih plugin`, `aih native plugin`, `aih skill`, `aih mcp`, `aih provider capabilities`) while native CLIs remain the final execution owners.

**Tech Stack:** Node.js CommonJS, existing provider catalog/native boundary contract, Commander/root routers, JSON/TOML config projection, stdio JSON-RPC MCP client, Node test runner, existing AIH server management routes, fixture providers and local demo processes.

**Spec:** `docs/superpowers/specs/2026-10-25-universal-agent-plugin-design.md` plus the user closure requirement: every supported provider needs an explicit capability result, and each delivered resource type needs an actual runnable demo.

## Global Constraints

- Preserve unrelated working-tree changes; stage only the current checkpoint.
- Do not add new `AIH_*` environment variables. Use CLI/config files/provider descriptors for all new settings.
- Do not add provider-name dispatch branches. Add descriptor fields and registry adapters; consumers ask the facade for capabilities.
- Native plugin/skill/MCP management must fail closed when a provider has no declared boundary; return `unsupported` with a stable reason.
- Never expose credentials, MCP env values, plugin secrets, management keys, or full request bodies in status, logs, demos, or tests.
- Every web source change, if introduced later, requires full `cd web && npm run build`, changed-file ESLint, and related tests. This plan starts CLI/server first and does not require WebUI for the first closure.
- Every coherent checkpoint must be committed separately with a single-purpose message; never stage existing unrelated changes.
- Before claiming a closure, run the exact demo or conformance command and record its output in an evidence document.

## Current Baseline and File Map

Existing AIH plugin runtime and control files:

- `lib/plugins/control/control.js` — artifact install, instance enable/disable, revision CAS, doctor.
- `lib/plugins/control/cli.js` — `aih plugin` offline and server-backed CLI.
- `lib/server/plugin-management-routes.js` — `/v0/plugins` management API.
- `lib/plugins/host/host-runtime.mjs` — Cordis generation loading, contribution invocation, drain/dispose.
- `lib/plugins/control/plugin-system.js` and `lib/plugins/control/runtime-service.js` — server composition and generation snapshots.
- `examples/plugins/echo/`, `examples/plugins/provider-descriptor/`, `examples/plugins/account-paste-token/` — existing examples.

Existing provider and native boundary files:

- `core/providers/model.go`, `core/providers/native.go`, `core/providers/builtins.go` — cross-language native boundary facts.
- `contracts/providers/manifest.json` — generated provider manifest consumed by Node.
- `lib/provider-catalog.js` — read-only provider facade and capability lookup.
- `lib/providers/loader.js`, `lib/providers/defs/` — descriptor loading and external provider definitions.

Existing skill and native runtime files:

- `lib/cli/services/ai-cli/provider-skill-installer.js` — current implicit `aih-collab` injection.
- `lib/cli/services/ai-cli/provider-runtime-env.js` — provider launch preparation and skill injection call site.
- `assets/provider-skills/aih-collab/` — current skill asset.
- `lib/cli/commands/root/router.js`, `lib/cli/commands/ai-cli/router.js` — root management and native CLI forwarding.

## Task 1: Freeze a real baseline and add closure test harness

**Files:**
- Create: `test/plugin-management-closure.test.js`
- Create: `test/native-resource-management.test.js`
- Create: `scripts/plugin-closure-demo.js`
- Create: `docs/architecture/plugin-management-closure.md`
- Modify: none unless a test helper must be exported from an existing module.

**Interfaces:**
- Consumes: existing `createPluginControl`, `createPluginRuntimeService`, `buildArtifact`, `runPluginCommand`, provider catalog, and temporary AIH homes.
- Produces: deterministic test fixtures and a demo command that reports machine-readable evidence for each closure stage.

- [ ] **Step 1: Write failing AIH lifecycle tests.** Cover pack/validate/accept, enable, contribution call, disable, call rejection, restart/recovery, uninstall protection while referenced, and doctor output. Use a temporary home and in-process supervisor factory; do not use the user's real AIH home.
- [ ] **Step 2: Write failing native capability matrix tests.** Load every provider from `contracts/providers/manifest.json` and assert that the new matrix returns one of `supported`, `partial`, `projection-only`, or `unsupported` with a non-empty reason for every resource type.
- [ ] **Step 3: Implement only test fixtures/demo orchestration.** Reuse current runtime APIs; the demo should print JSON containing `install`, `enable`, `use`, `disable`, `uninstall`, and `restart` results, without secrets.
- [ ] **Step 4: Run focused tests and demo.** Run `node --test test/plugin-management-closure.test.js test/native-resource-management.test.js` and `node scripts/plugin-closure-demo.js --json`. Expected initial result: AIH existing path passes; native resource cases expose missing manager APIs and remain red until later tasks.
- [ ] **Step 5: Commit the baseline harness.**

```bash
git add test/plugin-management-closure.test.js test/native-resource-management.test.js scripts/plugin-closure-demo.js docs/architecture/plugin-management-closure.md
git diff --cached --check
git commit -m "test(plugins): add resource closure harness"
```

## Task 2: Make AIH plugin usage a first-class documented and tested closure

**Files:**
- Modify: `lib/plugins/control/cli.js`
- Modify: `lib/server/plugin-management-routes.js`
- Modify: `lib/plugins/control/control.js` only if the closure test finds a missing state transition.
- Modify: `test/plugin-management-closure.test.js`
- Modify: `README.md`
- Modify: `docs/architecture/plugin-management-closure.md`

**Interfaces:**
- Consumes: existing artifact and runtime APIs.
- Produces: stable `aih plugin` usage contract with explicit JSON output for every lifecycle stage.

- [ ] **Step 1: Add failing CLI contract assertions.** Verify `aih plugin --help`, `validate`, `pack`, `install`, `list`, `enable`, `call`, `disable`, `uninstall`, and `doctor` all return stable output and exit codes. Verify `call` after disable returns a typed error, not an uncaught exception.
- [ ] **Step 2: Implement missing output/diagnostic normalization.** Keep control-plane ownership unchanged; add explicit `state`, `instanceId`, `generation`, contribution and diagnostic fields. Never return configuration values or secrets.
- [ ] **Step 3: Add a checked-in minimal demo manifest/readme.** The existing Echo plugin must show exact commands for `pack → install → enable → call → disable → doctor`; include the expected JSON fields and the server prerequisite.
- [ ] **Step 4: Run the actual demo against an isolated temporary server.** Capture install, enable, call, disable, restart, recovery and uninstall results in the closure evidence document.
- [ ] **Step 5: Run focused tests and commit.**

```bash
node --test test/plugin-management-closure.test.js
node scripts/plugin-closure-demo.js --json
git add lib/plugins/control/cli.js lib/server/plugin-management-routes.js test/plugin-management-closure.test.js README.md docs/architecture/plugin-management-closure.md examples/plugins/echo
git diff --cached --check
git commit -m "feat(plugins): close AIH plugin lifecycle demo"
```

## Task 3: Add descriptor-driven native resource capability model

**Files:**
- Modify: `core/providers/model.go`
- Modify: `core/providers/native.go`
- Modify: `core/providers/builtins.go`
- Modify: `lib/provider-catalog.js`
- Modify: `contracts/providers/manifest.json` through the repository's generator/check workflow.
- Create: `lib/native-resources/provider-resource-registry.js`
- Create: `lib/native-resources/resource-status.js`
- Create: `test/native-resource-management.test.js`

**Interfaces:**
- Consumes: `getProviderNativeBoundary`, provider IDs, generated provider manifest.
- Produces:

```js
getNativeResourceCapabilities(provider) -> {
  plugin: { mode, paths, commands, reason },
  skill: { mode, paths, commands, reason },
  mcp: { mode, configFiles, commands, format, reason }
}
```

`mode` is one of `native`, `projection-only`, `unsupported`, or `unknown`; `reason` is required unless mode is `native`.

- [ ] **Step 1: Extend the Go native boundary schema with data-only resource facts.** Add plugin, skill, and MCP fields without provider-specific execution code. Preserve empty declarations for providers that do not support a resource.
- [ ] **Step 2: Add only verified facts for Codex, Claude, OpenCode, Pi, Cline and the remaining providers.** Codex/Claude/OpenCode/Cline facts come from current native help and known config paths; Pi must be `projection-only` until a real Pi binary/package is present. Do not infer unsupported paths.
- [ ] **Step 3: Generate and check the provider manifest.** Run `npm run providers:generate` and `npm run providers:check`; inspect the diff and ensure no unrelated generated changes enter the checkpoint.
- [ ] **Step 4: Implement the registry and status normalizer.** Consumers query the registry by resource type, never compare provider names in dispatch code.
- [ ] **Step 5: Run matrix tests and commit.**

```bash
npm run providers:generate
npm run providers:check
node --test test/native-resource-management.test.js
git add core/providers/model.go core/providers/native.go core/providers/builtins.go contracts/providers/manifest.json lib/provider-catalog.js lib/native-resources test/native-resource-management.test.js
git diff --cached --check
git commit -m "feat(providers): declare native resource management boundaries"
```

## Task 4: Implement generic Skill manager and convert implicit injection into a managed resource

**Files:**
- Create: `lib/native-resources/skill-manager.js`
- Create: `lib/native-resources/managed-resource-store.js`
- Modify: `lib/cli/services/ai-cli/provider-skill-installer.js`
- Modify: `lib/cli/services/ai-cli/provider-runtime-env.js`
- Modify: `lib/cli/commands/root/router.js`
- Modify: `lib/cli/app.js` and `lib/cli/bootstrap/root-dispatch.js` only for dependency wiring.
- Create: `lib/cli/services/skill-command.js` or equivalent focused command module.
- Create: `test/skill-manager.test.js`
- Create: `assets/provider-skills/aih-demo/SKILL.md`
- Create: `assets/provider-skills/aih-demo/instructions.md`
- Modify: `docs/architecture/plugin-management-closure.md`

**Interfaces:**
- `aih skill list [--provider <id>] [--json]`
- `aih skill install <skillDir> [--provider <id>|--all-supported]`
- `aih skill enable <skillId> [--provider <id>]`
- `aih skill disable <skillId> [--provider <id>]`
- `aih skill remove <skillId> [--provider <id>]`
- `aih skill doctor [--provider <id>]`

- [ ] **Step 1: Write failing manager tests.** Cover Claude/Codex native skill directory projection, OpenCode/AGY managed instruction projection, foreign-file preservation, idempotence, disable/remove cleanup, unsupported provider reasons, and provider account-scoped paths.
- [ ] **Step 2: Implement managed resource state.** Persist only resource ID, digest, target provider/scope, enabled state, projection mode and timestamps through the existing AIH state ownership; do not add an environment variable.
- [ ] **Step 3: Refactor `aih-collab` to call the manager.** Existing interactive launch behavior remains compatible, but the manager becomes the owner; `skillInject=0` remains a compatibility switch inside the existing context variable.
- [ ] **Step 4: Add `aih-demo` skill.** Its instructions must produce an unambiguous marker such as `AIH_SKILL_DEMO_OK` when invoked, and the demo must use a real provider session or a deterministic provider-compatible prompt harness.
- [ ] **Step 5: Run install/list/enable/disable/remove and an actual skill-use probe for every locally available native provider.** For absent providers report projection-only/unavailable, never claim use.
- [ ] **Step 6: Commit the skill closure.**

```bash
node --test test/skill-manager.test.js
node bin/ai-home.js skill --help
node bin/ai-home.js skill doctor --json
git add lib/native-resources lib/cli/services/ai-cli/provider-skill-installer.js lib/cli/services/ai-cli/provider-runtime-env.js lib/cli/commands/root/router.js lib/cli/app.js lib/cli/bootstrap/root-dispatch.js test/skill-manager.test.js assets/provider-skills/aih-demo docs/architecture/plugin-management-closure.md
git diff --cached --check
git commit -m "feat(skill): add managed cross-provider skills"
```

## Task 5: Implement MCP server manager and a real local stdio demo server

**Files:**
- Create: `lib/native-resources/mcp-config-adapters.js`
- Create: `lib/native-resources/mcp-manager.js`
- Create: `lib/native-resources/mcp-stdio-client.js`
- Create: `examples/mcp/aih-demo-server.js`
- Modify: `lib/cli/commands/root/router.js`
- Modify: `lib/cli/app.js` and `lib/cli/bootstrap/root-dispatch.js` for wiring only.
- Create: `test/mcp-manager.test.js`
- Modify: `docs/architecture/plugin-management-closure.md`

**Interfaces:**
- `aih mcp list [--provider <id>] [--json]`
- `aih mcp add <name> --command <file> [--arg <value> ...] [--provider <id>|--all-supported]`
- `aih mcp test <name> [--provider <id>]`
- `aih mcp tools <name> [--provider <id>]`
- `aih mcp enable <name> [--provider <id>]`
- `aih mcp disable <name> [--provider <id>]`
- `aih mcp remove <name> [--provider <id>]`

MCP adapter contract:

```js
readConfig(provider, scope) -> { servers, source, format }
writeConfig(provider, scope, servers) -> projection result
testServer(server, options) -> { ok, tools, diagnostics }
```

- [ ] **Step 1: Write failing stdio protocol tests.** The demo server must implement initialize, tools/list, tools/call for `aih_echo` and `aih_list_files` with bounded input/output; the client must enforce request IDs, timeout, EOF and malformed-response errors.
- [ ] **Step 2: Write failing config adapter tests.** Cover JSON configs (OpenCode/Claude/Cline-style), Codex TOML `mcp_servers.*` projection, atomic writes, foreign entries, enable/disable/remove, and unsupported providers.
- [ ] **Step 3: Implement the bounded stdio client.** It must never print secrets or unbounded tool output and must terminate the child on timeout/cancel.
- [ ] **Step 4: Implement provider config adapters from the native resource registry.** No provider-name branches in the manager; format-specific code lives in adapter modules registered by format.
- [ ] **Step 5: Implement CLI commands and demo server.** `test` and `tools` use the client directly; `enable` writes the native projection and `disable` removes only AIH-owned entries.
- [ ] **Step 6: Run the full MCP closure.** Add → test → tools → enable → actual tool call → disable → remove for every locally usable provider format; record unsupported reasons for the rest.
- [ ] **Step 7: Commit.**

```bash
node --test test/mcp-manager.test.js
node bin/ai-home.js mcp --help
node bin/ai-home.js mcp test aih-demo --json
git add lib/native-resources examples/mcp lib/cli/commands/root/router.js lib/cli/app.js lib/cli/bootstrap/root-dispatch.js test/mcp-manager.test.js docs/architecture/plugin-management-closure.md
git diff --cached --check
git commit -m "feat(mcp): add managed server lifecycle and stdio demo"
```

## Task 6: Add native plugin projection managers for Codex, Claude, OpenCode and Pi

**Files:**
- Create: `lib/native-resources/native-plugin-manager.js`
- Create: `lib/native-resources/native-plugin-adapters/codex.js`
- Create: `lib/native-resources/native-plugin-adapters/claude.js`
- Create: `lib/native-resources/native-plugin-adapters/opencode.js`
- Create: `lib/native-resources/native-plugin-adapters/pi.js`
- Modify: `lib/cli/commands/root/router.js`
- Create: `test/native-plugin-manager.test.js`
- Create: `examples/native-plugins/aih-demo/` with one portable command/tool fixture and generated host projections.
- Modify: `docs/architecture/plugin-management-closure.md`

**Interfaces:**
- `aih native plugin list [--provider <id>] [--json]`
- `aih native plugin install <package-or-dir> --provider <id>`
- `aih native plugin enable <pluginId> --provider <id>`
- `aih native plugin disable <pluginId> --provider <id>`
- `aih native plugin remove <pluginId> --provider <id>`
- `aih native plugin doctor [--provider <id>]`

- [ ] **Step 1: Inspect real native CLI plugin help and package formats.** Capture Codex `plugin`/`mcp` help, Claude `--plugin-dir`/plugin management help, OpenCode `plugin add/list/remove` help, and Pi package/extension rules. Store sanitized snapshots under `docs/providers/` only if they differ from the existing baseline.
- [ ] **Step 2: Write failing adapter tests.** Each adapter must report its projection target, install mode, enablement state, and unsupported reason. Tests must preserve user-owned files and use temporary homes.
- [ ] **Step 3: Implement Codex/Claude adapters.** Codex uses its declared plugin command or config projection; Claude uses plugin directory/zip and settings only where the installed CLI accepts it. Do not claim global installation if the CLI only supports session `--plugin-dir`.
- [ ] **Step 4: Implement OpenCode adapter.** Use its native package command/config and preserve server/TUI distinction. Verify actual plugin load with a fixture command or tool.
- [ ] **Step 5: Implement Pi adapter.** Generate a valid Pi package/extension projection; if Pi is not installed locally, run the package shape/conformance test and report runtime unavailable rather than claiming execution.
- [ ] **Step 6: Add portable demo fixture.** The fixture must expose one command and one tool with a deterministic marker and host-specific entrypoints generated from one source definition.
- [ ] **Step 7: Run native plugin install/use/disable/remove probes and commit.**

```bash
node --test test/native-plugin-manager.test.js
node bin/ai-home.js native plugin doctor --json
git add lib/native-resources/native-plugin-manager.js lib/native-resources/native-plugin-adapters examples/native-plugins test/native-plugin-manager.test.js docs/providers docs/architecture/plugin-management-closure.md lib/cli/commands/root/router.js
git diff --cached --check
git commit -m "feat(native): manage provider plugin projections"
```

## Task 7: Add provider-wide capability/doctor report and all-provider evidence

**Files:**
- Create: `lib/native-resources/provider-resource-doctor.js`
- Modify: `lib/cli/commands/root/router.js`
- Create: `test/provider-resource-doctor.test.js`
- Modify: `docs/architecture/plugin-management-closure.md`
- Create: `docs/architecture/provider-resource-closure-matrix.md`

**Interfaces:**
- `aih provider capabilities [--json]`
- `aih provider doctor [--provider <id>] [--json]`

- [ ] **Step 1: Write matrix tests.** Every provider ID in the generated contract must have plugin, skill and MCP states; each non-supported state must include a reason and source descriptor path.
- [ ] **Step 2: Implement doctor aggregation.** Combine descriptor facts, installed resource state, native executable availability, projection file existence, and last test result. Do not probe network or spend model tokens by default.
- [ ] **Step 3: Add explicit imported-platform gap rows.** Record DSH bundle/profile, OpenCode server/TUI/RPC, Pi package/extension, and AIH artifact differences; each row states `supported`, `adapter-needed`, `projection-only`, or `unsupported` with evidence.
- [ ] **Step 4: Run the all-provider audit.** Capture JSON output and human-readable summary; ensure no provider silently disappears.
- [ ] **Step 5: Commit.**

```bash
node --test test/provider-resource-doctor.test.js test/native-resource-management.test.js
node bin/ai-home.js provider capabilities --json > /tmp/aih-provider-capabilities.json
node bin/ai-home.js provider doctor --json > /tmp/aih-provider-doctor.json
git add lib/native-resources/provider-resource-doctor.js lib/cli/commands/root/router.js test/provider-resource-doctor.test.js docs/architecture/plugin-management-closure.md docs/architecture/provider-resource-closure-matrix.md
git diff --cached --check
git commit -m "feat(providers): report plugin skill and MCP closure"
```

## Task 8: Full verification, demo index, and delivery audit

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/plugin-management-closure.md`
- Modify: `docs/architecture/provider-resource-closure-matrix.md`
- Create: `docs/demos/plugin-skill-mcp-demo-index.md`

- [ ] **Step 1: Run focused test suites.** Run all new plugin, skill, MCP, native plugin, and provider doctor tests.
- [ ] **Step 2: Run the actual demo commands in isolated temporary homes.** Record exact commands, result summaries, native executable availability, and unsupported reasons. No secrets or full environment dumps.
- [ ] **Step 3: Run repository policy checks and relevant existing tests.** At minimum: `node --test` for changed Node tests, `npm run providers:check`, `npm run providers:usage -- --write` only if provider CLI upgrades changed, and targeted CLI/server lifecycle tests.
- [ ] **Step 4: Verify native CLI demos.** Codex, Claude, OpenCode and Cline are locally available in the current machine; Pi and other absent binaries must remain explicit `runtime_unavailable` rows. Do not report package-shape tests as runtime success.
- [ ] **Step 5: Run `git diff --check`, inspect cached diff/status, and commit docs/evidence only.**
- [ ] **Step 6: Final requirement audit.** For each resource/provider/host requirement, link the exact test, demo command, matrix row, or runtime output that proves it. Leave the goal active if any requirement is only inferred.

## Design Pattern Reporting

The final implementation report must use this exact structure for changed modules:

```text
file/module -> pattern -> why it was used -> verification evidence
```

Expected concrete patterns are:

- `lib/native-resources/provider-resource-registry.js` → Registry + Capability Negotiation → provider-neutral resource facts → matrix tests.
- `lib/native-resources/*-manager.js` → Facade + Command → stable CLI actions over provider adapters → focused command/adapter tests.
- `lib/native-resources/mcp-config-adapters.js` → Adapter + Strategy Registry → JSON/TOML/native CLI differences → config projection and real stdio tests.
- `lib/native-resources/managed-resource-store.js` → Revisioned State Store → idempotent enable/disable/remove and ownership → restart/cleanup tests.
- `lib/plugins/control/runtime-service.js` → Generation/Revisioned Snapshot → in-flight AIH plugin calls remain bound to old versions → lifecycle closure tests.

If a proposed change cannot be placed in one of these focused boundaries, stop and split the task before implementation.
