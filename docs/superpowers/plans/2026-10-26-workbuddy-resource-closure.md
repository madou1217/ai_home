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

- [ ] Register `native-marketplace`; declare it for the CodeBuddy family and use the native cache target pattern.
- [ ] Own a distinct local marketplace per plugin/provider. Copy the immutable package, write a digest-checked local marketplace manifest, then invoke native add/install/list. Verify returned install path and package digest before recording success.
- [ ] Disable/remove through native uninstall/marketplace removal and owned-cache cleanup; re-enable reconstructs the native installation. Reject modified owned packages, marketplace manifests or foreign registrations.
- [ ] Handle the prior directory-only record as an explicit legacy projection: allow owned cleanup/migration, never report it as a native installation.
- [ ] Declare `.codebuddy.json` with the proven `json-stdio` codec. Verify managed global MCP projection through native list/connect and actual AIH stdio tool calls.
- [ ] Exercise install, disable, re-enable and remove with the real bundled runtime, then commit.

## Task 3: Actual use demos and delivery

Files: new `scripts/workbuddy-resource-native-demo.js`, shared native fixture/client helpers as needed, provider closure matrix, quickstart, closure evidence and design-patterns inventory.

- [ ] Use isolated HOME/config/user-data roots and a local deterministic inference fixture. Skill and installed plugin prompts must omit the expected marker; require the native request to contain the installed Skill body.
- [ ] Prove positive/negative stages for Skill and plugin behavior, and MCP native discovery/connect plus two real stdio tool calls. Record unsupported native entrypoints explicitly if the vendor lite runtime omits them.
- [x] Run the original Node suite, provider check and prior aggregate. Review runtime/ownership changes before integration; fix Important findings.
- [ ] Commit exact paths, integrate into main preserving peer changes, verify main and push. Preserve honest evidence boundaries for the other provider/site variants.
