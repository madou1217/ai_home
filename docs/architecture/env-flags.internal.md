# 内部变量清单（不要手工设置）

> 生成命令：`npm run env:inventory -- --write`　生成时间：2026-10-17T08:05:11.449Z
> 覆盖 `lib / bin / scripts / core`，共 **126** 个非公开 `AIH_*` 变量；公开的 10 个见 [env-flags.md](./env-flags.md)。
> 这些名字由 aih 自己设置给子进程，或属实验/调试/测试钩子：**不承诺兼容**，升级可能改名或删除。不要把这里的东西写进部署脚本。

## 分类概览

| 分类 | 数量 | 含义 |
| --- | --- | --- |
| path | 18 | 数据/目录/仓库路径 |
| network | 21 | 端点 / 代理 / 端口 |
| flag | 4 | 开关与逃生门（环境准入） |
| credential | 11 | 凭据与密钥（文档只写变量名，绝不放真实值） |
| test | 1 | 测试与探针专用 |
| plumbing | 71 | 内部管道（进程间传递的身份 / 标记） |

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
| `AIH_CLI_PATH` | path | 5 | 5 |
| `AIH_AGY_QUOTA_BASE_URLS` | plumbing | 4 | 2 |
| `AIH_PROVIDER_ACCOUNT_REF` | plumbing | 4 | 4 |
| `AIH_RELAY_UDP` | plumbing | 4 | 3 |
| `AIH_RELAY_UDP_ADVERTISE_HOST` | network | 4 | 3 |
| `AIH_RELAY_UDP_ADVERTISE_PORT` | network | 4 | 3 |
| `AIH_AGY_BASE_URL` | network | 3 | 1 |
| `AIH_AGY_CODE_ASSIST_CLIENT_VERSION` | plumbing | 3 | 2 |
| `AIH_AGY_QUOTA_BASE_URL` | network | 3 | 1 |
| `AIH_CLAUDE_CLI_JS_PATH` | path | 3 | 1 |
| `AIH_CODEX_BIN` | plumbing | 3 | 2 |
| `AIH_RELAY_LISTEN_HOST` | network | 3 | 3 |
| `AIH_RELAY_PORT_MODE` | network | 3 | 3 |
| `AIH_REMOTE_SSH` | network | 3 | 2 |

## path（数据/目录/仓库路径）

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_CLI_PATH` | 5 | 1 | lib/cli/services/fabric/registry-agent-service.js<br>lib/cli/services/node/doctor.js<br>lib/cli/services/node/relay-service.js<br>…共 5 个 |
| `AIH_CLAUDE_CLI_JS_PATH` | 3 | 0 | lib/server/native-session-chat-launch.js |
| `AIH_CLAUDE_CODE_COMMANDS_DIR` | 2 | 0 | lib/server/native-slash-commands.js |
| `AIH_CODEX_HOME` | 2 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_CODEX_SQLITE_HOME` | 2 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_OPENCODE_CONFIG_DIR` | 2 | 0 | lib/server/opencode-plugin-hook-config.js |
| `AIH_ZCODE_DESKTOP_BRIDGE_DIR` | 2 | 1 | lib/runtime/zcode-desktop-bridge-binding.js<br>lib/runtime/zcode-session-attribution-runner.js |
| `AIH_CODEX_AUTO_SKIP_REPO_CHECK` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/pty-runtime-spawn.js |
| `AIH_CODEX_USAGE_PATH` | 1 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_EDGE_NGINX_CONF_DIR` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/nginx.js |
| `AIH_NODE_DIST_DIR` | 1 | 0 | lib/cli/services/node/bootstrap-assets.js |
| `AIH_PROVIDER_DEFS_DIR` | 1 | 0 | lib/providers/loader.js |
| `AIH_QUOTA_PLUGIN_DIR` | 1 | 0 | lib/providers/loader.js |
| `AIH_RUNTIME_TOOLS_DIR` | 1 | 0 | lib/runtime/native-cli-resolver.js |
| `AIH_SSH_CLIP_SHIM_BIN_DIR` | 1 | 0 | lib/cli/services/ssh-clipboard/shim-cli.js |
| `AIH_SSH_CLIP_SHIM_DIR` | 1 | 0 | lib/cli/services/ssh-clipboard/shim-cli.js |
| `AIH_ZCODE_CAPTCHA_HOOK_MODULE_PATH` | 0 | 1 | lib/runtime/zcode-electron-shadow-app.js |
| `AIH_ZCODE_CAPTCHA_HOOK_STATE_PATH` | 0 | 1 | lib/runtime/zcode-electron-captcha-hook.js |

