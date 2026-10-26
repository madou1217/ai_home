# Plugin Management Closure Evidence

状态：实现闭环证据（能力子集先行；未验证宿主保持显式边界）

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
command name. The current machine resolves Codex, Claude, OpenCode and Cline.
Other provider runtime rows remain unavailable until a native runtime can be
resolved and its version probe succeeds; capability declarations are independent.

## Final verification checkpoint (2026-10-26)

Fresh runs on this branch:

```sh
node --test test/*.test.js                         # 173 passed, 0 failed
npm run providers:check                            # passed
node scripts/plugin-closure-demo.js --json         # passed
node scripts/skill-native-demo.js --provider claude --binary /Users/model/.local/bin/claude
node scripts/skill-native-demo.js --provider codex --binary /Users/model/.codex/packages/standalone/releases/0.164.0-aarch64-apple-darwin/bin/codex.aih-original
node scripts/skill-native-demo.js --provider opencode --binary /Users/model/Library/pnpm/bin/opencode
node scripts/mcp-native-demo.js                    # Codex/Claude/OpenCode/Cline passed
node scripts/native-plugin-demo.js                 # Codex/Claude/OpenCode passed
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
- Managed MCP: complete for Codex, Claude, OpenCode and Cline; provider-specific
  account projection and native config loading proven.
- Native plugins: Codex/Claude bundled skills and the OpenCode shared-core tool
  loop pass all four stages. Pi/DSH unified host management, native SDK tools,
  cleanup and account-isolated launch propagation are runtime-proven above.
- Remaining provider resource projections retain their explicit capability and
  runtime status; this does not establish behavior on every installed provider.

No claim of full cross-host parity is made for OpenCode TUI/RPC or Pi/DSH
model-selected agent loops. The native SDK execution subset is proven separately.

The native plugin manager now uses the descriptor's `plugins.adapter` registry
(`codex-marketplace`, `claude-skills-dir`, `opencode-local`, `native-directory`,
`cordis-patch`).
The manager contains no provider-name execution branches. Codex marketplace paths,
OpenCode JSON/JSONC selection, foreign-target protection, semver validation,
snapshot tamper detection, and native remove/re-enable behavior are covered by the
latest native plugin tests.

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
projection while clearly leaving runtime execution for a machine with the actual
DeepSeek Harness or Pi host.
