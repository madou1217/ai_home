# WorkBuddy Native Resource Closure Plan

**Goal:** Make the installed WorkBuddy AI runtime participate in real managed plugin, Skill and MCP lifecycle demos.

**Architecture:** Extend the existing native boundary with an optional runtime descriptor and select its handler through the provider facade. Keep standalone CLI availability separate from bundled native-resource execution. Use the vendor's actual marketplace registry for family plugins and its observed JSON stdio MCP boundary. Preserve provider-specific configuration roots and AIH ownership checks.

**Scope evidence:** WorkBuddy AI 2.161.0 is installed at its descriptor's macOS App path. Its bundled CLI requires `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`; plain `--version` bypasses module loading and is insufficient execution proof. A bare managed package directory yields `plugin list: []`. Native marketplace add/install yields an enabled plugin in `plugins/cache/<market>/<id>/<version>`. Native MCP add/list uses `.codebuddy.json` and connects to the local demo server.

## Constraints

- Reuse the existing plugin-management worktree and branch; create neither.
- No new test files, tags, `AIH_*` variables, provider-name dispatch or credential copying.
- Use descriptor installation paths for the correct WorkBuddy product/site.
- Every mutation targets owned files or isolated demo homes; foreign/native user edits fail closed.
- Preserve existing Codex/Claude/OpenCode/Pi/DSH/AIH demos and original regression tests.

## Task 1: Resource runtime descriptor and facade

Files: `core/providers/model.go`, `native.go`, `builtins.go`, `catalog.go`, generated provider manifest, `lib/providers/index.js`, new `lib/native-resources/provider-native-runtime.js`, `provider-resource-doctor.js`, and native plugin manager context.

- [x] Declare optional `nativeBoundary.runtime` with `handler`, relative `entry` and static `env`; WorkBuddy selects `desktop-node`, the observed bundled entry, and its existing native lite flag.
- [x] Deep-copy the runtime's environment map in the Go catalog and regenerate/check the manifest.
- [x] Add `Facade.getNativeResourceRuntimeStrategy(provider)`; expose runtime descriptor, declared desktop paths, native config home keys and desktop user-data key.
- [x] Implement `resolveProviderResourceRuntime(provider, options)` returning `{ command, args, env, source }` or null, with native CLI resolution followed by the descriptor-selected desktop handler.
- [x] Doctor probes command plus fixed args/environment and reports bundled entry provenance. Plugin adapters receive this process specification without adding provider branches.
- [x] Run actual WorkBuddy version/help and provider doctor, existing regression, provider check, inspect staged paths and commit.

## Task 2: Real native marketplace and MCP management

Files: new `native-plugin-adapters/native-marketplace.js`, adapter registry, provider native declarations, `mcp-config-adapters.js` only if the observed existing `json-stdio` codec needs adjustment.

- [x] Register `native-marketplace` for the verified WorkBuddy runtime and use the native cache target pattern. Other CodeBuddy site variants remain separate unverified boundaries.
- [x] Own a distinct local marketplace per AIH home/plugin/provider. Copy the immutable package and digest-check the complete marketplace tree, then invoke native add/install/list. Verify returned install path and package digest before recording success.
- [x] Disable/re-enable through native disable/enable, preserving data. Remove through native uninstall with `--keep-data`, marketplace removal and owned-cache cleanup. Reject modified owned packages, marketplace manifests or foreign registrations. Accept only the observed native `.orphaned_at` timestamp after uninstall.
- [x] Handle the prior directory-only record as an explicit legacy projection: allow owned cleanup/migration on reinstall, never report it as a native installation.
- [x] Declare `.codebuddy.json` with the proven `json-stdio` codec. Verify managed global MCP projection through native list/connect and actual AIH stdio tool calls.
- [x] Exercise install, disable, re-enable and remove with the real bundled runtime, then commit. Follow-up checkpoints cover multi-plugin ownership, legacy migration, version replacement and invalid-upgrade preflight.

## Task 3: Actual use demos and delivery

Files: new `scripts/workbuddy-resource-native-demo.js`, shared native fixture/client helpers as needed, provider closure matrix, quickstart, closure evidence and design-patterns inventory.

- [x] Use isolated HOME/config/user-data roots and a local deterministic inference fixture. Skill and installed plugin prompts omit the expected marker; require the native request to contain the installed Skill body. Every stage must exit zero without timeout, send a request, and return the expected final result event.
- [x] Prove positive/negative stages for Skill and plugin behavior, and MCP native discovery/connect plus two real stdio tool calls. Native model-driven MCP tool selection is not established by the stdio client probe.
- [x] Run the original Node suite, provider check and prior aggregate. Review runtime/ownership changes before integration; fix Important findings.
- [x] Commit exact paths, integrate into main preserving peer changes, verify main and push. Delivery `fe2a3ed7`: main/upstream equal; 111 existing checks pass on Node 22.23.2, provider contract check and CLI help pass, final WorkBuddy four-stage plugin/Skill plus native MCP connect/two stdio calls pass. Independent focused review found no remaining Critical/Important issue after fixes. Other provider/site variants and imported-host agent-loop gaps remain part of the active overall goal.