## network（端点 / 代理 / 端口）

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_RELAY_UDP_ADVERTISE_HOST` | 4 | 1 | lib/server/command-handler.js<br>lib/server/relay-udp-front.js<br>lib/server/server-config-schema.js |
| `AIH_RELAY_UDP_ADVERTISE_PORT` | 4 | 1 | lib/server/command-handler.js<br>lib/server/relay-udp-front.js<br>lib/server/server-config-schema.js |
| `AIH_AGY_BASE_URL` | 3 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_AGY_QUOTA_BASE_URL` | 3 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_RELAY_LISTEN_HOST` | 3 | 1 | lib/cli/services/toolkit/subscription-aggregator/relay/kernel-sidecar.js<br>lib/server/command-handler.js<br>lib/server/server-config-schema.js |
| `AIH_RELAY_PORT_MODE` | 3 | 1 | lib/cli/services/toolkit/subscription-aggregator/relay/local-relay.js<br>lib/server/command-handler.js<br>lib/server/server-config-schema.js |
| `AIH_REMOTE_SSH` | 3 | 0 | lib/cli/commands/ai-cli/router.js<br>lib/cli/services/pty/pty-runtime-spawn.js |
| `AIH_CLAUDE_API_BASE_URL` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_CODEX_REMOTE_PROXY` | 2 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/server/codex-app-server-proxy.js |
| `AIH_FABRIC_ENDPOINT` | 2 | 0 | scripts/fabric-runtime-account-activation.js |
| `AIH_SSH_CLIP_AGENT` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/ssh-clipboard/clip-agent-client.js |
| `AIH_SSH_CLIP_AGENT_SOCKET` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/ssh-clipboard/clip-agent-client.js |
| `AIH_SSH_CLIP_AGENT_URL` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/ssh-clipboard/clip-agent-client.js |
| `AIH_SSH_TERMINAL_CLIPBOARD` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/pty/ssh-clipboard-shims.js |
| `AIH_CODEX_USAGE_BASE_URL` | 1 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_GO_CORE_HOST` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_OPENCODE_GATEWAY_BASE_URL` | 1 | 0 | lib/cli/services/ai-cli/launch-profile/opencode-strategy.js |
| `AIH_SERVER_CODEX_BASE_URL` | 1 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_SSH_CLIP_SHIM_TTY` | 1 | 0 | lib/cli/services/ssh-clipboard/shim-cli.js |
| `AIH_SSH_TERMINAL_CLIPBOARD_TMUX_PASSTHROUGH` | 1 | 0 | lib/cli/services/ssh-clipboard/terminal-probe.js |
| `AIH_GO_CORE_PORT` | 0 | 1 | lib/server/go-core-host.js |

## flag（开关与逃生门（环境准入））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_CODEX_ENABLE_STOP_NOTIFY_HOOK` | 2 | 0 | lib/account/host-sync.js<br>lib/server/codex-project-registry.js |
| `AIH_CODEX_DISABLE_REMOTE_RESUME` | 1 | 0 | lib/server/codex-app-server-stdio-proxy-cliresume.js |
| `AIH_GO_CORE_ENABLED` | 1 | 2 | lib/server/go-core-host.js<br>lib/server/server-config-schema.js |
| `AIH_RUNTIME_ENABLE_USAGE_SCHEDULER` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/pty-runtime-run.js |

