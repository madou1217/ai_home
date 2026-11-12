# Plugin Management Closure Evidence

状态：实现闭环证据（能力子集先行；未验证宿主保持显式边界）

统一入口：`npm run resources:closure`（或 `node scripts/resource-closure-demo.js --json`）。
它组合本文件列出的宿主 demo 与 provider capability，逐项输出 Plugin、Skill、MCP
的 management/use 证据和 gaps；聚合命令通过不等于所有 provider 已完成。

本文件记录插件、Skill、MCP 和原生 provider 管理的实际闭环证据。每个资源必须证明安装/投影、启用、实际使用、停用和移除；静态 manifest 或目录存在不能单独证明完成。

用户入口：[插件、Skill、MCP 与原生插件快速上手](../demos/plugin-skill-mcp-quickstart.md)。跨宿主设计：[Universal Agent Plugin Architecture](../superpowers/specs/2026-10-25-universal-agent-plugin-design.md)。

## Codex / Claude native plugin use follow-up (2026-10-26)

```sh
node scripts/native-plugin-use-demo.js codex
node scripts/native-plugin-use-demo.js claude
```

Both pass enabled/disabled/re-enabled/removed stages with the actual native
client and isolated homes. The installed package is the native plugin fixture,
not the standalone managed skill fixture. Its prompt contains the skill name
but not the expected response. The local inference fixture returns the marker
only when it sees the installed plugin's skill body in the native request.
Each positive and negative stage reached the fixture and exited successfully;
only positive stages contained the body and returned `AIH_PLUGIN_DEMO_OK`.

