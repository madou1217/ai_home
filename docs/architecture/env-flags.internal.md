# 内部变量清单（不要手工设置）

> 生成命令：`npm run env:inventory -- --write`　生成时间：2026-11-02T18:33:48.030Z
> 覆盖 `lib / bin / scripts / core`，共 **65** 个非公开 `AIH_*` 变量；公开的 10 个见 [env-flags.md](./env-flags.md)。
> 这些名字由 aih 自己设置给子进程，或属实验/调试/测试钩子：**不承诺兼容**，升级可能改名或删除。不要把这里的东西写进部署脚本。

## 分类概览

| 分类 | 数量 | 含义 |
| --- | --- | --- |
| path | 4 | 数据/目录/仓库路径 |
| network | 2 | 端点 / 代理 / 端口 |
| flag | 3 | 开关与逃生门（环境准入） |
| credential | 8 | 凭据与密钥（文档只写变量名，绝不放真实值） |
| test | 3 | 测试与探针专用 |
| plumbing | 45 | 内部管道（进程间传递的身份 / 标记） |

## 反模式与梳理发现

### 同义别名（一个语义多个名字）

| 名字 | 唯一解析处 | 说明 |
| --- | --- | --- |
| `AIH_HOME_DIR` / `AI_HOME` | AIH_HOME_DIR（`lib/runtime/aih-home.js` 是唯一解析处） | 两个名字是同义别名；AIH_HOME 已于 2026-10-17 移除 |

### 成对开关（ENABLE / DISABLE）

（无）

### 影响面最大的变量（读取次数前 15）

| 变量 | 分类 | 读取 | 文件数 |
| --- | --- | --- | --- |
| `AIH_CODEX_GATEWAY_ACCOUNT_REF` | plumbing | 6 | 8 |
| `AIH_PROVIDER_ACCOUNT_REF` | plumbing | 5 | 5 |
| `AIH_CODEX_BIN` | plumbing | 4 | 3 |
| `AIH_MODEL_ALIAS` | plumbing | 4 | 4 |
| `AIH_CLAUDE_USAGE_PROBE` | test | 2 | 1 |
| `AIH_CODEBUDDY_SITE` | plumbing | 2 | 1 |
| `AIH_CODEX_REMOTE_AUTH_TOKEN` | credential | 2 | 4 |
| `AIH_CODEX_USAGE_PROBE` | test | 2 | 2 |
| `AIH_GATEWAY_API_KEY` | credential | 2 | 1 |
| `AIH_GEMINI_USAGE_PROBE` | test | 2 | 1 |
| `AIH_HOME` | path | 2 | 1 |
| `AIH_CLI_PATH` | path | 1 | 1 |
| `AIH_CODEX_GATEWAY_SESSION_KEY` | credential | 1 | 2 |
| `AIH_GO_CORE_ACCOUNT_SYNC` | plumbing | 1 | 1 |
| `AIH_GO_CORE_BINARY` | plumbing | 1 | 1 |

## path（数据/目录/仓库路径）

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_HOME` | 2 | 0 | scripts/prune-usage.js |
| `AIH_CLI_PATH` | 1 | 0 | lib/cli/services/server/autostart.js |
| `AIH_RUNTIME_TOOLS_DIR` | 1 | 0 | lib/runtime/native-cli-resolver.js |
| `AIH_NO_REPO` | 0 | 1 | lib/server/workspace-checkpoints.js |

## network（端点 / 代理 / 端口）

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_SSH_CLIP_SHIM_CONTEXT` | 0 | 1 | lib/cli/services/ssh-clipboard/shim-context.js |
| `AIH_SSH_CLIPBOARD` | 0 | 1 | lib/cli/services/ssh-clipboard/clipboard-context.js |

## flag（开关与逃生门（环境准入））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_GO_CORE_ENABLED` | 1 | 2 | lib/server/go-core-host.js<br>lib/server/server-config-schema.js |
| `AIH_NO_CHECKPOINT` | 0 | 1 | lib/server/workspace-checkpoints.js |
| `AIH_NO_GIT` | 0 | 1 | lib/server/workspace-checkpoints.js |