## credential（凭据与密钥（文档只写变量名，绝不放真实值））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_CLAUDE_OAUTH_TOKEN` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_CODEX_REMOTE_AUTH_TOKEN` | 2 | 3 | lib/cli/services/pty/pty-runtime-spawn.js<br>lib/server/codex-app-server-stdio-proxy-cliresume.js<br>lib/server/codex-default-cli-launcher.js<br>…共 4 个 |
| `AIH_CODEX_TOKEN_URL` | 2 | 0 | lib/cli/services/usage/codex-auth-invalid-reconciler.js<br>lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_GEMINI_OAUTH_TOKEN` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_ACCOUNT_SMOKE_CLIENT_KEY` | 1 | 0 | scripts/gateway-account-auth-smoke.js |
| `AIH_CODEX_AUTH_PREFLIGHT` | 1 | 0 | lib/cli/services/pty/pty-runtime-run.js |
| `AIH_GO_CORE_CLIENT_KEY` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_MANAGEMENT_KEY` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_OPENCODE_GATEWAY_KEY` | 1 | 0 | lib/cli/services/ai-cli/launch-profile/opencode-strategy.js |
| `AIH_CLAUDE_CREDENTIAL_TYPE` | 0 | 2 | lib/account/claude-credential.js<br>lib/cli/services/ai-cli/provider-runtime-env.js |
| `AIH_CODEX_LOCAL_REMOTE_TOKEN` | 0 | 1 | lib/server/codex-tui-local-app-server.js |

