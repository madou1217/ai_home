# 内部变量清单（不要手工设置）

> 生成命令：`npm run env:inventory -- --write`　生成时间：2026-10-17T04:41:06.261Z
> 覆盖 `lib / bin / scripts / core`，共 **320** 个非公开 `AIH_*` 变量；公开的 10 个见 [env-flags.md](./env-flags.md)。
> 这些名字由 aih 自己设置给子进程，或属实验/调试/测试钩子：**不承诺兼容**，升级可能改名或删除。不要把这里的东西写进部署脚本。

## 分类概览

| 分类 | 数量 | 含义 |
| --- | --- | --- |
| path | 22 | 数据/目录/仓库路径 |
| network | 51 | 端点 / 代理 / 端口 |
| flag | 17 | 开关与逃生门（环境准入） |
| tuning | 51 | 可调参数（超时 / TTL / 上限） |
| credential | 25 | 凭据与密钥（文档只写变量名，绝不放真实值） |
| test | 2 | 测试与探针专用 |
| plumbing | 152 | 内部管道（进程间传递的身份 / 标记） |

## 反模式与梳理发现

### 同义别名（一个语义多个名字）

| 名字 | 唯一解析处 | 说明 |
| --- | --- | --- |
| `AIH_HOME_DIR` / `AIH_HOME` / `AI_HOME` | AIH_HOME_DIR（`lib/runtime/aih-home.js` 是唯一解析处） | 三个名字是同义别名，不是三种模式 |
| `AIH_SERVER_MANAGEMENT_KEY` | AIH_SERVER_MANAGEMENT_KEY | 文档/示例里出现过的 AIH_MANAGEMENT_KEY 不是输入变量（只在脚本示例里当下发值用） |

### 成对开关（ENABLE / DISABLE）

| ENABLE | DISABLE | 处理 |
| --- | --- | --- |
| `AIH_CODEX_ENABLE_REMOTE_PROXY` | `AIH_CODEX_DISABLE_REMOTE_PROXY` | 历史兼容：DISABLE=1 仍生效，新写法统一用 ENABLE=1 |

### 影响面最大的变量（读取次数前 15）

| 变量 | 分类 | 读取 | 文件数 |
| --- | --- | --- | --- |
| `AIH_HOME` | path | 26 | 20 |
| `AIH_MANAGEMENT_KEY` | credential | 11 | 10 |
| `AIH_CODEX_GATEWAY_ACCOUNT_REF` | plumbing | 6 | 8 |
| `AIH_SSH_CLIP_MAX_BYTES` | network | 6 | 5 |
| `AIH_CLI_PATH` | path | 5 | 5 |
| `AIH_AGY_QUOTA_BASE_URLS` | plumbing | 4 | 2 |
| `AIH_PLUGIN_TOKEN` | credential | 4 | 1 |
| `AIH_PROVIDER_ACCOUNT_REF` | plumbing | 4 | 4 |
| `AIH_RELAY_UDP` | plumbing | 4 | 3 |
| `AIH_RELAY_UDP_ADVERTISE_HOST` | network | 4 | 3 |
| `AIH_RELAY_UDP_ADVERTISE_PORT` | network | 4 | 3 |
| `AIH_AGY_BASE_URL` | network | 3 | 1 |
| `AIH_AGY_CODE_ASSIST_CLIENT_VERSION` | plumbing | 3 | 2 |
| `AIH_AGY_QUOTA_BASE_URL` | network | 3 | 1 |
| `AIH_AGY_USAGE_HTTP_TIMEOUT_MS` | tuning | 3 | 2 |

## path（数据/目录/仓库路径）

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_HOME` | 26 | 3 | lib/cli/services/account/codex-rekey-reference-policy.js<br>lib/cli/services/ai-cli/desktop-client-restart.js<br>lib/cli/services/fabric/closure-audit.js<br>…共 20 个 |
| `AIH_CLI_PATH` | 5 | 1 | lib/cli/services/fabric/registry-agent-service.js<br>lib/cli/services/node/doctor.js<br>lib/cli/services/node/relay-service.js<br>…共 5 个 |
| `AIH_CLAUDE_CLI_JS_PATH` | 3 | 0 | lib/server/native-session-chat-launch.js |
| `AIH_CLAUDE_CODE_COMMANDS_DIR` | 2 | 0 | lib/server/native-slash-commands.js |
| `AIH_CODEX_HOME` | 2 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_CODEX_SQLITE_HOME` | 2 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_OPENCODE_CONFIG_DIR` | 2 | 0 | lib/server/opencode-plugin-hook-config.js |
| `AIH_ZCODE_DESKTOP_BRIDGE_DIR` | 2 | 1 | lib/runtime/zcode-desktop-bridge-binding.js<br>lib/runtime/zcode-session-attribution-runner.js |
| `AIH_ANTIGRAVITY_APP_PATH` | 1 | 0 | lib/server/antigravity-version.js |
| `AIH_CODEX_AUTO_SKIP_REPO_CHECK` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/pty-runtime-spawn.js |
| `AIH_CODEX_USAGE_PATH` | 1 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_EDGE_NGINX_CONF_DIR` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/nginx.js |
| `AIH_NODE_DIST_DIR` | 1 | 0 | lib/cli/services/node/bootstrap-assets.js |
| `AIH_PROVIDER_DEFS_DIR` | 1 | 0 | lib/providers/loader.js |
| `AIH_QUOTA_PLUGIN_DIR` | 1 | 0 | lib/providers/loader.js |
| `AIH_RUNTIME_TOOLS_DIR` | 1 | 0 | lib/runtime/native-cli-resolver.js |
| `AIH_SSH_CLIP_SHIM_BIN_DIR` | 1 | 0 | lib/cli/services/ssh-clipboard/shim-cli.js |
| `AIH_SSH_CLIP_SHIM_DIR` | 1 | 0 | lib/cli/services/ssh-clipboard/shim-cli.js |
| `AIH_CODEX_HOST_HOME` | 0 | 1 | lib/cli/services/account/codex-rekey-reference-policy.js |
| `AIH_PROFILE_DIR` | 0 | 2 | lib/cli/services/ai-cli/desktop-client-restart.js<br>lib/server/session-lifecycle/codex-stdio-client.js |
| `AIH_ZCODE_CAPTCHA_HOOK_MODULE_PATH` | 0 | 1 | lib/runtime/zcode-electron-shadow-app.js |
| `AIH_ZCODE_CAPTCHA_HOOK_STATE_PATH` | 0 | 1 | lib/runtime/zcode-electron-captcha-hook.js |

