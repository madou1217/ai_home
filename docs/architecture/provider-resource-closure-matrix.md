# Provider resource closure matrix

Status: descriptor-complete; runtime evidence is recorded in `docs/architecture/plugin-management-closure.md`.

Generated from `contracts/providers/manifest.json`; runtime availability is intentionally omitted from this checked-in static matrix. Refresh with `node bin/ai-home.js provider capabilities --json`.

| Provider | Plugin | Skill | MCP | Evidence source |
|---|---|---|---|---|
| codex | supported | supported | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| gemini | supported | supported | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| claude | supported | supported | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| agy | unsupported (plugin_boundary_not_declared) | projection-only (skill_projection_only) | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| opencode | supported | projection-only (skill_projection_only) | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| grok | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | projection-only (mcp_projection_not_declared) | core/providers/native.go |
| qoder | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | unsupported (mcp_not_declared) | core/providers/native.go |
| qodercn | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | unsupported (mcp_not_declared) | core/providers/native.go |
| kimi | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | unsupported (mcp_not_declared) | core/providers/native.go |
| kiro | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| zcode | unsupported (native_boundary_missing) | unsupported (native_boundary_missing) | unsupported (native_boundary_missing) | core/providers/native.go |
| codebuddy | supported | supported | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| codebuddycn | supported | supported | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| workbuddy | supported | supported | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| workbuddycn | supported | supported | projection-only (mcp_projection_not_declared) | core/providers/native.go |
| cline | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | projection-only (mcp_native_execution_unverified) | core/providers/native.go |

## Imported host gaps

| Host | State | Reason | Evidence |
|---|---|---|---|
| deepseek | supported when runtime probe passes; otherwise projection-only | native_owned_patch_boot_tool_cleanup_and_headless_loop_verified; Web/TUI entrypoints remain separate | scripts/deepseek-plugin-managed-demo.mjs |
| opencode | supported | server_plugin_native_tool_loop_verified; TUI/RPC entrypoints remain separate | scripts/opencode-plugin-native-demo.js |
| pi | supported when runtime probe passes; otherwise runtime-unavailable | native_directory_tool_command_cleanup_and_cli_tool_loop_verified; TUI/RPC entrypoints remain separate | scripts/pi-plugin-native-demo.js --managed |
| aih | supported | canonical_signed_artifact_and_shared_core_supervised_host_verified | scripts/aih-portable-plugin-demo.js |

WorkBuddy provider runtime evidence (the static MCP state remains projection-only
because the provider contract separates declaration from machine-specific execution):

| Provider | Runtime | Plugin | Skill | MCP | Evidence |
|---|---|---|---|---|---|
| workbuddy | WorkBuddy AI 2.161.0 bundled CodeBuddy lite runtime | native marketplace + four-stage use | native skills + four-stage use | `.codebuddy.json`, native connected + two stdio tool calls | `scripts/workbuddy-resource-native-demo.js` |

`provider doctor` adds a targeted installed-package discovery and real version
probe for the external Pi/DSH harnesses. Absence from PATH is not proof that the
runtime is absent. `runtime.available` is independent of management adapter
closure; it never upgrades the whole host to supported by itself.

CodeBuddy 2.177.0 uses the native marketplace adapter and `.mcp.json`. Its
international and CN descriptors select independent native roots; CN also supplies
the vendor's two `internal` region values to native resource commands. The family
demo accepts `--provider codebuddy|codebuddycn --binary <codebuddy-path>`. Both
variants passed plugin and standalone Skill use across all four lifecycle stages.
Plugin use records direct expansion or a two-request native `Skill` loop: the
local fixture requests an advertised skill, then verifies the loaded body in the
following request. Both mechanisms were observed, including within the CN version. MCP evidence
is native connection plus two AIH stdio calls, not model-selected MCP execution.
WorkBuddy CN and other CodeBuddy versions remain unverified.

OpenCode MCP execution evidence now additionally includes the actual native
model/tool loop: `scripts/opencode-mcp-tool-loop-demo.js` requires two native tool
completion events and tool results returning to subsequent model requests, across
all four management stages. The static projection-only descriptor state above
is unchanged; machine/version evidence is recorded separately (OpenCode 1.17.18).

Claude Code 2.1.310 also has native MCP execution evidence through
`scripts/claude-mcp-tool-loop-demo.js`: deferred ToolSearch, echo, file listing,
correlated results and four-stage lifecycle. The aggregate includes both Claude
and OpenCode native loops; Codex/Cline rows retain their existing evidence scope.

Codex CLI 0.164.0 now also has native MCP execution evidence through
`scripts/codex-mcp-tool-loop-demo.js`: namespaced Responses calls, correlated
results and native successful MCP completion events across four lifecycle stages.
The aggregate covers Codex/Claude/OpenCode native loops; Cline remains at the
management/connection evidence level. Static descriptor states remain unchanged.

Gemini CLI 0.65.0 now has native extension and standalone Skill execution evidence
through `scripts/gemini-resource-native-demo.js`. The same canonical package carries
`gemini-extension.json`; native `activate_skill` loads its existing bundled Skill.
Each resource passes enable/disable/re-enable/remove with native activation events
and request-body evidence. This does not claim arbitrary JavaScript plugin API
compatibility or native model-driven MCP execution for Gemini.