## test（测试与探针专用）

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_FFPROBE` | 2 | 0 | lib/server/chat-video-attachments.js |

## plumbing（内部管道（进程间传递的身份 / 标记））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_CODEX_GATEWAY_ACCOUNT_REF` | 6 | 5 | lib/cli/services/account/codex-rekey-reference-policy.js<br>lib/cli/services/ai-cli/codex-provider-args.js<br>lib/cli/services/ai-cli/provider-runtime-env.js<br>…共 8 个 |
| `AIH_AGY_QUOTA_BASE_URLS` | 4 | 0 | lib/cli/services/usage/snapshot.js<br>lib/server/code-assist-quota.js |
| `AIH_PROVIDER_ACCOUNT_REF` | 4 | 3 | lib/cli/services/account/codex-rekey-reference-policy.js<br>lib/runtime/multiplexer/tmux-session-env.js<br>lib/runtime/provider-session-context.js<br>…共 4 个 |
| `AIH_RELAY_UDP` | 4 | 1 | lib/server/command-handler.js<br>lib/server/relay-udp-front.js<br>lib/server/server-config-schema.js |
| `AIH_AGY_CODE_ASSIST_CLIENT_VERSION` | 3 | 0 | lib/server/antigravity-version.js<br>lib/server/http-utils-code-assist.js |
| `AIH_CODEX_BIN` | 3 | 0 | lib/cli/services/usage/usage-snapshot-codex.js<br>lib/server/codex-client-version.js |
| `AIH_CODEX_DESKTOP_ACCOUNT_REF` | 2 | 0 | lib/cli/services/profile/list.js<br>lib/server/codex-desktop-account.js |
| `AIH_FABRIC_NODE_ID` | 2 | 0 | scripts/fabric-runtime-account-activation.js |
| `AIH_FFMPEG` | 2 | 0 | lib/server/chat-video-attachments.js |
| `AIH_GEMINI_PROJECT_ID` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_PSMUX_INSTALL_PROMPT` | 2 | 0 | lib/cli/services/ai-cli/persistent-session-list.js<br>lib/cli/services/pty/persistent-launch.js |
| `AIH_ZCODE_AGENT_ENTRY` | 2 | 1 | lib/server/desktop-launch/zcode-strategy.js |
| `AIH_ZCODE_AGENT_NODE` | 2 | 1 | lib/server/desktop-launch/zcode-strategy.js |
| `AIH_ZCODE_AGENT_RUNNER` | 2 | 1 | lib/server/desktop-launch/zcode-strategy.js |
| `AIH_ZCODE_DESKTOP_BRIDGE_IDENTITY` | 2 | 1 | lib/runtime/zcode-desktop-bridge-binding.js<br>lib/runtime/zcode-session-attribution-runner.js |
| `AIH_CODEX_TUI_LOCAL_REMOTE` | 1 | 1 | lib/runtime/multiplexer/tmux-session-env.js<br>lib/server/codex-default-cli-launcher.js |
| `AIH_CODEX_USAGE_DIRECT` | 1 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_EDGE_CADDY_BIN` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/caddy.js |
| `AIH_EDGE_CADDYFILE` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/caddy.js |
| `AIH_EDGE_FRPC_BIN` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/frp.js |
| `AIH_EDGE_FRPC_CONFIG` | 1 | 1 | lib/cli/services/toolkit/edge-proxy/providers/frp.js<br>lib/cli/services/toolkit/network-tool-discovery.js |
| `AIH_EDGE_NGINX_BIN` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/nginx.js |
| `AIH_GO_CORE_ACCOUNT_SYNC` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_BINARY` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_DELEGATE_REFRESH` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_DOWNLOAD_BASE` | 1 | 0 | scripts/postinstall-go-core.js |
| `AIH_GO_CORE_ROUTES` | 1 | 2 | lib/server/go-core-host.js<br>lib/server/server-config-schema.js |
| `AIH_OPENCODE_GATEWAY_BYOK` | 1 | 0 | lib/cli/services/ai-cli/launch-profile/opencode-strategy.js |
| `AIH_PERSIST_ACTIVE` | 1 | 2 | lib/cli/services/ai-cli/desktop-client-restart.js<br>lib/cli/services/ai-cli/provider-runtime-env.js<br>lib/runtime/persistent-session.js |
| `AIH_PERSIST_DETACHED` | 1 | 1 | lib/cli/services/pty/pty-runtime-spawn.js<br>lib/runtime/persistent-session.js |
| `AIH_RUNTIME_SHOW_USAGE` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/usage-status-runtime.js |
| `AIH_SERVER_CODEX_CLI_HOOK` | 1 | 1 | lib/cli/app.js |
| `AIH_SERVER_CODEX_DESKTOP_HOOK` | 1 | 1 | lib/cli/app.js |
| `AIH_SERVER_UPSTREAM_ERROR_RULES` | 1 | 3 | lib/cli/services/server/go-core-supervisor.js<br>lib/server/go-core-host.js<br>lib/server/server-config-schema.js |
| `AIH_SKILL_INJECT` | 1 | 0 | lib/cli/services/ai-cli/provider-skill-installer.js |
| `AIH_TERMINAL_ICON_AUTO` | 1 | 0 | lib/cli/services/terminal-icons.js |
| `AIH_TERMINAL_ICON_STRATEGY` | 1 | 0 | lib/cli/services/terminal-icon-strategies.js |
| `AIH_TERMINAL_TITLE_AUTO` | 1 | 0 | lib/cli/services/terminal-icons.js |
| `AIH_TRACE` | 1 | 0 | lib/runtime/trace.js |
| `AIH_UPSTREAM_ERROR_GROUP_IDS` | 1 | 2 | lib/account/official-account-rules-cleanup.js<br>lib/account/upstream-error-rules.js<br>lib/server/webui-account-live.js |
| `AIH_UPSTREAM_ERROR_RULES` | 1 | 3 | lib/account/go-bridge/go-import-translator.js<br>lib/account/official-account-rules-cleanup.js<br>lib/account/upstream-error-rules.js<br>…共 4 个 |
| `AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR` | 1 | 0 | lib/cli/services/pty/local-clipboard.js |
| `AIH_WT_PROVIDER_PROFILE` | 1 | 0 | lib/cli/services/terminal-icons.js |
| `AIH_ZCODE_ALWAYS_THINKING_MODELS` | 1 | 0 | lib/server/zcode-anthropic-thinking.js |
| `AIH_ZCODE_APP_VERSION` | 1 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_ACCOUNT_APP` | 0 | 1 | lib/runtime/provider-session-context.js |
| `AIH_ACCOUNT_REF` | 0 | 1 | lib/server/session-lifecycle/codex-stdio-client.js |
| `AIH_CLAUDE_TMUX_RENDER_RUNTIME` | 0 | 2 | lib/runtime/multiplexer/tmux-session-env.js<br>lib/runtime/persistent-session.js |
| `AIH_CODEX_APP_SERVER_PASSTHROUGH` | 0 | 1 | lib/server/codex-app-server-hook-wrapper.js |
| `AIH_CODEX_MANAGED_LAUNCH` | 0 | 2 | lib/runtime/codex-launch-context.js<br>lib/runtime/multiplexer/tmux-session-env.js |
| `AIH_CODEX_REMOTE_AUTOSTART` | 0 | 2 | lib/cli/services/pty/pty-runtime-launch.js |
| `AIH_IMAGE_API` | 0 | 2 | lib/account/go-bridge/go-import-translator.js<br>lib/server/upstream-account-profile.js |
| `AIH_LAUNCH_CONTEXT` | 0 | 1 | lib/runtime/launch-context.js |
| `AIH_OPENCODE_RUN_LAYOUT` | 0 | 1 | lib/runtime/opencode-run-layouts.js |
| `AIH_PERSIST_PROVIDER_SUPERVISOR_RUNTIME` | 0 | 2 | lib/runtime/multiplexer/tmux-session-env.js<br>lib/runtime/persistent-session.js |
| `AIH_PERSIST_UTF8_RUNTIME` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_PROVIDER_SESSION_CORRELATION_ID` | 0 | 2 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/runtime/multiplexer/tmux-session-env.js |
| `AIH_PSMUX_CODEX_LAUNCH_RUNTIME` | 0 | 2 | lib/runtime/multiplexer/tmux-session-env.js<br>lib/runtime/persistent-session.js |
| `AIH_RELAY_MIHOMO_BIN` | 0 | 2 | lib/cli/services/toolkit/subscription-aggregator/relay/kernels/mihomo.js<br>lib/cli/services/toolkit/subscription-aggregator/relay/mihomo-binary.js |
| `AIH_RELAY_SING_BOX_BIN` | 0 | 2 | lib/cli/services/toolkit/subscription-aggregator/relay/kernels/sing-box.js<br>lib/cli/services/toolkit/subscription-aggregator/relay/sing-box-binary.js |
| `AIH_SERVER_AUTOSTART` | 0 | 2 | lib/cli/services/pty/pty-runtime-launch.js |
| `AIH_SERVER_BACKGROUND_RESTART` | 0 | 1 | lib/server/source-auto-restart.js |
| `AIH_SERVER_ELEVATED_RESTART` | 0 | 1 | lib/cli/services/server/windows-restart-elevation.js |
| `AIH_SERVER_SOURCE_AUTO_RESTART` | 0 | 1 | lib/server/source-auto-restart.js |
| `AIH_SESSION` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_SESSION_MIRROR` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_SESSION_RESUME` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_SESSION_TARGET` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_UPSTREAM_HEADERS` | 0 | 2 | lib/account/go-bridge/go-import-translator.js<br>lib/server/upstream-account-profile.js |
| `AIH_ZCODE_SESSION_ATTRIBUTION_SCOPE` | 0 | 1 | lib/runtime/zcode-session-attribution-hook.js |
| `AIH_ZCODE_USAGE_OWNER_LOG` | 0 | 1 | lib/runtime/zcode-usage-attribution-hook.js |