## network（端点 / 代理 / 端口）

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_SSH_CLIP_MAX_BYTES` | 6 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/pty/ssh-clipboard-shims.js<br>lib/cli/services/ssh-clipboard/clip-agent.js<br>…共 5 个 |
| `AIH_RELAY_UDP_ADVERTISE_HOST` | 4 | 1 | lib/server/command-handler.js<br>lib/server/relay-udp-front.js<br>lib/server/server-config-schema.js |
| `AIH_RELAY_UDP_ADVERTISE_PORT` | 4 | 1 | lib/server/command-handler.js<br>lib/server/relay-udp-front.js<br>lib/server/server-config-schema.js |
| `AIH_AGY_BASE_URL` | 3 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_AGY_QUOTA_BASE_URL` | 3 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_RELAY_LISTEN_HOST` | 3 | 1 | lib/cli/services/toolkit/subscription-aggregator/relay/kernel-sidecar.js<br>lib/server/command-handler.js<br>lib/server/server-config-schema.js |
| `AIH_RELAY_PORT_MODE` | 3 | 1 | lib/cli/services/toolkit/subscription-aggregator/relay/local-relay.js<br>lib/server/command-handler.js<br>lib/server/server-config-schema.js |
| `AIH_REMOTE_SSH` | 3 | 0 | lib/cli/commands/ai-cli/router.js<br>lib/cli/services/pty/pty-runtime-spawn.js |
| `AIH_SERVER_CODEX_BASE_URL` | 3 | 0 | lib/cli/services/usage/usage-snapshot-codex.js<br>lib/server/args.js |
| `AIH_APPROVAL_URL` | 2 | 0 | lib/server/claude-permission-mcp-tool.js |
| `AIH_CLAUDE_API_BASE_URL` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_FABRIC_ENDPOINT` | 2 | 0 | scripts/fabric-runtime-account-activation.js |
| `AIH_PLUGIN_HOST_VERSION` | 2 | 0 | lib/plugins/host/host-entry.mjs |
| `AIH_SERVER_AGY_BASE_URL` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CLAUDE_BASE_URL` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CODEX_DESKTOP_REMOTE_PROXY` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_GEMINI_BASE_URL` | 2 | 0 | lib/server/args.js |
| `AIH_SSH_CLIP_AGENT` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/ssh-clipboard/clip-agent-client.js |
| `AIH_SSH_CLIP_AGENT_SOCKET` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/ssh-clipboard/clip-agent-client.js |
| `AIH_SSH_CLIP_AGENT_URL` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/ssh-clipboard/clip-agent-client.js |
| `AIH_SSH_CLIP_SHIM_TIMEOUT_MS` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-shims.js<br>lib/cli/services/ssh-clipboard/shim-cli.js |
| `AIH_SSH_IMAGE_PASTE` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/pty/ssh-clipboard-shims.js |
| `AIH_SSH_TERMINAL_CLIPBOARD` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/pty/ssh-clipboard-shims.js |
| `AIH_SSH_TERMINAL_CLIPBOARD_TMUX_PASSTHROUGH` | 2 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js<br>lib/cli/services/ssh-clipboard/terminal-probe.js |
| `AIH_CLIP_AGENT_HOST` | 1 | 0 | lib/cli/services/ssh-clipboard/clip-agent.js |
| `AIH_CLIP_AGENT_PORT` | 1 | 0 | lib/cli/services/ssh-clipboard/clip-agent.js |
| `AIH_CODEX_DISABLE_REMOTE_PROXY` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js |
| `AIH_CODEX_ENABLE_REMOTE_PROXY` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js |
| `AIH_CODEX_REMOTE_PROXY` | 1 | 0 | lib/server/codex-app-server-proxy.js |
| `AIH_CODEX_USAGE_BASE_URL` | 1 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_DEPLOY_SSH` | 1 | 0 | scripts/deploy-server.js |
| `AIH_EDGE_AIH_PORT` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/edge-proxy-service.js |
| `AIH_FABRIC_LOCAL_URL` | 1 | 0 | lib/cli/services/fabric/broker-connect.js |
| `AIH_GO_CORE_HOST` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_OPENCODE_GATEWAY_BASE_URL` | 1 | 0 | lib/cli/services/ai-cli/launch-profile/opencode-strategy.js |
| `AIH_SERVER_MANAGEMENT_URL` | 1 | 0 | lib/cli/bootstrap/runtime-support-wiring.js |
| `AIH_SERVER_STRICT_PORT` | 1 | 0 | lib/server/server.js |
| `AIH_SSH_CLIP_AGENT_TIMEOUT_MS` | 1 | 0 | lib/cli/services/ssh-clipboard/clip-agent-client.js |
| `AIH_SSH_CLIP_CHUNK_SIZE` | 1 | 0 | lib/cli/services/ssh-clipboard/ssh-command.js |
| `AIH_SSH_CLIP_PROBE_TIMEOUT_MS` | 1 | 0 | lib/cli/services/ssh-clipboard/terminal-probe.js |
| `AIH_SSH_CLIP_SHIM_TTY` | 1 | 0 | lib/cli/services/ssh-clipboard/shim-cli.js |
| `AIH_SSH_CLIP_WATCH` | 1 | 0 | lib/cli/services/ssh-clipboard/ssh-command.js |
| `AIH_SSH_CLIPBOARD_SHIMS` | 1 | 0 | lib/cli/services/pty/ssh-clipboard-shims.js |
| `AIH_SSH_TERMINAL_CLIPBOARD_TIMEOUT_MS` | 1 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js |
| `AIH_SSH_TERMINAL_PASTE_EVENTS` | 1 | 0 | lib/cli/services/pty/ssh-clipboard-bridge.js |
| `AIH_GO_CORE_PORT` | 0 | 1 | lib/server/go-core-host.js |
| `AIH_TURN_ICE_SERVER` | 0 | 5 | lib/cli/services/fabric/closure-resume-check.js<br>lib/cli/services/fabric/transport-config.js<br>lib/cli/services/fabric/transport-turn-relay.js<br>…共 4 个 |
| `AIH_TURN_ICE_SERVERS` | 0 | 5 | lib/cli/services/fabric/closure-resume-check.js<br>lib/cli/services/fabric/transport-config.js<br>lib/cli/services/fabric/transport-turn-relay.js<br>…共 4 个 |
| `AIH_TURN_USERNAME` | 0 | 4 | lib/cli/services/fabric/closure-resume-check.js<br>lib/cli/services/fabric/transport-config.js<br>lib/cli/services/fabric/transport-turn-relay.js<br>…共 4 个 |
| `AIH_WEBTRANSPORT_PAGE_URL` | 0 | 4 | lib/cli/services/fabric/closure-resume-check.js<br>lib/cli/services/fabric/transport-config.js<br>lib/cli/services/fabric/transport-webtransport.js<br>…共 4 个 |
| `AIH_WEBTRANSPORT_URL` | 0 | 5 | lib/cli/services/fabric/closure-resume-check.js<br>lib/cli/services/fabric/transport-config.js<br>lib/cli/services/fabric/transport-webtransport.js<br>…共 4 个 |

## flag（开关与逃生门（环境准入））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_AGY_WARM_DEBUG` | 2 | 0 | lib/server/agy-warm-ls-pool.js |
| `AIH_CODEX_ENABLE_STOP_NOTIFY_HOOK` | 2 | 0 | lib/account/host-sync.js<br>lib/server/codex-project-registry.js |
| `AIH_DEBUG_CODE_ASSIST_MODELS` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_DEBUG_CODE_ASSIST_MODELS_DUMP` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_DEBUG_MODEL_CHAIN` | 2 | 0 | lib/server/model-discovery/index.js |
| `AIH_PLUGIN_DEBUG` | 2 | 0 | lib/plugins/transport/rpc-server.js |
| `AIH_ACCOUNT_ARTIFACT_HOOK_DEBUG` | 1 | 1 | lib/cli/app.js |
| `AIH_CLAUDE_DIAGNOSTIC_NO_EVIDENCE_COOLDOWN_MS` | 1 | 0 | lib/cli/services/pty/claude-diagnostic-scheduler.js |
| `AIH_CODEX_DISABLE_REMOTE_RESUME` | 1 | 0 | lib/server/codex-app-server-stdio-proxy-cliresume.js |
| `AIH_DEBUG_PERSIST` | 1 | 0 | lib/cli/services/pty/persistent-launch.js |
| `AIH_GO_CORE_ENABLED` | 1 | 2 | lib/server/go-core-host.js<br>lib/server/server-config-schema.js |
| `AIH_RUNTIME_ENABLE_USAGE_SCHEDULER` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/pty-runtime-run.js |
| `AIH_RUNTIME_FORCE_USAGE_STATUS_BAR` | 1 | 0 | lib/cli/services/pty/usage-status-runtime.js |
| `AIH_SERVER_ALLOW_MULTI` | 1 | 0 | lib/server/server.js |
| `AIH_SKIP_GO_CORE_INSTALL` | 1 | 0 | scripts/postinstall-go-core.js |
| `AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART` | 0 | 1 | lib/server/source-auto-restart.js |
| `AIH_ZCODE_CAPTCHA_FORCE_INTERACTIVE` | 0 | 1 | lib/runtime/zcode-electron-captcha-hook.js |