Codex 0.164.0 reports the skill as `aih-demo:aih-demo` through its own
`skills/list`; using only `$aih-demo` did not load that body. The demo invokes
`$aih-demo:aih-demo`, and Claude Code 2.1.310 uses `/aih-demo:aih-demo`.
The Codex compatibility manifest now explicitly declares `skills: "./skills/"`,
matching the [official plugin packaging guide](https://developers.openai.com/plugins/build/plugins).
The aggregate native plugin demo includes these probes as `pluginUse` evidence.
They prove bundled native skill invocation, not JavaScript tool execution or
account-isolated launch propagation.

## Pi / DeepSeek runtime follow-up (2026-10-26)

### DeepSeek unified host management follow-up

`aih native plugin install/enable/disable/remove/list/doctor --host deepseek`
now copies the canonical package to an owned host directory and generates a
digest-checked DSH patch. The registered `cordis-patch` adapter resolves
`exports["./deepseek"]` to a file URL; no package-manager state or credentials
are copied into account state. `prepareDshHarness` and `prepareDshTuiHarness`
forward enabled patches via the descriptor's `--patch` launch argument.

```sh
node scripts/deepseek-plugin-managed-demo.mjs
```

The actual AIH CLI performs all four lifecycle stages. DSH's native
`--dump-config` composes the generated patch, then its own `boot` / Loader
mounts that projection and ToolRuntime executes the shared core. Account-specific
DSH_HOME and generated patch arguments are checked at each stage. Disposing the
native root withdraws contributions and invalidates retained handlers. Disabled
and removed stages contain no managed row or native tool. Editing the package
or generated patch fails closed before cleanup or launch. The aggregate native
plugin demo now runs this managed path; the separate original DSH demo still
proves native package-manager `add/remove` behavior.

This establishes the self-contained portable adapter subset. It does not install
arbitrary third-party bundle dependencies or prove browser/TUI/model-selected
agent-loop behavior.

The owned projection accepts one `insert` with one enabled entry containing
`id`, `name`, `config` and an optional `disabled: false`. It preserves native
configuration and rebases only the entry module name. Grouping, conditions,
multi-entry patches and profile overrides are rejected during conformance,
rather than silently losing their semantics. The demo verifies a configured
tool description through the real Loader and ToolRuntime.

The earlier PATH-only runtime-unavailable conclusion below was incomplete. Both
packages are present in this machine's pnpm v11 store: Pi
`@earendil-works/pi-coding-agent@0.84.4` and DSH `@deepseek-ai/dsh@0.2.1-rc.2`.
The original sample entries only returned marker objects; the following demos
first failed on absent native registration and now exercise a shared portable
operation from `dist/core.mjs` through real host adapters:

```sh
node scripts/pi-plugin-native-demo.js [installed-pi-package-directory]
node scripts/deepseek-plugin-native-demo.mjs [installed-dsh-package-directory]
```

- Pi uses its native `install/remove`, then its real SDK ResourceLoader and
  AgentSession. Enabled and re-enabled stages execute `aih_demo` and `/aih-demo`;
  disabled/removed stages discover no tool. `session_shutdown` invalidates the
  shared core so retained handlers reject. All four stages pass without inference.
- DSH uses native `plugin --profile demo add/remove` and `--dump-config` in a
  temporary profile. Its bundle patch resolves the installed package's
  `./deepseek` entry. The actual DSH ToolRuntime executes `aih_demo`; Cordis Fiber
  disposal withdraws registration and runs core cleanup. A fresh Fiber repeats
  the call. This proves native profile package management and SDK tool lifecycle,
  not a browser/TUI agent loop or a model-selected tool call.

The same package's Pi and DSH engine ranges now match the exercised versions.
These SDK/native-package proofs supersede the historical statements that the
hosts were wholly absent. Both demos now discover packages when the optional
directory argument is omitted. Doctor uses the external harness catalog and
targeted npm/pnpm package lookup, then runs the real CLI version probe (including
DSH's Node 22 `runCli` wrapper). Both report `runtime.available: true` on this
machine. Subsequent Pi and DSH unified host-management evidence is described in
the follow-up sections; runtime availability is independent of that evidence.
The demos pass on both Node 26.12.1 and the supported Node 22.21.0 runtime.

### Pi unified host management follow-up

`aih native plugin install/enable/disable/remove/list/doctor --host pi` now uses
the external harness descriptor and the same managed-resource store and ownership
checks as provider-native plugins. Records carry `host: pi`, never `provider: pi`.
The native directory adapter writes the canonical package into
`.pi/agent/extensions/<id>`, where Pi's loader discovers `pi.extensions`.

```sh
node scripts/pi-plugin-native-demo.js --managed
```

This runs the actual AIH CLI for enabled/disabled/re-enabled/removed stages,
checks list/doctor, and loads the result with real Pi. It also calls
`preparePiHarness` for an isolated account, then uses its generated extension
arguments in the actual SDK loader; all four account-harness stages pass too.
Modified owned projections fail before launch; enabled resource paths are carried
through the descriptor's `launchArgument` rather than copying credentials or
account state. Node 22.21.0 and Node 26.12.1 probes pass. This proves package,
tool, command and shutdown behavior; remote inference and Pi-specific UI remain
separate evidence.

The aggregate `scripts/native-plugin-demo.js` now runs the Pi and DSH managed
demos when runtime packages are available. Codex/Claude list/config checks carry
`toolExecutionVerified: false`; their separate bundled-skill invocation evidence
is under `pluginUse`. OpenCode's completed tool loop has its own execution proof.

## OpenCode tool-loop follow-up (2026-10-26)

```sh
node scripts/opencode-plugin-native-demo.js /opt/homebrew/bin/opencode
node scripts/opencode-plugin-native-demo.js /Users/model/Library/pnpm/bin/opencode
```

Both OpenCode 1.18.18 and 1.17.18 pass enabled/disabled/re-enabled/removed stages.
Each stage runs the native CLI with an isolated home. Positive stages advertise
`aih_demo`, execute the same `dist/core.mjs` used by Pi/DSH, emit a completed
native `tool_use` event, and send the returned value into the next model request.
Negative stages reach the fixture but contain neither tool schema nor result.
The aggregate demo now requires this evidence and reports
`toolExecutionVerified: true` for OpenCode.

The earlier initialization timeout was a probe input bug: `execFile` left its
stdin pipe open while native `run` awaited `Bun.stdin.text()`. Closing that pipe
before waiting for exit fixes the stall. Direct-entry probes used `spawn` with
stdin ignored and therefore did not reproduce the problem. The canonical root
export remains the portable core; native loading uses `./server` or `main`.

This is a real native agent/tool loop against a local deterministic inference
fixture, not remote model reasoning. TUI/RPC and hot-reload cleanup remain
separate capabilities. Node 22.21.0 and Node 26.12.1 runs pass; only local package
artifacts are seeded into the isolated home, never auth or user configuration.

## AIH Plugin baseline

### Canonical package artifact follow-up (2026-10-26)

```sh
node scripts/aih-portable-plugin-demo.js
```

The same `examples/native-plugins/aih-demo` package now declares `./aih` and
`agentPlugin.hosts.aih`. Offline validate/pack share `source-manifest.js`;
artifact packaging generates a virtual `plugin.json`, without changing source
files. The AIH adapter runs the unchanged portable core through a declared
command contribution in the real supervised Cordis Host and RPC boundary.

The demo passes on Node 22.21.0 and Node 26.12.1: CLI validate/load, Ed25519
signed pack and trusted acceptance, permission rejection before acknowledgement,
enabled call, disabled rejection, re-enable, process restart/recovery, removal
and empty doctor. A source digest comparison proves projection did not modify
the canonical package. The legacy Echo lifecycle continues to pass.

The first subset supports declared `lifecycle@1` and `tool.register@1`; required
unknown capabilities or adapter/transport versions are rejected. AIH tools map
to `command` contributions, not an AIH model-selected tool registry. The common
SDK publication, other Portable ports, hot upgrades and complete M1 migration
remain separate work. The aggregate native demo now includes this AIH host and
the WorkBuddy provider runtime as a seventh resource lane.

Independent review reproduced and closed two contract issues before integration:
the reader now uses AIH's dotted IDs and artifact limits (a 5 MiB, 274-file
package passed), and canonical transport 2 is checked against the real RPC
contract independently of legacy manifest protocol 1. A changed virtual manifest
byte fails digest verification. The corrected nine-stage Node 26 demo was also
rerun independently. The final seven-lane aggregate and original 105-test Node 22
regression suite pass, with no new test files.

### WorkBuddy native resource follow-up (2026-10-26)

```sh
node scripts/workbuddy-resource-native-demo.js
```

WorkBuddy AI 2.161.0 ships a CodeBuddy runtime inside the installed app. The
descriptor selects its lite bundle through the declared bundled runtime handler;
it is not misreported as a standalone CLI installation. The native plugin
adapter owns an AIH marketplace and uses WorkBuddy's real marketplace registry,
so the native `plugin list` row appears only after marketplace installation.
Disable/uninstall, re-enable and marketplace removal are checked against the
returned install path and owned package digest.

The demo passes four plugin stages and four separate Skill stages. Positive
stages send the installed body to a deterministic local fixture and return
`AIH_PLUGIN_DEMO_OK` / `AIH_SKILL_DEMO_OK`; negative stages send neither. MCP
uses the observed `.codebuddy.json` JSON-stdio projection, finds `aih_echo` and
`aih_list_files`, performs a real `WORKBUDDY_MCP_OK` call, and verifies native
MCP reports the server connected.

The deterministic harness is:

```bash
node --test test/plugin-management-closure.test.js
node scripts/plugin-closure-demo.js --json
```

It uses `examples/plugins/echo` and a temporary AIH home. The expected stages are:

```text
pack → install → enable → use → restart → use-after-restart → disable → uninstall → doctor
```

The demo only prints a temporary-home marker, digest, plugin id, generation, lifecycle state, and explicit marker values. It does not print credentials, configuration values, management keys, or full request bodies.

## Native resource baseline

`test/native-resource-management.test.js` reads the generated provider manifest and emits a result for `plugin`, `skill`, and `mcp` for every provider. Before the managers are installed, the honest states are `projection-only` or `unsupported`; the test rejects missing reasons and rejects silently claiming `supported`.

The matrix will be upgraded as Tasks 3–7 add descriptor-driven managers and real probes. A provider remains `projection-only` until the corresponding native CLI or runtime is exercised.

## Imported platform gap tracking

| Platform | Existing source model | AIH closure status at baseline |
|---|---|---|
| DeepSeek Harness | npm bundle, `dsh.bundle.patch`, profile ordered layers, Cordis lifecycle | canonical package projection now verified; runtime adapter remains unavailable |
| OpenCode | npm/local server/TUI/RPC plugin entrypoints, Effect Scope/generation | Existing session hook bridge only; native plugin manager not yet closed |
| Pi | npm/git/local package with `pi.extensions`, extension factory and session events | Runtime package may be absent; projection/conformance required before runtime claim |
| AIH | signed/hashed `.aih-plugin`, supervised Host, generation and RPC | Echo lifecycle harness is the first executable closure |

The final evidence must replace each planned status with a command, test, or real runtime output. Unsupported provider capabilities stay visible with a stable reason.

## Managed skills: CLI checkpoint (2026-10-26)

On the `codex/plugin-management-closure` branch:

```sh
node bin/ai-home.js skill install assets/provider-skills/aih-demo --provider claude --json
node bin/ai-home.js skill list --provider claude --json
node bin/ai-home.js skill disable aih-demo --provider claude --json
node bin/ai-home.js skill enable aih-demo --provider claude --json
node bin/ai-home.js skill doctor --provider claude --json
node bin/ai-home.js skill remove aih-demo --provider claude --json
```

`install` enables immediately; `--all-supported` selects all declared projection
adapters, even if their native executable is absent. This is a projection operation,
not evidence of native execution. Without `--provider`, enable/disable/remove act
on the selected skill's existing installations. Each provider result is returned,
and a partial failure yields exit 1. All actions support `--help`.

Skill resources follow the existing host-shared storage policy; account launches
reuse those resources. There is no account-private skill override in this checkpoint.
Native directories are used for Codex/Claude and declared CodeBuddy-family entries;
OpenCode and AGY use managed instruction blocks. Unmodified legacy `aih-collab`
symlinks/copies/blocks are adopted; foreign or edited content is preserved. Explicit
CLI disable/remove survives subsequent launch reconciliation. `skillInject=0`
continues to disable the resource through the same manager.

Validation: 22 tests passed across skill-manager, skill-command, native-resource-
registry and native-resource-management, including a subprocess invoking the real
AIH CLI with an isolated home. `aih skill --help` and `aih skill doctor --json`
exit 0. These checks establish management and projection, not real model use.
Native use probes are still being added; Task 4 is not complete yet.

Native probe follow-up: [2026-10-26 skill native closure evidence](../demos/2026-10-26-skill-native-closure.md)
records Codex, Claude and OpenCode passing enabled/disabled/re-enabled/removed
stages with actual native CLIs and a local deterministic inference fixture.
The probe exposed and fixed OpenCode's config-root/data-root mismatch. Latest
focused validation is 27/27, including the existing AIH plugin lifecycle suite.
Remote inference and remaining provider/native-plugin/MCP closures remain open.

## Managed MCP: CLI and native demo checkpoint (2026-10-26)

The MCP manager now owns the lifecycle below:

```sh
node bin/ai-home.js mcp add aih-demo --provider claude \
  --command "$PWD/examples/mcp/aih-demo-server.js" --json
node bin/ai-home.js mcp test aih-demo --provider claude --json
node bin/ai-home.js mcp tools aih-demo --provider claude --json
node bin/ai-home.js mcp enable aih-demo --provider claude --json
node bin/ai-home.js mcp call aih-demo aih_echo \
  --args-json '{"text":"AIH_MCP_DEMO_OK"}' --provider claude --json
node bin/ai-home.js mcp disable aih-demo --provider claude --json
node bin/ai-home.js mcp remove aih-demo --provider claude --json
```

`add` records a bounded stdio definition; `enable` writes only the provider's
verified configuration shape; `test`, `tools`, and `call` run the server directly
through the bounded JSON-RPC client. `list` and `doctor` redact argument values and
environment values. Existing provider entries remain untouched. User-modified AIH
entries fail closed before remove/replace. Cline's account-scoped
`data/settings/cline_mcp_settings.json` is projected again during provider runtime
preparation so an enabled host resource reaches isolated account sessions.

Verified native configuration formats:

| Provider | Projection | Native executable | Evidence |
|---|---|---|---|
| Codex | `config.toml` `[mcp_servers.<name>]` | codex-cli 0.164.0 | `codex mcp list` showed enabled and then empty |
| Claude | `.claude/.claude.json` `mcpServers` | Claude Code 2.1.310 | `claude mcp list` reported Connected and then empty |
| OpenCode | `.config/opencode/opencode.json` `mcp` local command array | OpenCode 1.17.18 | `opencode mcp list` reported connected and then empty |
| Cline | `.cline/data/settings/cline_mcp_settings.json` `mcpServers.*.transport` | Cline 3.0.74 | `cline config --json` reported the global server and then `mcp: []` |

The native probe is reproducible with:

```sh
node scripts/mcp-native-demo.js
```

It created isolated homes, ran manager `test → tools → call` against the real
`aih-demo-server.js`, invoked each locally installed native CLI after enable and
disable, and removed all temporary files. All four providers passed. The fixture
returned `AIH_MCP_DEMO_OK` only from a real `tools/call` response; it does not spend
upstream model tokens.

The latest focused MCP, skill, native-plugin, provider-doctor, resource-matrix
and existing AIH plugin lifecycle suites all pass; the full Node suite is 173/173
and `npm run providers:check` also passes. Providers whose descriptor has MCP commands/config paths but no verified
projection adapter remain explicitly projection-only or unsupported. This avoids
claiming closure for provider-native formats that have not been observed.

## Native plugin closure checkpoint (2026-10-26)

The portable fixture is [examples/native-plugins/aih-demo](../../examples/native-plugins/aih-demo). One `package.json` declares `agentPlugin` metadata, and host projections are generated from the same package:

```sh
node bin/ai-home.js native plugin install examples/native-plugins/aih-demo --provider claude --json
node bin/ai-home.js native plugin list --provider claude --json
node bin/ai-home.js native plugin disable aih-demo --provider claude --json
node bin/ai-home.js native plugin enable aih-demo --provider claude --json
node bin/ai-home.js native plugin remove aih-demo --provider claude --json
node scripts/native-plugin-demo.js
```

The initial projection checkpoint used isolated homes and real native binaries.
The runtime follow-up sections above supersede this historical table:

| Host | Native version | Native evidence | Result |
|---|---:|---|---|
| Codex | 0.164.0 | `plugin marketplace add` + `plugin add` + `plugin list --json`; removal made installed list empty | passed |
| Claude Code | 2.1.310 | `plugin list --json` showed `aih-demo@skills-dir`; disable removed it | passed |
| OpenCode | 1.17.18 | local package path projected into `opencode.json`; native executable accepted the config path and manager removed it | passed projection; plugin execution remains host-specific |
| Pi | unavailable | package contains `pi.extensions` entry and shape is preserved | runtime-unavailable |
| DeepSeek Harness | unregistered in AIH provider catalog | canonical `agentPlugin` fields and `./deepseek` host entry are projection-verified; no DSH adapter/CLI was found | projection-only / runtime adapter needed |

`aih native plugin list/doctor` reports only metadata and redacts package
arguments. User-owned files are preserved; edited owned projections fail closed.
Codex's marketplace is local and disposable under the isolated `CODEX_HOME`.
OpenCode server, TUI and RPC entrypoints remain separate host capabilities as
specified by the universal plugin design; this checkpoint verifies the server
package/config projection and records the remaining host execution gap.

## Provider-wide audit command

```sh
node bin/ai-home.js provider capabilities --json
node bin/ai-home.js provider doctor --json
```

The output includes every generated provider ID, plugin/skill/MCP state, source
contract path, local native CLI availability and imported host rows for DeepSeek,
OpenCode, Pi and AIH. Unknown providers fail closed and every non-supported state
has a reason. The checked-in matrix is [provider-resource-closure-matrix.md](provider-resource-closure-matrix.md).

The CLI composition root now resolves these executables with the same
`resolveProviderCliPath` facade used by native launches. Descriptor binary names
and managed install roots are honored; a provider ID is not assumed to be its
command name. The current machine resolves Codex, Claude, OpenCode and Cline as
standalone CLIs, plus WorkBuddy through its installed desktop bundle. Other
provider runtime rows remain unavailable until a native runtime can be resolved
and its version probe succeeds; capability declarations are independent.

## DeepSeek official headless tool loop (2026-10-27)

`node scripts/deepseek-plugin-tool-loop-demo.js` uses the real AIH CLI to
install/disable/enable/remove the canonical package, resolves that same managed
state through `buildManagedHostPluginArgs`, and runs the installed DSH
0.2.1-rc.2 CLI against an isolated official `dsh-base + dsh-headless` profile.
Node 22 and the existing `resolveDshNodePath` helper provide its native module
lookup. No installed runtime or `lib/harness/` source is modified.

The local Chat Completions fixture is shared with the Pi demo. Enabled and
re-enabled each produce two requests, an `aih_demo` tool call, a completed
native result event containing the unchanged shared core's result, that result
in the following request and the exact final answer. Disabled and removed each
produce one request with no plugin tool and return `PLUGIN_NOT_LOADED`.
Telemetry and auxiliary title generation are disabled in this temporary profile.
The existing DSH managed SDK/profile/cleanup runner includes the new headless
loop while keeping those evidence layers explicitly separate.

This proves official headless execution of AIH-managed patches, not the existing
AIH Web profile's model loop or DSH Web/TUI parity. Those remain outstanding.

## Pi native CLI tool loop (2026-10-27)

`node scripts/pi-plugin-tool-loop-demo.js` invokes the actual AIH CLI host
lifecycle, then runs Pi 0.84.4 with the exact account-specific arguments and
environment returned by `preparePiHarness` for that same managed state. It uses
an isolated HOME, the unchanged canonical demo package, and a local Chat
Completions fixture. All four managed lifecycle stages
pass. Enabled/re-enabled each require two requests, a native
`tool_execution_end` event with the shared core result, the exact result in the
next model request, and the final assistant message. Disabled/removed each send
one request without the tool schema or execution event and return
`PLUGIN_NOT_LOADED`. A nonzero exit, timeout, absent request or fixture error
fails the probe.

`pi-plugin-native-demo.js --managed` now includes this loop in addition to its
existing SDK loader/command/shutdown and account-launch-argument checks. The
combined runner passes under Node 22.23.2; the standalone loop also passes under
Node 26.12.1. The existing regression suite remains 111/111 and provider contract
check passes. This closes the Pi headless agent-loop evidence gap; TUI/RPC and
DSH Web model-loop evidence remain separate. No `lib/harness/` code is changed.

## WorkBuddy ownership hardening checkpoint (2026-10-27)

The WorkBuddy marketplace adapter now uses a distinct deterministic marketplace
per AIH home/provider/plugin. Its ownership helper validates the complete local
marketplace tree, native install path and bounded regular JSON registry files
before native operations. This is necessary because WorkBuddy itself turns a
malformed `installed_plugins.json` into an empty successful list and may overwrite
that malformed registry on install. AIH rejects that state instead.

Disable/enable uses native toggles and retains plugin data. Remove uses native
uninstall with `--keep-data`, removes the owned marketplace even after disable,
and validates the observed `.orphaned_at` timestamp before deleting the remaining
cache. Legacy directory-only projections are unhealthy while enabled; reinstall
migrates a matching owned package into the actual marketplace and then removes
the old directory. Draft installations using the old fixed marketplace name are
explicitly rejected for migration rather than silently adopted.

Fresh isolated evidence: `/tmp/aih-workbuddy-hardened-demo.json` proves plugin and
Skill enable/disable/re-enable/remove with zero exit, no timeout, a real native
request and exact final result in every stage, plus native MCP Connected and two
AIH stdio calls. `/tmp/aih-workbuddy-ownership-evidence-final.log` records 16 real
checks including two simultaneous plugins, edited/foreign/oversize/symlink state,
malformed installation/settings files preserved on refusal, native command
failure, external disable recovery, remove after disable and legacy migration.
The seven-lane aggregate passed on Node 22.23.2; the existing 105 checks passed on
Node 22.23.2 and Node 26.12.1. No test files or web source were added or changed.

Independent review found the malformed-registry issue and a Codex macOS
`/tmp`/`/private/tmp` path-normalization regression; both were corrected, and the
reviewer independently re-ran those cases successfully. Follow-up review also
reproduced a version replacement defect: the new package had been used to verify
the old marketplace. The manager now supplies the verified old snapshot for
cleanup and delegates marketplace replacement to its adapter. A real
`1.0.0` to `1.0.1` upgrade passed. A foreign new-version target is rejected before
removing the old installation; independent verification preserved both the old
healthy installation and the foreign sentinel.

Malformed native manifests exposed another vendor behavior: native validation
can succeed, install records an `unknown` version, and native list hides that
broken row. AIH now parses the immutable package's native manifest and requires
its name/version to match the canonical package before mutation. A fresh invalid
upgrade probe confirmed rejection with the previous installation still healthy.
Replacement includes best-effort compensation for runtime failures, but arbitrary
mid-command failures are not claimed to be transactionally reversible.

After merging concurrent main changes into the existing worktree, the original
suite now has 111 passing checks on Node 22.23.2, all seven aggregate lanes pass,
and provider contract/help/doctor checks pass. The WorkBuddy checkpoint was
integrated and pushed as `fe2a3ed7`, preserving concurrent changes; main and
origin/main were equal at verification. A final focused independent review found
no remaining Critical/Important issue after the fixes. Remaining provider gaps
are still outstanding; these seven lanes do not establish all-provider closure
or model-driven MCP tool selection on WorkBuddy.

## Earlier verification checkpoint (2026-10-26)

The 173-test counts below are historical results from the earlier task
checkpoints. This task had added 13 test files despite the user's no-new-tests
rule. Those files have now been removed; none existed on `main`. Current
acceptance uses the executable native demos and the repository's original
regression suite. The original repository test files are preserved.

Fresh checks after removing those files: Node 22.21.0 original regression suite
103 passed, 0 failed; AIH pack/install/enable/call/restart/disable/uninstall/doctor
passed; Codex/Claude/OpenCode skill demos each passed four stages; the MCP demo
passed native discovery/configuration plus two AIH stdio tool calls for each of
Codex/Claude/OpenCode/Cline. The native plugin aggregate passed across the
original hosts plus WorkBuddy,
including the OpenCode tool loop and Pi/DSH managed SDK execution described above.

Integration into `main` preserved its concurrent changes. The integrated Node 22
suite passes 105 tests, the seven-lane native aggregate passes again, provider
contract generation/check passes, and native-plugin/skill/MCP CLI help exits
successfully. Relative to the pre-integration `main`, this task changes no
`web/` source or existing test file.

Fresh runs on this branch:

```sh
node --test test/*.test.js                         # current original suite: 105 passed
npm run providers:check                            # passed
node scripts/plugin-closure-demo.js --json         # passed
node scripts/skill-native-demo.js --provider claude --binary /Users/model/.local/bin/claude
node scripts/skill-native-demo.js --provider codex --binary /Users/model/.codex/packages/standalone/releases/0.164.0-aarch64-apple-darwin/bin/codex.aih-original
node scripts/skill-native-demo.js --provider opencode --binary /Users/model/Library/pnpm/bin/opencode
node scripts/mcp-native-demo.js                    # Codex/Claude/OpenCode/Cline passed
node scripts/native-plugin-demo.js                 # Codex/Claude/OpenCode passed
node scripts/workbuddy-resource-native-demo.js     # WorkBuddy plugin/Skill/MCP passed
node bin/ai-home.js provider doctor --json         # healthy, 16 providers, 4 host rows
```

The skill probes each passed four stages. The MCP probe performed two real tool
calls per provider (`aih_echo`, `aih_list_files`) and checked native enable/disable
output. The initial native plugin probe checked native list/config discovery; the
follow-ups above add actual bundled-skill and native tool execution. All temporary
homes and local fixture processes were removed by their runners.

Overall closure status is now:

- AIH plugin lifecycle: complete and restart-proven.
- Managed skills: complete for Codex, Claude, OpenCode and AGY projection; actual
  native use proven for Codex, Claude and OpenCode.
- Managed MCP: complete for Codex, Claude, OpenCode, Cline and the tested Gemini
  CLI 0.65.0; provider-specific account projection and native config loading are
  proven per host.
- WorkBuddy: native marketplace plugin, Skill and `.codebuddy.json` MCP execution
  all pass isolated positive/negative or connected stages on the installed lite
  runtime.
- Native plugins: Codex/Claude bundled skills and the OpenCode shared-core tool
  loop pass all four stages. Pi/DSH unified host management, native SDK tools,
  cleanup and account-isolated launch propagation are runtime-proven above.
  Pi additionally passes the native headless CLI tool loop across all four stages.
- Remaining provider resource projections retain their explicit capability and
  runtime status; this does not establish behavior on every installed provider.
- Canonical-to-AIH artifact subset: the same package's shared core is now called
  through a signed artifact and supervised Host. Full common SDK extraction and
  the remaining M1 migration gates are distinct from this proven subset.

No claim of full cross-host parity is made for OpenCode or Pi TUI/RPC, or the DSH
Web/TUI model-selected agent loop. Pi and DSH headless inference use a deterministic local
model fixture; this proves runtime execution, not a remote model's tool-selection quality.

The current machine-level aggregate `/tmp/aih-resource-closure-final-proof.json`
contains 24 focused demo entries and reports `passed: true` with `gaps: []`.
WorkBuddy CN is independently verified through the
official WorkBuddy.app 5.9.2 bundle and its embedded CodeBuddy 2.165.0 runtime;
Plugin, Skill and deferred MCP loop all pass four lifecycle stages. One aggregate
run also recorded an unrelated native-plugin runner failure while an external
plugin synchronization process was still running; that runner failure is kept
separate from the passing WorkBuddy CN evidence.

The native plugin manager now uses the descriptor's `plugins.adapter` registry
(`codex-marketplace`, `claude-skills-dir`, `opencode-local`, `native-directory`,
`cordis-patch`, `native-marketplace`).
The manager contains no provider-name execution branches. Codex marketplace paths,
OpenCode JSON/JSONC selection, foreign-target protection, semver validation,
snapshot tamper detection, and native remove/re-enable behavior were checked by
the earlier checkpoint assertions and the real native probes.

Portable host import commands now make the remaining gap executable:

```sh
aih native plugin inspect examples/native-plugins/aih-demo --host deepseek --json
aih native plugin project examples/native-plugins/aih-demo --host deepseek \
  --out /tmp/aih-demo-deepseek --json
aih native plugin inspect examples/native-plugins/aih-demo --host pi --json
```

The canonical fixture has `agentPlugin.engines.deepseek`, `exports["./deepseek"]`,
`agentPlugin.engines.pi`, and `pi.extensions`. `project` writes a sanitized
`host-projection.json` and copies the package. This proves imported host shape and
projection. Native execution on the installed DeepSeek Harness and Pi packages
is proven separately by the managed follow-up demos above.

## CodeBuddy / CodeBuddy CN resource follow-up (2026-10-27)

Official `@tencent-ai/codebuddy-code@2.177.0` was installed in an isolated `/tmp`
prefix for verification, without changing the user's global CLI installation.
Both `codebuddy` and `codebuddycn` use the existing native marketplace adapter.
The CN runtime supplies the vendor's two `internal` region values; config roots
remain `.codebuddy` and `.codebuddy-cn`. This proves local config and execution
selection, not live CN account authentication.

The first real plugin-use probe failed despite successful installation/listing: the
new CLI can advertise plugin skills through its native `Skill` tool rather than
directly expanding the prompt. Repeated CN runs also showed direct expansion, so
the demo records the actual loading mode instead of assuming a fixed mechanism.
The local fixture now requests `Skill({skill: "aih-demo"})`
only when that skill is advertised, and returns success only after the following
model request contains the installed body. When a native Skill call is requested,
the demo requires exactly two requests
with body observations `[false, true]`. Direct expansion requires one request
with the expected body. Disabled/removed stages require one request without body
or Skill invocation. `loadingMode` distinguishes these outcomes in the evidence.
Standalone Skill stages retain their direct expansion.
All stages require a successful native process exit, no timeout and an exact final
answer. A `native-skill-tool` result proves the native tool loop; a
`direct-expansion` result proves prompt loading. Both use a deterministic local
model fixture and do not establish remote model reasoning.

CodeBuddy 2.177.0 reads MCP from `.mcp.json`; WorkBuddy AI's bundled 2.161.0
reads `.codebuddy.json`. Their descriptors now keep these facts separate. The
shared `scripts/workbuddy-resource-native-demo.js` accepts `--provider` and
`--binary`, exercises both resource lifecycles and two actual AIH stdio MCP calls,
and checks native MCP Connected plus absence after disable. The generalized
`scripts/workbuddy-mcp-tool-loop-demo.js` also verifies the deferred native model
tool loop for both `codebuddy` and `codebuddycn` on the tested 2.177.0 binary.
The official WorkBuddy.app 5.9.2 bundle separately embeds CodeBuddy 2.165.0;
its WorkBuddy CN Plugin/Skill stages and `.codebuddy.json` deferred MCP loop pass
all four lifecycle stages. This is separate from the CodeBuddy CN CLI lane and
does not establish arbitrary Web/TUI parity. Other versions require fresh probes.

## WorkBuddy deferred MCP model/tool loop (2026-10-27)

`node scripts/workbuddy-mcp-tool-loop-demo.js` closes the remaining WorkBuddy
MCP evidence gap on WorkBuddy AI 2.161.0. The real bundled CodeBuddy runtime
loads the AIH-projected `.codebuddy.json`; enabled and re-enabled stages expose
the deferred MCP protocol and complete `ToolSearch`, `DeferExecuteTool`, the
stdio MCP result, and the final `WORKBUDDY_MCP_OK` marker. Disabled and removed
stages have no connected MCP server, no deferred MCP schema or tool call, and
return `MCP_NOT_LOADED`.

The probe also runs the AIH MCP manager's direct `test`, `tools`, and `call`
operations against the same stdio server. Its fixture recognizes the nested
OpenAI-compatible `assistant.tool_calls` shape used by WorkBuddy and waits for
the native process's final result instead of terminating on the first result
event. This is local deterministic native protocol evidence; it does not claim
remote model reasoning, Web/TUI parity, or WorkBuddy CN parity.

The resource aggregate indexes this probe separately from the WorkBuddy
plugin/Skill/direct-MCP probe. A full aggregate run remains subject to external
host dependencies; for example, Codex can attempt a curated-plugin git fetch
before its isolated fixture starts. Such a timeout is an aggregate-run failure,
not a downgrade of the standalone WorkBuddy or Codex evidence.

The earlier 111-check regression count is historical: those resource test files
are absent from the current tracked checkout. This checkpoint uses actual native
demos and provider-manifest validation; it does not claim to have rerun absent
tests or recreate them. No harness implementation or WebUI source is changed.

After full resource closure, the user's requested harness audit must trace WebUI
CLI launch, terminology and module ownership, capability/parameter propagation,
account isolation, PTY/session lifecycle, reconnect/cancel/cleanup, and native
versus gateway entrypoints. That follow-up is read-only: deliver concrete findings
and a prioritized remediation plan before changing harness implementation.

Verification artifacts for this checkpoint: `/tmp/aih-codebuddy-resource-final.json`
and `/tmp/aih-codebuddycn-resource-final.json` (mode-specific loading checks),
`/tmp/aih-codebuddy-family-aggregate.json` (all seven pre-existing runtime lanes
passed, including WorkBuddy MCP absence after disable). `npm run providers:check`,
CLI help/capability output, JavaScript syntax and diff/encoding checks also pass.

## Cline native MCP tool loop (2026-10-27)

`node scripts/cline-mcp-tool-loop-demo.js [native-cli-path]` now proves the
missing Cline execution layer with Cline 3.0.74. The demo first uses Cline's
native `auth --provider openai-compatible --baseurl ...` command to create an
isolated temporary `providers.json`; it never reads or writes the user's real
Cline profile. The existing AIH MCP manager then projects the server into
`data/settings/cline_mcp_settings.json`, which the real CLI loads.

Enabled and re-enabled stages require two OpenAI-compatible streaming requests,
the native MCP schema, a completed `aih_echo` tool event, the returned nonce in
the following model request, and the exact final `AIH_NATIVE_MCP_OK`. Disabled
and removed stages require one request, no MCP schema or tool event, and
`MCP_NOT_LOADED`. This verifies Cline's native model/tool loop and the managed
projection lifecycle with a deterministic local fixture. It does not claim
remote-model reasoning, every Cline provider configuration, or Web/TUI parity.

The aggregate `scripts/mcp-native-demo.js` includes this demo, so the current
machine's Codex, Claude, OpenCode and Cline rows each carry native execution
evidence in addition to management and direct stdio checks.

## OpenCode native MCP tool loop (2026-10-27)

`node scripts/opencode-mcp-tool-loop-demo.js [native-cli-path]` now proves the
missing native execution layer using OpenCode 1.17.18 and the existing MCP
manager. `scripts/mcp-native-demo.js` includes this evidence in its OpenCode row.

Each run uses a temporary HOME, AIH state and working directory. The same managed
server goes through enable, disable, re-enable and remove. A local Chat Completions
fixture requests `aih_echo` with a fresh nonce, then `aih_list_files`; only the
isolated working directory contains the nonce-bearing filename. The fixture
accepts results only from tool-role messages with the matching call IDs, and the
demo separately checks both completed native tool events and exact final answer.
Enabled stages require three requests and both results; disabled/removed stages
require one request, no schema, no tool events and `MCP_NOT_LOADED`. The demo never
calls the AIH MCP client's `call` method to produce this native execution evidence.

The isolated OpenCode config disables its title agent, whose extra inference
request otherwise confounds the tool-loop count. Native permissions deny other
tools and allow the demo MCP namespace. No production harness is modified.
The local protocol fixture determines the tool selection; this proves real native
execution and result propagation, not remote-model reasoning or TUI/Web parity.

Fresh evidence: `/tmp/aih-mcp-with-native-loop.json` passes Codex, Claude, OpenCode
and Cline management/connection checks, and embeds the passing native-loop stages
for all four clients. Each client still has its own protocol and provider
configuration boundary; one client's local fixture does not establish parity for
the others.

## Claude native MCP tool loop (2026-10-27)

`node scripts/claude-mcp-tool-loop-demo.js [native-cli-path]` adds native Claude
Code 2.1.310 MCP execution to the same aggregate `scripts/mcp-native-demo.js`.
The initial request contains deferred MCP names rather than their schemas. The
fixture follows the actual host protocol: invoke `ToolSearch` for the advertised
echo/file-list tools, consume its result, invoke echo with a random nonce, invoke
file listing, then check both returned results before emitting the final marker.

Enabled and re-enabled stages require four requests, native ToolSearch output,
both tool schemas, matching `tool_use_id` results, native non-error tool-result
events, process success, and an exact final `AIH_NATIVE_MCP_OK`. Disabled/removed
stages require one request, neither deferred name nor schema, no MCP result
events and `MCP_NOT_LOADED`. A unique nonce-bearing file exists only in the
temporary working directory. The native command authorizes only the two MCP tools
through `--allowedTools`; it does not bypass all permissions. Managed config, HOME
and working state are isolated and removed on exit.

Evidence: `/tmp/aih-claude-mcp-loop.json` and the combined
`/tmp/aih-mcp-claude-opencode-loops.json`. This establishes native execution with
a deterministic local Anthropic protocol fixture, not remote-model reasoning,
Web/TUI coverage or parity for other providers. No harness code is changed.

## Codex native MCP tool loop (2026-10-27)

`node scripts/codex-mcp-tool-loop-demo.js [native-cli-path]` verifies Codex CLI
0.164.0 through the existing MCP manager. The Responses tool catalog places the
two tools under `mcp__aih_demo`; fixture calls preserve that namespace. Results
are accepted only from matching `function_call_output.call_id` entries, and native
completed `mcp_tool_call` events must name server `aih-demo`, the correct tool,
and a successful result containing the nonce or unique filename.

Default non-interactive approval rejected the first real call. The demo now passes
`-c mcp_servers.aih-demo.tools.aih_echo.approval_mode="approve"` and the corresponding
file-list override only for enabled stages. These are process-local overrides for
the two known demo tools, not global sandbox/approval bypasses. Disabled/removed
stages omit them so no partial server config is recreated. The relevant official
settings are documented in [Codex MCP](https://developers.openai.com/codex/mcp/)
and [configuration reference](https://developers.openai.com/codex/config-reference/).

Positive stages require three requests, both schemas and successful native events,
correlated tool outputs, and exact final `AIH_NATIVE_MCP_OK`. Negative stages
require one request, neither schema nor completed tool event, and `MCP_NOT_LOADED`.
Temporary HOME/AIH/config/work directories and local Responses fixture avoid real
credentials or remote inference. This does not prove remote-model reasoning or
Web/TUI entrypoints. No harness implementation changes are made.

Evidence: `/tmp/aih-codex-mcp-loop.json`; the aggregate
`/tmp/aih-mcp-three-native-loops.json` now includes Codex, Claude, OpenCode and
Cline native loops.

## Gemini native extension and Skill closure (2026-10-27)

Official `@google/gemini-cli@0.65.0` was installed only under
`/tmp/aih-gemini-resource-runtime` for verification. Its real `extensions` and
`skills` commands and loader confirm `.gemini/extensions/<id>/gemini-extension.json`
and `.gemini/skills/<id>` native discovery. The provider descriptor now declares
these paths. A focused `gemini-extension` adapter validates manifest name/version
before using the existing owned-directory lifecycle; invalid replacement manifests
are rejected before deleting the old version. Native extensions manually disabled
through Gemini's own settings remain subject to those settings; this adapter
materializes/removes owned directories and does not overwrite native preferences.

The canonical `aih-demo` package adds only a native extension manifest and reuses
its existing bundled Skill. `scripts/gemini-resource-native-demo.js` verifies both
that extension Skill and the independent managed Skill using actual Gemini:
enabled/re-enabled require native `activate_skill` success, installed body in the
next request, exactly two requests and the exact marker; disabled/removed require
no advertisement/activation/body, one request and `RESOURCE_NOT_LOADED`.
The local Google protocol fixture never supplies the body itself. Temporary
HOME/settings/workspace isolate state, `--skip-trust` trusts only the fresh demo
workspace for that process, and `--allowed-tools activate_skill` grants that tool
without broad YOLO mode (the CLI warns this flag is deprecated for future 1.0).

Fresh evidence: `/tmp/aih-gemini-resource-demo.json`, eight passing native stages.
A separate isolated ownership probe rejected modified-target removal, preserved
the previous extension on malformed replacement, then passed disable/re-enable/
remove. Provider generation/check, JavaScript syntax and diff checks pass.
This closes native extension-bundled Skill and standalone Skill use for the tested
version, not arbitrary Gemini extension features, JavaScript host API equivalence,
MCP model execution, remote reasoning, account launch propagation or Web/TUI parity.
No harness implementation is modified.

## Gemini native MCP tool loop (2026-10-27)

`node scripts/gemini-mcp-tool-loop-demo.js [native-cli-path]` now exercises the
same managed MCP lifecycle with the real Gemini CLI 0.65.0. Gemini's native
`settings.json -> mcpServers` configuration is projected by the AIH MCP manager;
the demo also performs direct `test`, `tools` and `call` operations before starting
the model loop.

The deterministic local Google-compatible fixture exposes the MCP schema only when
the managed resource is enabled. Enabled and re-enabled stages require a native
`mcp_aih-demo_aih_echo` tool event, a successful stdio result, a second model
request containing that result, and the exact final `AIH_GEMINI_MCP_OK`. Disabled
and removed stages require one request, no MCP schema or tool event, and
`MCP_NOT_LOADED`. The fresh run reported version `0.65.0`, direct tools
`aih_echo`/`aih_list_files`, and all four lifecycle stages passed.

The evidence is headless/native CLI execution against a local fixture. It does not
claim Gemini Web/TUI, remote-model reasoning, or account launch propagation. The
static provider descriptor remains `projection-only` so machine/version evidence
does not silently become a universal capability claim. The aggregate runner now
includes this demo as `mcp-loop:gemini` when a Gemini binary is available and
reports `gemini_binary_unavailable` otherwise.

The canonical package with the Gemini manifest also passed all seven existing
host lanes (`/tmp/aih-gemini-package-regression.json`): Codex, Claude, OpenCode,
Pi, DeepSeek, AIH and WorkBuddy. This checks that the additive native manifest
does not break their existing native plugin proofs.

Independent review exposed invalid-manifest snapshot poisoning: validation inside
the adapter originally occurred after snapshot creation. The manager now invokes
an optional adapter preflight before writing the immutable snapshot. An isolated
probe verified malformed Gemini JSON leaves no snapshot, then a corrected package
with the same id/version installs successfully. Existing adapters without a
preflight retain their prior behavior.

## Current-main WorkBuddy runtime recheck (2026-10-29)

The current `main` checkout reran both WorkBuddy probes after the historical
closure commit. `node scripts/workbuddy-resource-native-demo.js` passed against
WorkBuddy 2.161.0 using the bundled `desktop-node` runtime: plugin and Skill
stages (`enabled`, `disabled`, `re-enabled`, `removed`) all exited successfully,
and the installed body was observed only in the enabled stages. Direct native
MCP management connected to the local fixture and exposed `aih_echo` and
`aih_list_files`; disabling the resource removed the native connection.

`node scripts/workbuddy-mcp-tool-loop-demo.js` also passed on the same runtime.
Enabled and re-enabled stages each observed the native `ToolSearch` → tool call →
stdio result sequence and returned `WORKBUDDY_MCP_OK`; disabled and removed stages
returned `MCP_NOT_LOADED` without a tool schema or call. This is fresh local
deterministic native evidence for WorkBuddy AI 2.161.0. It does not establish
WorkBuddy CN, arbitrary CodeBuddy versions, remote reasoning, or Web/TUI parity.

## Current-main Cline runtime recheck (2026-10-29)

`node scripts/cline-mcp-tool-loop-demo.js` passed against Cline 3.0.74 from
`/opt/homebrew/bin/cline` with its local deterministic inference fixture. The
enabled and re-enabled stages each advertised and executed the projected MCP
tool, observed its result in the next request, and returned
`AIH_NATIVE_MCP_OK`. Disabled and removed stages sent one request without an MCP
schema or tool call and returned `MCP_NOT_LOADED`.

This rerun confirms the managed projection and local native MCP loop only. It
does not resolve the separate Cline refresh-token/account duplication and
model/plan validation investigation, nor does it provide an upstream response
body or Web/TUI parity.
