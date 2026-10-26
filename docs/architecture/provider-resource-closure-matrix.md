# Provider resource closure matrix

Status: descriptor-complete; runtime evidence is recorded in `docs/architecture/plugin-management-closure.md`.

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
| deepseek | projection-only | native_profile_and_sdk_tool_lifecycle_verified; unified_aih_lifecycle_pending | scripts/deepseek-plugin-native-demo.mjs |
| opencode | supported | server_plugin_local_projection_verified; TUI/RPC entrypoints remain separate | scripts/native-plugin-demo.js |
| pi | projection-only (runtime availability is probed locally) | native_tool_command_cleanup_verified; unified_aih_lifecycle_pending | scripts/pi-plugin-native-demo.js |
| aih | supported | signed_artifact_and_supervised_host | scripts/plugin-closure-demo.js |

`provider doctor` adds a targeted installed-package discovery and real version
probe for the external Pi/DSH harnesses. Absence from PATH is not proof that the
runtime is absent. `runtime.available` is independent of management adapter
closure; it never upgrades the whole host to supported by itself.