## tuning（可调参数（超时 / TTL / 上限））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_AGY_USAGE_HTTP_TIMEOUT_MS` | 3 | 0 | lib/cli/services/usage/snapshot.js<br>lib/server/agy-usage-snapshot.js |
| `AIH_AGY_WARM_MAX` | 2 | 0 | lib/server/agy-warm-ls-pool.js |
| `AIH_AGY_WARM_RESP_TIMEOUT_MS` | 2 | 0 | lib/server/agy-warm-ls-pool.js |
| `AIH_AGY_WARM_TTL_MS` | 2 | 0 | lib/server/agy-warm-ls-pool.js |
| `AIH_APPROVAL_TIMEOUT_MS` | 2 | 0 | lib/server/claude-permission-mcp-tool.js |
| `AIH_CLAUDE_USAGE_TIMEOUT_MS` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_SERVER_AGY_MAX_CONCURRENCY` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CLAUDE_MAX_CONCURRENCY` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CODEX_CLI_HOOK_SELF_HEAL_INTERVAL_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CODEX_MAX_CONCURRENCY` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_COOLDOWN_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_GEMINI_MAX_CONCURRENCY` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_MAX_ATTEMPTS` | 2 | 1 | lib/server/args.js<br>lib/server/server-config-schema.js |
| `AIH_SERVER_MODEL_USAGE_SCAN_INTERVAL_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_MODEL_USAGE_SCAN_START_DELAY_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_MODELS_CACHE_TTL_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_OPENCODE_MAX_CONCURRENCY` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_INTERVAL_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_START_DELAY_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_QUEUE_LIMIT` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_SESSION_AFFINITY_MAX` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_SESSION_AFFINITY_TTL_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_UPSTREAM_TIMEOUT_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_WINDOW_ACTIVATION_BATCH_SIZE` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_WINDOW_ACTIVATION_DEFAULT_INTERVAL_MS` | 2 | 1 | lib/server/args.js<br>lib/server/server-config-schema.js |
| `AIH_SERVER_WINDOW_ACTIVATION_MIN_INTERVAL_MS` | 2 | 1 | lib/server/args.js<br>lib/server/server-config-schema.js |
| `AIH_SERVER_WINDOW_ACTIVATION_PROBE_TIMEOUT_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_WINDOW_ACTIVATION_START_DELAY_MS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_WINDOW_ACTIVATION_TICK_INTERVAL_MS` | 2 | 0 | lib/server/args.js |
| `AIH_AGY_USAGE_REFRESH_TTL_MS` | 1 | 0 | lib/server/agy-usage-snapshot.js |
| `AIH_CLAUDE_HOOK_DIAGNOSTIC_DELAY_MS` | 1 | 0 | lib/cli/services/pty/claude-diagnostic-scheduler.js |
| `AIH_CLIP_AGENT_MAX_BYTES` | 1 | 0 | lib/cli/services/ssh-clipboard/clip-agent.js |
| `AIH_CODEX_USAGE_HTTP_TIMEOUT_MS` | 1 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_CODEX_USAGE_SLOW_RETRY_TIMEOUT_MS` | 1 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_CODEX_USAGE_TIMEOUT_MS` | 1 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_NATIVE_RUN_RETENTION_MS` | 1 | 0 | lib/server/control-plane-device-session-start.js |
| `AIH_RUNTIME_THRESHOLD_CHECK_MS` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/usage-status-runtime.js |
| `AIH_RUNTIME_USAGE_DISPLAY_INTERVAL_MS` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/usage-status-runtime.js |
| `AIH_RUNTIME_USAGE_REFRESH_MIN_MS` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/usage-status-runtime.js |
| `AIH_RUNTIME_USAGE_STALE_MS` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/usage-status-runtime.js |
| `AIH_SESSION_RUN_RETENTION_MS` | 1 | 0 | lib/server/control-plane-device-session-start.js |
| `AIH_CODEX_RATE_LIMIT_JSON_END` | 0 | 1 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_CODEX_RATE_LIMIT_JSON_START` | 0 | 1 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_NATIVE_FIRST_PROGRESS_TIMEOUT_MS` | 0 | 1 | lib/server/native-run-watchdog.js |
| `AIH_NATIVE_STALL_TIMEOUT_MS` | 0 | 1 | lib/server/native-run-watchdog.js |
| `AIH_NATIVE_TIMEOUT_KILL_GRACE_MS` | 0 | 1 | lib/server/native-run-watchdog.js |
| `AIH_NATIVE_UPSTREAM_ERROR_TIMEOUT_MS` | 0 | 1 | lib/server/native-run-watchdog.js |
| `AIH_SERVER_SOURCE_AUTO_RESTART_INTERVAL_MS` | 0 | 1 | lib/server/source-auto-restart.js |
| `AIH_USAGE_BULK_PROBE_TIMEOUT_MS` | 0 | 1 | lib/cli/services/usage/presenter.js |
| `AIH_USAGE_SCAN_DEADLINE_MS` | 0 | 1 | lib/cli/services/usage/presenter.js |