## credential（凭据与密钥（文档只写变量名，绝不放真实值））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_CODEX_REMOTE_AUTH_TOKEN` | 2 | 3 | lib/cli/services/pty/pty-runtime-spawn.js<br>lib/server/codex-app-server-stdio-proxy-cliresume.js<br>lib/server/codex-default-cli-launcher.js<br>…共 4 个 |
| `AIH_GATEWAY_API_KEY` | 2 | 0 | lib/server/codex-gateway-connection.js |
| `AIH_CODEX_GATEWAY_SESSION_KEY` | 1 | 1 | lib/cli/services/ai-cli/codex-provider-args.js<br>lib/cli/services/ai-cli/relay/codex-relay-profile.js |
| `AIH_GO_CORE_CLIENT_KEY` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_MANAGEMENT_KEY` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_SSH_PASSWORD` | 1 | 0 | lib/server/ssh-remote-shell.js |
| `AIH_CLAUDE_CREDENTIAL_TYPE` | 0 | 2 | lib/account/claude-credential.js<br>lib/cli/services/ai-cli/provider-runtime-env.js |
| `AIH_CODEX_LOCAL_REMOTE_TOKEN` | 0 | 1 | lib/server/codex-tui-local-app-server.js |

## test（测试与探针专用）

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_CLAUDE_USAGE_PROBE` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_CODEX_USAGE_PROBE` | 2 | 1 | lib/cli/services/usage/codex-probe-context.js<br>lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_GEMINI_USAGE_PROBE` | 2 | 0 | lib/cli/services/usage/snapshot.js |

## plumbing（内部管道（进程间传递的身份 / 标记））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_CODEX_GATEWAY_ACCOUNT_REF` | 6 | 5 | lib/cli/services/account/codex-rekey-reference-policy.js<br>lib/cli/services/ai-cli/codex-provider-args.js<br>lib/cli/services/ai-cli/provider-runtime-env.js<br>…共 8 个 |
| `AIH_PROVIDER_ACCOUNT_REF` | 5 | 3 | lib/cli/services/account/codex-rekey-reference-policy.js<br>lib/cli/services/ai-cli/headless-runners/zcode-app-server-runner.js<br>lib/runtime/multiplexer/tmux-session-env.js<br>…共 5 个 |
| `AIH_CODEX_BIN` | 4 | 0 | lib/cli/services/usage/usage-snapshot-codex.js<br>lib/server/codex-client-version.js<br>lib/server/server.js |
| `AIH_MODEL_ALIAS` | 4 | 0 | lib/cli/commands/ai-cli/router.js<br>lib/cli/services/ai-cli/codex-provider-args.js<br>lib/cli/services/ai-cli/launch-profile/opencode-strategy.js<br>…共 4 个 |
| `AIH_CODEBUDDY_SITE` | 2 | 0 | lib/server/oauth-strategies/codebuddy.js |
| `AIH_GO_CORE_ACCOUNT_SYNC` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_BINARY` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_DELEGATE_REFRESH` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_ROUTES` | 1 | 2 | lib/server/go-core-host.js<br>lib/server/server-config-schema.js |
| `AIH_PEER_SELF` | 1 | 0 | lib/cli/services/peer/index.js |
| `AIH_SERVER_UPSTREAM_ERROR_RULES` | 1 | 3 | lib/cli/services/server/go-core-supervisor.js<br>lib/server/go-core-host.js<br>lib/server/server-config-schema.js |
| `AIH_SESSION_INTENT` | 1 | 3 | lib/cli/services/ai-cli/desktop-client-restart.js<br>lib/cli/services/ai-cli/provider-runtime-env.js<br>lib/runtime/multiplexer/tmux-session-env.js<br>…共 4 个 |
| `AIH_TRACE` | 1 | 0 | lib/runtime/trace.js |
| `AIH_UPSTREAM_ERROR_GROUP_IDS` | 1 | 2 | lib/account/official-account-rules-cleanup.js<br>lib/account/upstream-error-rules.js<br>lib/server/webui-account-live.js |
| `AIH_UPSTREAM_ERROR_RULES` | 1 | 3 | lib/account/go-bridge/go-import-translator.js<br>lib/account/official-account-rules-cleanup.js<br>lib/account/upstream-error-rules.js<br>…共 4 个 |
| `AIH_ACCOUNT_APP` | 0 | 1 | lib/runtime/provider-session-context.js |
| `AIH_AGY_USAGE` | 0 | 1 | lib/usage/agy-endpoints.js |
| `AIH_CLI_FEATURES` | 0 | 1 | lib/cli/config/cli-features.js |
| `AIH_CLINE_GATEWAY` | 0 | 1 | lib/cli/services/ai-cli/cline-gateway-context.js |
| `AIH_CODEX_APP_SERVER_PASSTHROUGH` | 0 | 1 | lib/server/codex-app-server-hook-wrapper.js |
| `AIH_CODEX_FLAGS` | 0 | 3 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/runtime/codex-flags.js<br>lib/runtime/multiplexer/tmux-session-env.js |
| `AIH_EDGE_CONTEXT` | 0 | 1 | lib/cli/services/toolkit/edge-proxy/edge-context.js |
| `AIH_GEMINI_DIRECT_MCP_OK` | 0 | 2 | scripts/gemini-mcp-tool-loop-demo.js |
| `AIH_GEMINI_MCP_OK` | 0 | 1 | scripts/gemini-mcp-tool-loop-demo.js |
| `AIH_GEMINI_MCP_RESULT` | 0 | 1 | scripts/gemini-mcp-tool-loop-demo.js |
| `AIH_GO_CORE_BIND` | 0 | 1 | lib/server/go-core-bind.js |
| `AIH_IMAGE_API` | 0 | 2 | lib/account/go-bridge/go-import-translator.js<br>lib/server/upstream-account-profile.js |
| `AIH_LAUNCH_CONTEXT` | 0 | 1 | lib/runtime/launch-context.js |
| `AIH_MCP_DEMO_OK` | 0 | 2 | scripts/mcp-native-demo.js |
| `AIH_NATIVE_MCP_OK` | 0 | 4 | scripts/claude-mcp-tool-loop-demo.js<br>scripts/cline-mcp-tool-loop-demo.js<br>scripts/codex-mcp-tool-loop-demo.js<br>…共 4 个 |
| `AIH_OPENCODE_GATEWAY` | 0 | 1 | lib/runtime/opencode-context.js |
| `AIH_PLUGIN_DEMO_OK` | 0 | 5 | scripts/gemini-resource-native-demo.js<br>scripts/native-plugin-use-demo.js<br>scripts/plugin-closure-demo.js<br>…共 4 个 |
| `AIH_PLUGIN_RECOVERED_OK` | 0 | 1 | scripts/plugin-closure-demo.js |
| `AIH_PROVIDER_EXTENSION_DIRS` | 0 | 1 | lib/providers/extension-dirs.js |
| `AIH_RELAY_SETTINGS` | 0 | 6 | lib/server/relay-settings.js<br>lib/server/server-config-schema.js |
| `AIH_RESOURCE_MCP_OK` | 0 | 4 | scripts/workbuddy-mcp-tool-loop-demo.js<br>scripts/workbuddy-resource-native-demo.js |
| `AIH_RESTORED` | 0 | 1 | lib/server/workspace-checkpoints.js |
| `AIH_RUNTIME_MARKER` | 0 | 2 | lib/runtime/multiplexer/tmux-session-env.js<br>lib/runtime/persistent-session.js |
| `AIH_RUNTIME_USAGE` | 0 | 2 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/runtime/usage-settings.js |
| `AIH_SERVER_RESTART` | 0 | 1 | lib/server/server-restart-context.js |
| `AIH_SKILL_DEMO_OK` | 0 | 3 | scripts/gemini-resource-native-demo.js<br>scripts/workbuddy-resource-native-demo.js |
| `AIH_UPSTREAM_HEADERS` | 0 | 2 | lib/account/go-bridge/go-import-translator.js<br>lib/server/upstream-account-profile.js |
| `AIH_WEBUI_MCP_OK` | 0 | 1 | lib/server/webui-native-resource-routes.js |
| `AIH_ZCODE_CONTEXT` | 0 | 2 | lib/runtime/zcode-context.js<br>lib/runtime/zcode-electron-captcha-hook.js |
| `AIH_ZCODE_HARNESS_STORE` | 0 | 1 | lib/runtime/zcode-outbound-profile.js |

