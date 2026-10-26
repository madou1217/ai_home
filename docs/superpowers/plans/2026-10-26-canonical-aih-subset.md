# Canonical Package to AIH Subset Implementation Plan

> **For agentic workers:** Execute inline with superpowers:executing-plans. Reuse the existing plugin-management worktree; create no branch or worktree. Repository instructions override test-writing steps: use real Host/CLI demos and preserve existing tests.

**Goal:** Pack the same canonical package exercised on Pi/DSH/OpenCode into an AIH artifact and call its unchanged portable core through the supervised AIH Host.

**Architecture:** Add a source-manifest projection shared by offline CLI validation and artifact packaging. Legacy `plugin.json` remains readable. Canonical packages declare the AIH adapter export, adapter/transport versions and native contribution metadata inside `agentPlugin.hosts.aih`; generated `plugin.json` exists only inside the artifact. Preserve artifact hashes, signing, acceptance, permissions and generation ownership.

**Tech Stack:** Node CommonJS control modules, ESM host adapter, existing Cordis Host and RPC, offline `.aih-plugin` packaging.

**Spec:** `docs/superpowers/specs/2026-10-25-universal-agent-plugin-design.md`, M1 capability subset.

## Global Constraints

- No new `AIH_*`, provider-name dispatch, test files, branches or worktrees.
- The portable core stays byte-identical across the four host entrypoints.
- Never mutate the source package while projecting a manifest.
- Reject missing adapter exports, unsupported required portable capabilities, unsupported adapter/transport versions and conflicting manifest sources before packaging/loading.
- Canonical permissions map explicitly: `private-state` becomes AIH `state`; unknown filesystem scopes are rejected. Existing AIH permission acknowledgement remains mandatory.
- Tools map to declared AIH command contributions for this subset. This is callable Host behavior, not an AIH model-tool registry or full common SDK.
- Checkpoint each coherent unit with explicit paths and review the cached diff.

## Task 1: Shared source manifest and real AIH adapter

**Files:**
- Create `lib/plugins/control/source-manifest.js`: `readSourceManifest(dir)` and canonical-to-AIH manifest projection.
- Modify `lib/plugins/control/artifact.js`: use the shared source reader and inject a virtual `plugin.json` into canonical artifacts without changing source files.
- Modify `lib/plugins/control/cli.js`: share the reader for validate/pack and document canonical input in help.
- Create `examples/native-plugins/aih-demo/dist/hosts/aih.mjs`: default Cordis plugin; `ctx.effect` owns `setupDemo`, tool registration delegates to `ctx.aih.register`.
- Modify canonical sample `package.json`: add `./aih` and `agentPlugin.hosts.aih` with adapter version 1, RPC transport version 2 from the generated contract, and one `command` contribution `aih-demo.tool.aih_demo` version 1. Legacy artifact `protocolVersion: 1` stays independent.
- Modify `lib/native-resources/portable-plugin-conformance.js`: require the AIH entry and validate its projected native manifest.

**Interfaces:**
- `readSourceManifest(dir)` returns `{ manifest, generated }`; `generated` is true only for a canonical source.
- Legacy manifests use the existing schema unchanged. Canonical input requires `manifestVersion: 1`, `portableApiVersion: 1`, `engines.aih`, `exports['./aih']`, and `hosts.aih` versions/contributions.
- Supported required portable capability pairs are `lifecycle@1` and `tool.register@1`. Missing optional capabilities do not create fake ports.
- Artifact file reading uses an explicit Buffer for virtual `plugin.json`; ordinary files retain existing source-file digest handling.

- [x] Reproduce the current failure with real `aih plugin validate examples/native-plugins/aih-demo --json` (`plugin_manifest_missing`).
- [x] Implement the focused reader and artifact virtual-file path, preserving legacy source behavior.
- [x] Add the sample AIH adapter and canonical metadata, then run real `validate --load`, `pack`, and artifact inspection; verify the source still has no `plugin.json`.
- [x] Use temporary package copies to check missing AIH export, unsupported required capability, permission scope and version rejection; create no test files.
- [x] Run existing Node regression and legacy Echo runtime demo, inspect staged paths and commit.

## Task 2: Same-package lifecycle evidence and documentation

**Files:**
- Create `scripts/aih-portable-plugin-demo.js`: isolated canonical pack/install/enable/call/disable/re-enable/restart/remove/doctor flow.
- Modify `docs/architecture/plugin-management-closure.md`, the universal spec, quickstart and design-patterns inventory.

**Interfaces:**
- Call `aih-demo.tool.aih_demo` with `{ text: 'portable-input' }`; expect `AIH_PLUGIN_DEMO_OK:portable-input` from the shared core.
- Use the actual offline CLI for validate/pack, existing `createPluginSystem` for a real supervised Host, and acknowledge declared permissions explicitly in the isolated fixture.
- After disable, the contribution must reject. Re-enable/restart must call the same core again; remove must leave no installed artifact/instance. Always stop Host processes and remove temporary homes.

- [x] Run the new demo on Node 22.21.0 and current Node 26, and retain structured stage evidence.
- [x] Run the three native shared-core host demos after changing the canonical package to prove no adapter regression.
- [x] Report the subset precisely: canonical artifact/call is proven; standalone SDK publication, hot upgrade, full common API, TUI/RPC and remote model reasoning remain separate.
- [ ] Run existing regression and provider check, commit exact paths, integrate into `main` preserving peer changes, and push after verification.