## credential（凭据与密钥（文档只写变量名，绝不放真实值））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_MANAGEMENT_KEY` | 11 | 0 | lib/cli/services/background/supervisor-runtime.js<br>lib/cli/services/fabric/broker-connect.js<br>lib/cli/services/fabric/transport-echo.js<br>…共 10 个 |
| `AIH_PLUGIN_TOKEN` | 4 | 0 | lib/plugins/host/host-entry.mjs |
| `AIH_BENCH_KEY` | 2 | 0 | scripts/go-core-benchmark.js |
| `AIH_CLAUDE_OAUTH_TOKEN` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_CODEX_REMOTE_AUTH_TOKEN` | 2 | 3 | lib/cli/services/pty/pty-runtime-spawn.js<br>lib/server/codex-app-server-stdio-proxy-cliresume.js<br>lib/server/codex-default-cli-launcher.js<br>…共 4 个 |
| `AIH_CODEX_TOKEN_REFRESH_TIMEOUT_MS` | 2 | 0 | lib/cli/services/usage/codex-auth-invalid-reconciler.js<br>lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_CODEX_TOKEN_URL` | 2 | 0 | lib/cli/services/usage/codex-auth-invalid-reconciler.js<br>lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_GEMINI_OAUTH_TOKEN` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_PLUGIN_TOKEN_FROM_STDIN` | 2 | 0 | lib/plugins/host/host-entry.mjs |
| `AIH_SERVER_CLIENT_KEY` | 2 | 2 | lib/server/args.js<br>lib/server/server-config-schema.js |
| `AIH_SHADOW_GO_KEY` | 2 | 0 | scripts/gateway-shadow-compare.js |
| `AIH_SHADOW_NODE_KEY` | 2 | 0 | scripts/gateway-shadow-compare.js |
| `AIH_ACCOUNT_SMOKE_CLIENT_KEY` | 1 | 0 | scripts/gateway-account-auth-smoke.js |
| `AIH_AGY_TOKEN_REFRESH_TIMEOUT_MS` | 1 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_CLAUDE_TOKEN_REFRESH_TIMEOUT_MS` | 1 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_CODEX_AUTH_PREFLIGHT` | 1 | 0 | lib/cli/services/pty/pty-runtime-run.js |
| `AIH_CODEX_USAGE_BULK_TOKEN_REFRESH` | 1 | 0 | lib/cli/services/usage/presenter.js |
| `AIH_DEPLOY_SSH_KEY` | 1 | 0 | scripts/deploy-server.js |
| `AIH_GO_CORE_CLIENT_KEY` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_MANAGEMENT_KEY` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_OPENCODE_GATEWAY_KEY` | 1 | 0 | lib/cli/services/ai-cli/launch-profile/opencode-strategy.js |
| `AIH_RELAY_PASSWORD` | 1 | 0 | lib/cli/services/toolkit/subscription-aggregator/relay/relay-credentials.js |
| `AIH_CLAUDE_CREDENTIAL_TYPE` | 0 | 2 | lib/account/claude-credential.js<br>lib/cli/services/ai-cli/provider-runtime-env.js |
| `AIH_CODEX_LOCAL_REMOTE_TOKEN` | 0 | 1 | lib/server/codex-tui-local-app-server.js |
| `AIH_TURN_CREDENTIAL` | 0 | 4 | lib/cli/services/fabric/closure-resume-check.js<br>lib/cli/services/fabric/transport-config.js<br>lib/cli/services/fabric/transport-turn-relay.js<br>…共 4 个 |

