# Provider resource closure matrix

Generated from `contracts/providers/manifest.json`; runtime availability is intentionally omitted from this checked-in static matrix. Refresh with `node bin/ai-home.js provider capabilities --json`.

| Provider | Plugin | Skill | MCP | Evidence source |
|---|---|---|---|---|
| codex | supported | supported | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| gemini | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| claude | supported | supported | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| agy | unsupported (plugin_boundary_not_declared) | projection-only (skill_projection_only) | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| opencode | supported | projection-only (skill_projection_only) | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| grok | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | projection-only (mcp_projection_not_declared) | core/providers/native.go |
| qoder | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | unsupported (mcp_not_declared) | core/providers/native.go |
| qodercn | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | unsupported (mcp_not_declared) | core/providers/native.go |
| kimi | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | unsupported (mcp_not_declared) | core/providers/native.go |
| kiro | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | projection-only (mcp_native_execution_unverified) | core/providers/native.go |
| zcode | unsupported (native_boundary_missing) | unsupported (native_boundary_missing) | unsupported (native_boundary_missing) | core/providers/native.go |
| codebuddy | supported | supported | projection-only (mcp_projection_not_declared) | core/providers/native.go |
| codebuddycn | supported | supported | projection-only (mcp_projection_not_declared) | core/providers/native.go |
| workbuddy | supported | supported | projection-only (mcp_projection_not_declared) | core/providers/native.go |
| workbuddycn | supported | supported | projection-only (mcp_projection_not_declared) | core/providers/native.go |
| cline | unsupported (plugin_boundary_not_declared) | unsupported (skill_boundary_not_declared) | projection-only (mcp_native_execution_unverified) | core/providers/native.go |

## Imported host gaps

| Host | State | Reason | Evidence |
|---|---|---|---|
| deepseek | adapter-needed | deepseek_harness_manifest_adapter_not_registered | spec:2026-10-25-universal-agent-plugin-design §4.1 |
| opencode | supported | server_plugin_local_projection_verified; TUI/RPC entrypoints remain separate | scripts/native-plugin-demo.js |
| pi | runtime-unavailable | pi_binary_not_found_on_this_machine; package_projection_only | examples/native-plugins/aih-demo/package.json |
| aih | supported | signed_artifact_and_supervised_host | scripts/plugin-closure-demo.js |