## test（测试与探针专用）

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_FFPROBE` | 2 | 0 | lib/server/chat-video-attachments.js |
| `AIH_SERVER_MODELS_PROBE_ACCOUNTS` | 2 | 1 | lib/server/args.js<br>lib/server/server-config-schema.js |

## plumbing（内部管道（进程间传递的身份 / 标记））

| 变量 | 读取 | 字面量 | 文件 |
| --- | --- | --- | --- |
| `AIH_CODEX_GATEWAY_ACCOUNT_REF` | 6 | 5 | lib/cli/services/account/codex-rekey-reference-policy.js<br>lib/cli/services/ai-cli/codex-provider-args.js<br>lib/cli/services/ai-cli/provider-runtime-env.js<br>…共 8 个 |
| `AIH_AGY_QUOTA_BASE_URLS` | 4 | 0 | lib/cli/services/usage/snapshot.js<br>lib/server/code-assist-quota.js |
| `AIH_PROVIDER_ACCOUNT_REF` | 4 | 3 | lib/cli/services/account/codex-rekey-reference-policy.js<br>lib/runtime/multiplexer/tmux-session-env.js<br>lib/runtime/provider-session-context.js<br>…共 4 个 |
| `AIH_RELAY_UDP` | 4 | 1 | lib/server/command-handler.js<br>lib/server/relay-udp-front.js<br>lib/server/server-config-schema.js |
| `AIH_AGY_CODE_ASSIST_CLIENT_VERSION` | 3 | 0 | lib/server/antigravity-version.js<br>lib/server/http-utils-code-assist.js |
| `AIH_ANTIGRAVITY_VERSION` | 3 | 0 | lib/server/antigravity-version.js<br>lib/server/http-utils-code-assist.js |
| `AIH_CODEX_BIN` | 3 | 0 | lib/cli/services/usage/usage-snapshot-codex.js<br>lib/server/codex-client-version.js |
| `AIH_SERVER_CODEX_CLIENT_VERSION` | 3 | 0 | lib/server/args.js<br>lib/server/codex-client-version.js |
| `AIH_AGY_CODE_ASSIST_CHROME_VERSION` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_AGY_CODE_ASSIST_ELECTRON_VERSION` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_AGY_CODE_ASSIST_MACHINE_ID` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_AGY_CODE_ASSIST_USER_AGENT` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_CODEX_DESKTOP_ACCOUNT_REF` | 2 | 0 | lib/cli/services/profile/list.js<br>lib/server/codex-desktop-account.js |
| `AIH_CODEX_STOP_NOTIFY_HOOK` | 2 | 0 | lib/account/host-sync.js<br>lib/server/codex-project-registry.js |
| `AIH_FABRIC_NODE_ID` | 2 | 0 | scripts/fabric-runtime-account-activation.js |
| `AIH_FFMPEG` | 2 | 0 | lib/server/chat-video-attachments.js |
| `AIH_GEMINI_CLI_CLIENT_NAME` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_GEMINI_CLI_SURFACE` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_GEMINI_CLI_VERSION` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_GEMINI_CODE_ASSIST_USER_AGENT` | 2 | 0 | lib/server/http-utils-code-assist.js |
| `AIH_GEMINI_PROJECT_ID` | 2 | 0 | lib/cli/services/usage/snapshot.js |
| `AIH_ITERM_PROVIDER_PROFILE` | 2 | 0 | lib/cli/services/terminal-icons.js |
| `AIH_KIMI_CODE_VERSION` | 2 | 0 | lib/server/kimi-request-headers.js |
| `AIH_PLUGIN_EXIT_WITH_PARENT` | 2 | 0 | lib/plugins/host/host-entry.mjs |
| `AIH_PLUGIN_SOCKET` | 2 | 0 | lib/plugins/host/host-entry.mjs |
| `AIH_PSMUX_INSTALL_PROMPT` | 2 | 0 | lib/cli/services/ai-cli/persistent-session-list.js<br>lib/cli/services/pty/persistent-launch.js |
| `AIH_RUN_ID` | 2 | 0 | lib/server/claude-permission-mcp-tool.js |
| `AIH_SERVER_BACKEND` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CODEX_DESKTOP_RESTART_APP_SERVER_ON_HOOK_CHANGE` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CODEX_DESKTOP_TRACE_FILE` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CODEX_DESKTOP_TRACE_REMOTE` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CODEX_DESKTOP_TRACE_RESPONSES` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_CODEX_MODELS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_FAILURE_THRESHOLD` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_LOG_REQUESTS` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_MODEL_USAGE_SCAN` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_PROVIDER` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_APPLY` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_STRATEGY` | 2 | 0 | lib/server/args.js |
| `AIH_SERVER_WINDOW_ACTIVATION` | 2 | 1 | lib/server/args.js<br>lib/server/server-config-schema.js |
| `AIH_TERMINAL_PROVIDER_TITLE` | 2 | 0 | lib/cli/services/terminal-icons.js |
| `AIH_UTF8_LOCALE` | 2 | 0 | lib/cli/services/ai-cli/provider-runtime-env.js |
| `AIH_WEBUI_TMUX_RUNS` | 2 | 0 | lib/server/native-session-chat-command.js |
| `AIH_WINDOWS_IMAGE_PASTE` | 2 | 0 | lib/cli/services/pty/local-clipboard.js |
| `AIH_ZCODE_AGENT_ENTRY` | 2 | 1 | lib/server/desktop-launch/zcode-strategy.js |
| `AIH_ZCODE_AGENT_NODE` | 2 | 1 | lib/server/desktop-launch/zcode-strategy.js |
| `AIH_ZCODE_AGENT_RUNNER` | 2 | 1 | lib/server/desktop-launch/zcode-strategy.js |
| `AIH_ZCODE_APP_VERSION` | 2 | 0 | lib/account/zcode-client-metadata.js<br>lib/cli/services/usage/snapshot.js |
| `AIH_ZCODE_DESKTOP_BRIDGE_IDENTITY` | 2 | 1 | lib/runtime/zcode-desktop-bridge-binding.js<br>lib/runtime/zcode-session-attribution-runner.js |
| `AIH_AUTO_INSTALL_AGE` | 1 | 0 | lib/cli/services/backup/crypto.js |
| `AIH_CJK_LOCALE` | 1 | 0 | lib/cli/services/ai-cli/provider-runtime-env.js |
| `AIH_CLAUDE_DIAGNOSTIC_STDOUT` | 1 | 0 | lib/cli/services/pty/claude-diagnostic-scheduler.js |
| `AIH_CLAUDE_DIAGNOSTIC_VERBOSE` | 1 | 0 | lib/cli/services/pty/claude-diagnostic-scheduler.js |
| `AIH_CODEX_CLIENT_VERSION` | 1 | 0 | lib/server/codex-client-version.js |
| `AIH_CODEX_TUI_LOCAL_REMOTE` | 1 | 1 | lib/runtime/multiplexer/tmux-session-env.js<br>lib/server/codex-default-cli-launcher.js |
| `AIH_CODEX_USAGE_BULK_APP_SERVER_FALLBACK` | 1 | 0 | lib/cli/services/usage/presenter.js |
| `AIH_CODEX_USAGE_DIRECT` | 1 | 0 | lib/cli/services/usage/usage-snapshot-codex.js |
| `AIH_DEPLOY_GO_TARGET` | 1 | 0 | scripts/deploy-server.js |
| `AIH_EDGE_CADDY_BIN` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/caddy.js |
| `AIH_EDGE_CADDYFILE` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/caddy.js |
| `AIH_EDGE_FRPC_BIN` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/frp.js |
| `AIH_EDGE_FRPC_CONFIG` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/frp.js |
| `AIH_EDGE_NGINX_BIN` | 1 | 0 | lib/cli/services/toolkit/edge-proxy/providers/nginx.js |
| `AIH_GO_CORE_ACCOUNT_SYNC` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_BINARY` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_DELEGATE_REFRESH` | 1 | 1 | lib/server/go-core-host.js |
| `AIH_GO_CORE_DOWNLOAD_BASE` | 1 | 0 | scripts/postinstall-go-core.js |
| `AIH_GO_CORE_ROUTES` | 1 | 2 | lib/server/go-core-host.js<br>lib/server/server-config-schema.js |
| `AIH_KONSOLE_PROVIDER_PROFILE` | 1 | 0 | lib/cli/services/terminal-icons.js |
| `AIH_NATIVE_BINARY_REPAIR` | 1 | 0 | lib/cli/services/pty/pty-runtime-run.js |
| `AIH_NATIVE_CLI_PROJECT_FALLBACK` | 1 | 0 | lib/runtime/native-cli-resolver.js |
| `AIH_NATIVE_RUN_WATCHDOG` | 1 | 0 | lib/server/native-run-watchdog.js |
| `AIH_OPENCODE_GATEWAY_BYOK` | 1 | 0 | lib/cli/services/ai-cli/launch-profile/opencode-strategy.js |
| `AIH_PERSIST_ACTIVE` | 1 | 2 | lib/cli/services/ai-cli/desktop-client-restart.js<br>lib/cli/services/ai-cli/provider-runtime-env.js<br>lib/runtime/persistent-session.js |
| `AIH_PERSIST_DETACHED` | 1 | 1 | lib/cli/services/pty/pty-runtime-spawn.js<br>lib/runtime/persistent-session.js |
| `AIH_RELAY_USERNAME` | 1 | 0 | lib/cli/services/toolkit/subscription-aggregator/relay/relay-credentials.js |
| `AIH_RUNTIME_AUTO_SWITCH` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/usage-status-runtime.js |
| `AIH_RUNTIME_SHOW_USAGE` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/usage-status-runtime.js |
| `AIH_RUNTIME_USAGE_STATUS_BAR` | 1 | 1 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/cli/services/pty/usage-status-runtime.js |
| `AIH_SERVER_CODEX_CLI_HOOK` | 1 | 1 | lib/cli/app.js |
| `AIH_SERVER_CODEX_DESKTOP_HOOK` | 1 | 1 | lib/cli/app.js |
| `AIH_SERVER_UPSTREAM_ERROR_RULES` | 1 | 3 | lib/cli/services/server/go-core-supervisor.js<br>lib/server/go-core-host.js<br>lib/server/server-config-schema.js |
| `AIH_SESSION_ARTIFACT_THRESHOLD` | 1 | 0 | lib/server/control-plane-device-session-start.js |
| `AIH_SESSION_PICKER_ANIMATION` | 1 | 0 | lib/cli/services/ai-cli/persistent-session-list.js |
| `AIH_SESSION_PICKER_ICONS` | 1 | 0 | lib/cli/services/ai-cli/persistent-session-list.js |
| `AIH_SESSION_PICKER_SYMBOLS` | 1 | 0 | lib/cli/services/ai-cli/persistent-session-list.js |
| `AIH_SESSION_SCAN_ALL` | 1 | 0 | lib/cli/services/ai-cli/persistent-session-list.js |
| `AIH_SHELL_DRAWER_HEIGHT` | 1 | 0 | lib/cli/services/pty/shell-drawer.js |
| `AIH_SKILL_INJECT` | 1 | 0 | lib/cli/services/ai-cli/provider-skill-installer.js |
| `AIH_TERMINAL_ICON_AUTO` | 1 | 0 | lib/cli/services/terminal-icons.js |
| `AIH_TERMINAL_ICON_STRATEGY` | 1 | 0 | lib/cli/services/terminal-icon-strategies.js |
| `AIH_UPSTREAM_ERROR_GROUP_IDS` | 1 | 2 | lib/account/official-account-rules-cleanup.js<br>lib/account/upstream-error-rules.js<br>lib/server/webui-account-live.js |
| `AIH_UPSTREAM_ERROR_RULES` | 1 | 3 | lib/account/go-bridge/go-import-translator.js<br>lib/account/official-account-rules-cleanup.js<br>lib/account/upstream-error-rules.js<br>…共 4 个 |
| `AIH_USAGE_SCAN_QUIET` | 1 | 0 | lib/cli/services/usage/presenter.js |
| `AIH_USAGE_SCAN_VERBOSE` | 1 | 0 | lib/cli/services/usage/presenter.js |
| `AIH_WARP_PROVIDER_ICON` | 1 | 0 | lib/cli/services/terminal-icons.js |
| `AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR` | 1 | 0 | lib/cli/services/pty/local-clipboard.js |
| `AIH_WT_PROVIDER_PROFILE` | 1 | 0 | lib/cli/services/terminal-icons.js |
| `AIH_ZCODE_ALWAYS_THINKING_MODELS` | 1 | 0 | lib/server/zcode-anthropic-thinking.js |
| `AIH_ZCODE_CLIENT_LANGUAGE` | 1 | 0 | lib/account/zcode-client-metadata.js |
| `AIH_ZCODE_CLIENT_TIMEZONE` | 1 | 0 | lib/account/zcode-client-metadata.js |
| `AIH_ACCOUNT_APP` | 0 | 1 | lib/runtime/provider-session-context.js |
| `AIH_ACCOUNT_ID` | 0 | 1 | lib/server/session-lifecycle/codex-stdio-client.js |
| `AIH_ACCOUNT_REF` | 0 | 1 | lib/server/session-lifecycle/codex-stdio-client.js |
| `AIH_CLAUDE_TMUX_RENDER_RUNTIME` | 0 | 2 | lib/runtime/multiplexer/tmux-session-env.js<br>lib/runtime/persistent-session.js |
| `AIH_CLAUDE_USAGE_JSON_END` | 0 | 1 | lib/cli/services/usage/snapshot.js |
| `AIH_CLAUDE_USAGE_JSON_START` | 0 | 1 | lib/cli/services/usage/snapshot.js |
| `AIH_CLI_ACCOUNT_ID` | 0 | 1 | lib/server/session-lifecycle/codex-stdio-client.js |
| `AIH_CODEX_APP_SERVER_PASSTHROUGH` | 0 | 1 | lib/server/codex-app-server-hook-wrapper.js |
| `AIH_CODEX_MANAGED_LAUNCH` | 0 | 2 | lib/runtime/codex-launch-context.js<br>lib/runtime/multiplexer/tmux-session-env.js |
| `AIH_CODEX_REMOTE_AUTOSTART` | 0 | 2 | lib/cli/services/pty/pty-runtime-launch.js |
| `AIH_CODEX_USAGE_BULK_JOBS` | 0 | 1 | lib/cli/services/usage/presenter.js |
| `AIH_FABRIC_REAL_MARKER` | 0 | 1 | lib/cli/services/fabric/closure-plan.js |
| `AIH_FRPC_CONFIG` | 0 | 1 | lib/cli/services/toolkit/network-tool-discovery.js |
| `AIH_HEADLESS_DIRECT_SPAWN` | 0 | 1 | lib/cli/services/pty/headless-invocation.js |
| `AIH_HEADLESS_SPINNER` | 0 | 1 | lib/cli/services/pty/headless-progress.js |
| `AIH_IMAGE_API` | 0 | 2 | lib/account/go-bridge/go-import-translator.js<br>lib/server/upstream-account-profile.js |
| `AIH_ITERM_PROVIDER_ICON_AUTO` | 0 | 1 | lib/cli/services/terminal-icons.js |
| `AIH_KONSOLE_PROVIDER_ICON_AUTO` | 0 | 1 | lib/cli/services/terminal-icons.js |
| `AIH_M5_RECOVERY_MESSAGE_OK` | 0 | 1 | scripts/fabric-real-session-recovery-smoke.js |
| `AIH_M5_RECOVERY_START_OK` | 0 | 1 | scripts/fabric-real-session-recovery-smoke.js |
| `AIH_MOBILE_PWA_MESSAGE_OK` | 0 | 1 | scripts/fabric-real-mobile-pwa-session-smoke.js |
| `AIH_MOBILE_PWA_START_OK` | 0 | 1 | scripts/fabric-real-mobile-pwa-session-smoke.js |
| `AIH_OPENCODE_RUN_LAYOUT` | 0 | 1 | lib/runtime/opencode-run-layouts.js |
| `AIH_OPENCODE_ZEN_UA` | 0 | 1 | lib/server/opencode-zen-free-client.js |
| `AIH_PERSIST_PROVIDER_SUPERVISOR_RUNTIME` | 0 | 2 | lib/runtime/multiplexer/tmux-session-env.js<br>lib/runtime/persistent-session.js |
| `AIH_PERSIST_UTF8_RUNTIME` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_PROFILE_ID` | 0 | 1 | lib/cli/services/ai-cli/desktop-client-restart.js |
| `AIH_PROVIDER_SESSION_CORRELATION_ID` | 0 | 2 | lib/cli/services/pty/pty-runtime-launch.js<br>lib/runtime/multiplexer/tmux-session-env.js |
| `AIH_PSMUX_CODEX_LAUNCH_RUNTIME` | 0 | 2 | lib/runtime/multiplexer/tmux-session-env.js<br>lib/runtime/persistent-session.js |
| `AIH_QODER_PROVIDER` | 0 | 2 | lib/cli/services/ai-cli/provider-runtime-env.js |
| `AIH_QUOTA_JSON_END` | 0 | 1 | lib/cli/services/usage/snapshot.js |
| `AIH_QUOTA_JSON_START` | 0 | 1 | lib/cli/services/usage/snapshot.js |
| `AIH_RELAY_MIHOMO_BIN` | 0 | 2 | lib/cli/services/toolkit/subscription-aggregator/relay/kernels/mihomo.js<br>lib/cli/services/toolkit/subscription-aggregator/relay/mihomo-binary.js |
| `AIH_RELAY_SING_BOX_BIN` | 0 | 2 | lib/cli/services/toolkit/subscription-aggregator/relay/kernels/sing-box.js<br>lib/cli/services/toolkit/subscription-aggregator/relay/sing-box-binary.js |
| `AIH_RUNTIME_SCOPE` | 0 | 1 | lib/server/session-lifecycle/codex-stdio-client.js |
| `AIH_SERVER_AUTOSTART` | 0 | 2 | lib/cli/services/pty/pty-runtime-launch.js |
| `AIH_SERVER_BACKGROUND_RESTART` | 0 | 1 | lib/server/source-auto-restart.js |
| `AIH_SERVER_ELEVATED_RESTART` | 0 | 1 | lib/cli/services/server/windows-restart-elevation.js |
| `AIH_SERVER_SOURCE_AUTO_RESTART` | 0 | 1 | lib/server/source-auto-restart.js |
| `AIH_SESSION` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_SESSION_MIRROR` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_SESSION_RESUME` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_SESSION_TARGET` | 0 | 1 | lib/runtime/persistent-session.js |
| `AIH_TERMINAL_TITLE_AUTO` | 0 | 1 | lib/cli/services/terminal-icons.js |
| `AIH_UPSTREAM_HEADERS` | 0 | 2 | lib/account/go-bridge/go-import-translator.js<br>lib/server/upstream-account-profile.js |
| `AIH_USAGE_BULK_JOBS` | 0 | 1 | lib/cli/services/usage/presenter.js |
| `AIH_USAGE_BULK_THRESHOLD` | 0 | 1 | lib/cli/services/usage/presenter.js |
| `AIH_WARP_PROVIDER_ICON_AUTO` | 0 | 1 | lib/cli/services/terminal-icons.js |
| `AIH_ZCODE_SESSION_ATTRIBUTION_SCOPE` | 0 | 1 | lib/runtime/zcode-session-attribution-hook.js |
| `AIH_ZCODE_USAGE_OWNER_LOG` | 0 | 1 | lib/runtime/zcode-usage-attribution-hook.js |

