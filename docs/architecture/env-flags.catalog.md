# 环境变量目录（全部 `AIH_*`，含含义）

> 生成命令：`npm run env:inventory -- --write`　生成时间：2026-10-17T05:08:02.742Z
> 共 **289** 个：公开 10 个（见 [env-flags.md](./env-flags.md)），其余为内部变量（见 [env-flags.internal.md](./env-flags.internal.md)）。
> 含义的唯一来源是 `lib/config/env-catalog.js`；漏写或多写都会被 `test/env-inventory.test.js` 拦下。

## path（数据/目录/仓库路径，23）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_HOST_HOME` | ✅ | 35 | 宿主真实家目录（公开；沙箱会话里必须钉住） |
| `AIH_HOME_DIR` | ✅ | 11 | 数据根目录（公开；默认 ~/.ai_home） |
| `AIH_CLI_PATH` | — | 5 | aih 可执行文件路径覆盖（自举/远程拉起时定位自身） |
| `AIH_CLAUDE_CLI_JS_PATH` | — | 3 | claude CLI 的 JS 入口路径（绕过 wrapper 找真实脚本） |
| `AIH_CLAUDE_CODE_COMMANDS_DIR` | — | 2 | claude 自定义 commands 目录（注入 aih 的 slash 命令） |
| `AIH_CODEX_HOME` | — | 2 | codex 配置根（沙箱投影 / 宿主切换） |
| `AIH_CODEX_SQLITE_HOME` | — | 2 | codex 状态 sqlite 目录（读会话与额度时定位） |
| `AIH_OPENCODE_CONFIG_DIR` | — | 2 | opencode 配置根（账号投影） |
| `AIH_ZCODE_DESKTOP_BRIDGE_DIR` | — | 2 | zcode 桌面桥接目录（登录态注入/读取） |
| `AIH_ANTIGRAVITY_APP_PATH` | — | 1 | Antigravity 应用路径（启动桌面版/采集） |
| `AIH_CODEX_AUTO_SKIP_REPO_CHECK` | — | 1 | 跳过 codex 的仓库信任检查（自动化场景） |
| `AIH_CODEX_USAGE_PATH` | — | 1 | codex 用量快照文件路径覆盖 |
| `AIH_EDGE_NGINX_CONF_DIR` | — | 1 | 托管 nginx 的配置目录 |
| `AIH_NODE_DIST_DIR` | — | 1 | 内置 Node 发行目录（无 Node 环境自举） |
| `AIH_PROVIDER_DEFS_DIR` | — | 1 | provider 定义/合同目录覆盖 |
| `AIH_QUOTA_PLUGIN_DIR` | — | 1 | 额度插件目录 |
| `AIH_RUNTIME_TOOLS_DIR` | — | 1 | 运行时工具目录（内置/下载的二进制） |
| `AIH_SSH_CLIP_SHIM_BIN_DIR` | — | 1 | SSH 剪贴板 shim 的 bin 目录 |
| `AIH_SSH_CLIP_SHIM_DIR` | — | 1 | SSH 剪贴板 shim 安装目录 |
| `AIH_CODEX_HOST_HOME` | — | 0 | codex 视角的宿主家目录（沙箱里定位宿主 auth/config） |
| `AIH_PROFILE_DIR` | — | 0 | 终端 profile 目录（iTerm/Warp 集成） |
| `AIH_ZCODE_CAPTCHA_HOOK_MODULE_PATH` | — | 0 | zcode 验证码 hook 注入模块路径 |
| `AIH_ZCODE_CAPTCHA_HOOK_STATE_PATH` | — | 0 | zcode 验证码 hook 状态文件路径 |

## network（端点 / 代理 / 端口，53）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_SERVER_PROXY_URL` | ✅ | 18 | 上游请求 HTTP(S) 代理（公开；config 优先） |
| `AIH_SERVER_NO_PROXY` | ✅ | 17 | 不走代理的主机列表（公开；config 优先） |
| `AIH_SERVER_PORT` | ✅ | 6 | 网关监听端口（公开；config 优先） |
| `AIH_SSH_CLIP_MAX_BYTES` | — | 6 | SSH 剪贴板单次传输上限（字节） |
| `AIH_RELAY_UDP_ADVERTISE_HOST` | — | 4 | 中转 UDP 播报给客户端的主机（config 优先） |
| `AIH_RELAY_UDP_ADVERTISE_PORT` | — | 4 | 中转 UDP 播报给客户端的端口（config 优先） |
| `AIH_SERVER_HOST` | ✅ | 4 | 网关监听地址（公开；config 优先） |
| `AIH_AGY_BASE_URL` | — | 3 | agy（code assist）上游 base URL 覆盖 |
| `AIH_AGY_QUOTA_BASE_URL` | — | 3 | agy 额度接口 base URL 覆盖 |
| `AIH_RELAY_LISTEN_HOST` | — | 3 | 中转入口绑定网卡（config 优先） |
| `AIH_RELAY_PORT_MODE` | — | 3 | 中转端口布局 server/dedicated（config 优先） |
| `AIH_REMOTE_SSH` | — | 3 | 远程主机 SSH 目标（远程 node/relay 操作） |
| `AIH_SERVER_CODEX_BASE_URL` | — | 3 | serve 的 codex 上游 base URL（--codex-base-url 的 env 形态） |
| `AIH_APPROVAL_URL` | — | 2 | 审批回调地址（MCP/HTTP 审批通道） |
| `AIH_CLAUDE_API_BASE_URL` | — | 2 | claude API base URL 覆盖 |
| `AIH_CODEX_REMOTE_PROXY` | — | 2 | codex 远程代理开关（=1 开，其它关） |
| `AIH_FABRIC_ENDPOINT` | — | 2 | fabric 服务端地址 |
| `AIH_PLUGIN_HOST_VERSION` | — | 2 | 插件宿主协议版本（兼容判断） |
| `AIH_SERVER_AGY_BASE_URL` | — | 2 | serve 的 agy 上游 base URL（--agy-base-url 的 env 形态） |
| `AIH_SERVER_CLAUDE_BASE_URL` | — | 2 | serve 的 claude 上游 base URL（--claude-base-url 的 env 形态） |
| `AIH_SERVER_CODEX_DESKTOP_REMOTE_PROXY` | — | 2 | codex 桌面远程代理开关（默认开） |
| `AIH_SERVER_GEMINI_BASE_URL` | — | 2 | serve 的 gemini 上游 base URL（--gemini-base-url 的 env 形态） |
| `AIH_SSH_CLIP_AGENT` | — | 2 | 远端剪贴板 agent 的启动方式/命令 |
| `AIH_SSH_CLIP_AGENT_SOCKET` | — | 2 | 剪贴板 agent socket 路径 |
| `AIH_SSH_CLIP_AGENT_URL` | — | 2 | 剪贴板 agent 的 URL |
| `AIH_SSH_CLIP_SHIM_TIMEOUT_MS` | — | 2 | 剪贴板 shim 请求超时 |
| `AIH_SSH_IMAGE_PASTE` | — | 2 | SSH 会话图片粘贴开关 |
| `AIH_SSH_TERMINAL_CLIPBOARD` | — | 2 | 终端剪贴板透传开关 |
| `AIH_SSH_TERMINAL_CLIPBOARD_TMUX_PASSTHROUGH` | — | 2 | 终端剪贴板经 tmux 透传 |
| `AIH_CLIP_AGENT_HOST` | — | 1 | 剪贴板 agent 监听地址 |
| `AIH_CLIP_AGENT_PORT` | — | 1 | 剪贴板 agent 监听端口 |
| `AIH_CODEX_USAGE_BASE_URL` | — | 1 | codex 用量 API base URL 覆盖 |
| `AIH_DEPLOY_SSH` | — | 1 | 部署脚本默认 SSH 目标 |
| `AIH_EDGE_AIH_PORT` | — | 1 | ⚠ 边缘代理回源到 AIH 的端口（待确认） |
| `AIH_FABRIC_LOCAL_URL` | — | 1 | fabric 本机回环地址 |
| `AIH_GO_CORE_HOST` | — | 1 | Go Core 子进程监听地址 |
| `AIH_OPENCODE_GATEWAY_BASE_URL` | — | 1 | opencode 网关 base URL 覆盖 |
| `AIH_SERVER_MANAGEMENT_URL` | — | 1 | ⚠ 管理入口 URL（脚本/远程管理用；待确认具体调用点） |
| `AIH_SERVER_STRICT_PORT` | — | 1 | 端口被占用时直接失败（不自动换端口） |
| `AIH_SSH_CLIP_AGENT_TIMEOUT_MS` | — | 1 | 剪贴板 agent 请求超时 |
| `AIH_SSH_CLIP_CHUNK_SIZE` | — | 1 | 剪贴板分块大小 |
| `AIH_SSH_CLIP_PROBE_TIMEOUT_MS` | — | 1 | 剪贴板能力探测超时 |
| `AIH_SSH_CLIP_SHIM_TTY` | — | 1 | shim 是否占用 TTY |
| `AIH_SSH_CLIP_WATCH` | — | 1 | 剪贴板监视开关 |
| `AIH_SSH_CLIPBOARD_SHIMS` | — | 1 | 要安装的剪贴板 shim 列表（pbcopy/xclip 等） |
| `AIH_SSH_TERMINAL_CLIPBOARD_TIMEOUT_MS` | — | 1 | 终端剪贴板操作超时 |
| `AIH_SSH_TERMINAL_PASTE_EVENTS` | — | 1 | 粘贴事件识别开关 |
| `AIH_GO_CORE_PORT` | — | 0 | Go Core 子进程监听端口 |
| `AIH_TURN_ICE_SERVER` | — | 0 | TURN 服务器（单个） |
| `AIH_TURN_ICE_SERVERS` | — | 0 | TURN 服务器列表（逗号分隔） |
| `AIH_TURN_USERNAME` | — | 0 | TURN 用户名 |
| `AIH_WEBTRANSPORT_PAGE_URL` | — | 0 | WebTransport 探测页 URL |
| `AIH_WEBTRANSPORT_URL` | — | 0 | fabric WebTransport 端点 |

## flag（开关与逃生门（环境准入），7）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_CODEX_ENABLE_STOP_NOTIFY_HOOK` | — | 2 | 启用 codex stop hook 通知 |
| `AIH_CLAUDE_DIAGNOSTIC_NO_EVIDENCE_COOLDOWN_MS` | — | 1 | 无证据诊断的冷却时间（本质是调参） |
| `AIH_CODEX_DISABLE_REMOTE_RESUME` | — | 1 | 禁止自动附加远程 resume 参数 |
| `AIH_GO_CORE_ENABLED` | — | 1 | 启用 Go Core 数据面（config 优先） |
| `AIH_RUNTIME_ENABLE_USAGE_SCHEDULER` | — | 1 | 启用运行时用量调度（内部） |
| `AIH_RUNTIME_FORCE_USAGE_STATUS_BAR` | — | 1 | 强制显示用量状态栏 |
| `AIH_NO_PERSIST` | ✅ | 0 | 交互式逃生门：=1 时不套 tmux（公开） |

## tuning（可调参数（超时 / TTL / 上限），46）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_AGY_USAGE_HTTP_TIMEOUT_MS` | — | 3 | agy 用量请求超时 |
| `AIH_AGY_WARM_MAX` | — | 2 | agy 暖机池并发上限（每实例 ~185MB） |
| `AIH_AGY_WARM_RESP_TIMEOUT_MS` | — | 2 | agy 暖机会话响应超时 |
| `AIH_AGY_WARM_TTL_MS` | — | 2 | agy 暖机会话空闲回收 TTL |
| `AIH_APPROVAL_TIMEOUT_MS` | — | 2 | 等待用户审批的上限 |
| `AIH_CLAUDE_USAGE_TIMEOUT_MS` | — | 2 | claude 用量接口超时 |
| `AIH_CODEX_USAGE_HTTP_TIMEOUT_MS` | — | 2 | codex 用量 HTTP 超时 |
| `AIH_SERVER_AGY_MAX_CONCURRENCY` | — | 2 | agy 并发上限（--agy-max-concurrency） |
| `AIH_SERVER_CLAUDE_MAX_CONCURRENCY` | — | 2 | claude 并发上限（--claude-max-concurrency） |
| `AIH_SERVER_CODEX_CLI_HOOK_SELF_HEAL_INTERVAL_MS` | — | 2 | codex CLI hook 自愈检查间隔 |
| `AIH_SERVER_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS` | — | 2 | codex 桌面 hook 自愈检查间隔 |
| `AIH_SERVER_CODEX_MAX_CONCURRENCY` | — | 2 | codex 并发上限（--codex-max-concurrency） |
| `AIH_SERVER_COOLDOWN_MS` | — | 2 | 账号失败冷却基础时长 |
| `AIH_SERVER_GEMINI_MAX_CONCURRENCY` | — | 2 | gemini 并发上限（--gemini-max-concurrency） |
| `AIH_SERVER_MAX_ATTEMPTS` | — | 2 | 单次请求最多尝试账号数（config 优先；0 = 3） |
| `AIH_SERVER_MODEL_USAGE_SCAN_INTERVAL_MS` | — | 2 | 会话用量扫描周期 |
| `AIH_SERVER_MODEL_USAGE_SCAN_START_DELAY_MS` | — | 2 | 会话用量扫描首跑延迟 |
| `AIH_SERVER_MODELS_CACHE_TTL_MS` | — | 2 | 模型目录缓存 TTL |
| `AIH_SERVER_OPENCODE_MAX_CONCURRENCY` | — | 2 | opencode 并发上限（--opencode-max-concurrency） |
| `AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_INTERVAL_MS` | — | 2 | provider CLI 自动升级检查周期 |
| `AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_START_DELAY_MS` | — | 2 | provider CLI 自动升级首跑延迟 |
| `AIH_SERVER_QUEUE_LIMIT` | — | 2 | 等待队列上限 |
| `AIH_SERVER_SESSION_AFFINITY_MAX` | — | 2 | 会话亲和表容量 |
| `AIH_SERVER_SESSION_AFFINITY_TTL_MS` | — | 2 | 会话亲和 TTL |
| `AIH_SERVER_UPSTREAM_TIMEOUT_MS` | — | 2 | 上游请求超时 |
| `AIH_SERVER_WINDOW_ACTIVATION_BATCH_SIZE` | — | 2 | 窗口激活单轮批量 |
| `AIH_SERVER_WINDOW_ACTIVATION_DEFAULT_INTERVAL_MS` | — | 2 | 窗口激活兜底间隔（config 优先） |
| `AIH_SERVER_WINDOW_ACTIVATION_MIN_INTERVAL_MS` | — | 2 | 窗口激活间隔下限（config 优先） |
| `AIH_SERVER_WINDOW_ACTIVATION_PROBE_TIMEOUT_MS` | — | 2 | 窗口激活探测超时 |
| `AIH_SERVER_WINDOW_ACTIVATION_START_DELAY_MS` | — | 2 | 窗口激活首跑延迟 |
| `AIH_SERVER_WINDOW_ACTIVATION_TICK_INTERVAL_MS` | — | 2 | 窗口激活调度 tick |
| `AIH_AGY_USAGE_REFRESH_TTL_MS` | — | 1 | agy 用量快照缓存 TTL |
| `AIH_CLAUDE_HOOK_DIAGNOSTIC_DELAY_MS` | — | 1 | claude hook 诊断输出延迟 |
| `AIH_CODEX_USAGE_SLOW_RETRY_TIMEOUT_MS` | — | 1 | codex 用量慢速重试超时 |
| `AIH_NATIVE_RUN_RETENTION_MS` | — | 1 | 原生运行记录保留时长（新名） |
| `AIH_RUNTIME_THRESHOLD_CHECK_MS` | — | 1 | 运行时阈值检查间隔 |
| `AIH_RUNTIME_USAGE_DISPLAY_INTERVAL_MS` | — | 1 | 状态栏用量刷新显示间隔 |
| `AIH_RUNTIME_USAGE_REFRESH_MIN_MS` | — | 1 | 状态栏用量最小刷新间隔 |
| `AIH_RUNTIME_USAGE_STALE_MS` | — | 1 | 用量数据过期阈值 |
| `AIH_NATIVE_FIRST_PROGRESS_TIMEOUT_MS` | — | 0 | 原生运行首字节超时（看门狗） |
| `AIH_NATIVE_STALL_TIMEOUT_MS` | — | 0 | 原生运行无进展超时 |
| `AIH_NATIVE_TIMEOUT_KILL_GRACE_MS` | — | 0 | 超时后强杀的宽限期 |
| `AIH_NATIVE_UPSTREAM_ERROR_TIMEOUT_MS` | — | 0 | 上游错误等待超时 |
| `AIH_SERVER_SOURCE_AUTO_RESTART_INTERVAL_MS` | — | 0 | 源码变更自动重启检查间隔 |
| `AIH_USAGE_BULK_PROBE_TIMEOUT_MS` | — | 0 | 批量用量扫描单账号探测超时 |
| `AIH_USAGE_SCAN_DEADLINE_MS` | — | 0 | 批量用量扫描整体截止时间 |

## credential（凭据与密钥（文档只写变量名，绝不放真实值），25）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_SERVER_MANAGEMENT_KEY` | ✅ | 22 | 管理面 key（公开；config 优先；空 = 管理面关闭） |
| `AIH_PLUGIN_TOKEN` | — | 4 | 插件 RPC 鉴权 token（宿主生成并注入插件） |
| `AIH_BENCH_KEY` | — | 2 | 基准/压测脚本使用的 key |
| `AIH_CLAUDE_OAUTH_TOKEN` | — | 2 | 注入 claude CLI 的 OAuth token（沙箱运行） |
| `AIH_CODEX_REMOTE_AUTH_TOKEN` | — | 2 | 远程 codex 认证 token |
| `AIH_CODEX_TOKEN_REFRESH_TIMEOUT_MS` | — | 2 | codex token 刷新超时 |
| `AIH_CODEX_TOKEN_URL` | — | 2 | codex OAuth token 端点覆盖 |
| `AIH_GEMINI_OAUTH_TOKEN` | — | 2 | 注入 gemini CLI 的 OAuth token |
| `AIH_PLUGIN_TOKEN_FROM_STDIN` | — | 2 | 让插件从 stdin 读取 token（避免出现在 argv） |
| `AIH_SERVER_API_KEY` | ✅ | 2 | 客户端 key（公开；含 Go Core；config 优先） |
| `AIH_SHADOW_GO_KEY` | — | 2 | gateway shadow 对比时 Go 端口令（只读环境，不落盘） |
| `AIH_SHADOW_NODE_KEY` | — | 2 | gateway shadow 对比时 Node 端口令 |
| `AIH_ACCOUNT_SMOKE_CLIENT_KEY` | — | 1 | 账号冒烟测试使用的一次性 key |
| `AIH_AGY_TOKEN_REFRESH_TIMEOUT_MS` | — | 1 | agy token 刷新超时 |
| `AIH_CLAUDE_TOKEN_REFRESH_TIMEOUT_MS` | — | 1 | claude token 刷新超时 |
| `AIH_CODEX_AUTH_PREFLIGHT` | — | 1 | 启动前做一次 token 预检 |
| `AIH_CODEX_USAGE_BULK_TOKEN_REFRESH` | — | 1 | 批量用量扫描前先刷新 token |
| `AIH_DEPLOY_SSH_KEY` | — | 1 | 部署脚本使用的 SSH 私钥 |
| `AIH_GO_CORE_CLIENT_KEY` | — | 1 | 传给 Go Core 的客户端 key |
| `AIH_GO_CORE_MANAGEMENT_KEY` | — | 1 | 传给 Go Core 的管理 key |
| `AIH_OPENCODE_GATEWAY_KEY` | — | 1 | opencode 网关 key 覆盖 |
| `AIH_RELAY_PASSWORD` | — | 1 | 中转 SOCKS5 密码（默认从 run/credentials.json 取） |
| `AIH_CLAUDE_CREDENTIAL_TYPE` | — | 0 | claude 凭据类型标记（oauth / api-key），透传给 CLI |
| `AIH_CODEX_LOCAL_REMOTE_TOKEN` | — | 0 | 本地 codex app-server 远程控制 token |
| `AIH_TURN_CREDENTIAL` | — | 0 | TURN 密码 |

## test（测试与探针专用，2）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_FFPROBE` | — | 2 | ffprobe 路径覆盖（视频附件抽帧） |
| `AIH_SERVER_MODELS_PROBE_ACCOUNTS` | — | 2 | 模型目录探测并发账号数（config 优先） |

## plumbing（内部管道（进程间传递的身份 / 标记），133）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_CODEX_GATEWAY_ACCOUNT_REF` | — | 6 | 网关请求钉选的账号（x-account-ref 来源） |
| `AIH_AGY_QUOTA_BASE_URLS` | — | 4 | agy 额度端点候选列表 |
| `AIH_PROVIDER_ACCOUNT_REF` | — | 4 | 当前运行账号的 accountRef（沙箱注入） |
| `AIH_RELAY_UDP` | — | 4 | 中转 UDP 开关（config 会写 0/1） |
| `AIH_AGY_CODE_ASSIST_CLIENT_VERSION` | — | 3 | code-assist 客户端版本（伪装头） |
| `AIH_CODEX_BIN` | — | 3 | codex 可执行文件路径 |
| `AIH_SERVER_CODEX_CLIENT_VERSION` | — | 3 | codex 客户端版本请求头 |
| `AIH_AGY_CODE_ASSIST_CHROME_VERSION` | — | 2 | code-assist Chrome UA 版本 |
| `AIH_AGY_CODE_ASSIST_ELECTRON_VERSION` | — | 2 | code-assist Electron UA 版本 |
| `AIH_AGY_CODE_ASSIST_MACHINE_ID` | — | 2 | code-assist machine id 请求头 |
| `AIH_AGY_CODE_ASSIST_USER_AGENT` | — | 2 | code-assist UA 覆盖 |
| `AIH_CODEX_DESKTOP_ACCOUNT_REF` | — | 2 | codex 桌面会话使用的账号 |
| `AIH_FABRIC_NODE_ID` | — | 2 | fabric 节点 id |
| `AIH_FFMPEG` | — | 2 | ffmpeg 路径 |
| `AIH_GEMINI_CLI_CLIENT_NAME` | — | 2 | gemini CLI 客户端名（请求头） |
| `AIH_GEMINI_CLI_SURFACE` | — | 2 | gemini CLI surface（terminal 等） |
| `AIH_GEMINI_CLI_VERSION` | — | 2 | gemini CLI 版本请求头 |
| `AIH_GEMINI_CODE_ASSIST_USER_AGENT` | — | 2 | gemini code-assist UA 覆盖 |
| `AIH_GEMINI_PROJECT_ID` | — | 2 | gemini OAuth 项目 id（模板替换） |
| `AIH_ITERM_PROVIDER_PROFILE` | — | 2 | iTerm profile 名覆盖（按 provider） |
| `AIH_KIMI_CODE_VERSION` | — | 2 | kimi-code 版本号 |
| `AIH_PLUGIN_EXIT_WITH_PARENT` | — | 2 | 插件随父进程退出 |
| `AIH_PLUGIN_SOCKET` | — | 2 | 插件 RPC socket 路径 |
| `AIH_PSMUX_INSTALL_PROMPT` | — | 2 | 是否提示安装 psmux |
| `AIH_RUN_ID` | — | 2 | 当前运行 id（WebUI chat/work 轮次关联） |
| `AIH_SERVER_BACKEND` | — | 2 | serve 后端模式（codex-adapter 等） |
| `AIH_SERVER_CODEX_DESKTOP_RESTART_APP_SERVER_ON_HOOK_CHANGE` | — | 2 | hook 变化时重启 codex app-server |
| `AIH_SERVER_CODEX_DESKTOP_TRACE_FILE` | — | 2 | codex 桌面 trace 输出文件 |
| `AIH_SERVER_CODEX_DESKTOP_TRACE_REMOTE` | — | 2 | remote-control trace 开关 |
| `AIH_SERVER_CODEX_DESKTOP_TRACE_RESPONSES` | — | 2 | responses trace 开关 |
| `AIH_SERVER_CODEX_MODELS` | — | 2 | codex 模型清单覆盖 |
| `AIH_SERVER_FAILURE_THRESHOLD` | — | 2 | 连续失败阈值（进入冷却前） |
| `AIH_SERVER_LOG_REQUESTS` | — | 2 | 是否打印请求日志 |
| `AIH_SERVER_MODEL_USAGE_SCAN` | — | 2 | 会话用量扫描开关 |
| `AIH_SERVER_PROVIDER` | — | 2 | 默认 provider（auto 等） |
| `AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE` | — | 2 | provider CLI 自动升级总开关 |
| `AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_APPLY` | — | 2 | 允许实际执行升级（否则只检查） |
| `AIH_SERVER_STRATEGY` | — | 2 | 选号策略（random / round-robin） |
| `AIH_SERVER_WINDOW_ACTIVATION` | — | 2 | 窗口激活全局开关（config 优先） |
| `AIH_TERMINAL_PROVIDER_TITLE` | — | 2 | 终端标题是否带 provider |
| `AIH_UTF8_LOCALE` | — | 2 | 强制 UTF-8 locale（终端兼容） |
| `AIH_WINDOWS_IMAGE_PASTE` | — | 2 | Windows 图片粘贴开关 |
| `AIH_ZCODE_AGENT_ENTRY` | — | 2 | zcode agent 入口脚本 |
| `AIH_ZCODE_AGENT_NODE` | — | 2 | zcode agent 使用的 node |
| `AIH_ZCODE_AGENT_RUNNER` | — | 2 | zcode agent runner 脚本 |
| `AIH_ZCODE_APP_VERSION` | — | 2 | zcode 应用版本 |
| `AIH_ZCODE_DESKTOP_BRIDGE_IDENTITY` | — | 2 | zcode 桌面桥接身份 |
| `AIH_AUTO_INSTALL_AGE` | — | 1 | 自动安装 Antigravity 的开关 |
| `AIH_CJK_LOCALE` | — | 1 | CJK locale 判定开关 |
| `AIH_CODEX_TUI_LOCAL_REMOTE` | — | 1 | codex TUI 本地 app-server 的远程控制开关 |
| `AIH_CODEX_USAGE_BULK_APP_SERVER_FALLBACK` | — | 1 | 批量用量回退到 app-server 读取 |
| `AIH_CODEX_USAGE_DIRECT` | — | 1 | 直接读取 codex 用量（跳过 CLI） |
| `AIH_DEPLOY_GO_TARGET` | — | 1 | 部署脚本的 Go 构建目标平台 |
| `AIH_EDGE_CADDY_BIN` | — | 1 | 托管 caddy 可执行文件路径 |
| `AIH_EDGE_CADDYFILE` | — | 1 | 托管 caddy 的 Caddyfile 路径 |
| `AIH_EDGE_FRPC_BIN` | — | 1 | 托管 frpc 可执行文件路径 |
| `AIH_EDGE_FRPC_CONFIG` | — | 1 | 托管 frpc 配置路径 |
| `AIH_EDGE_NGINX_BIN` | — | 1 | 托管 nginx 可执行文件路径 |
| `AIH_GO_CORE_ACCOUNT_SYNC` | — | 1 | Go Core 账号同步开关 |
| `AIH_GO_CORE_BINARY` | — | 1 | Go Core 二进制路径 |
| `AIH_GO_CORE_DELEGATE_REFRESH` | — | 1 | 由 Go Core 代办 token 刷新 |
| `AIH_GO_CORE_DOWNLOAD_BASE` | — | 1 | Go Core 工件下载基地址 |
| `AIH_GO_CORE_ROUTES` | — | 1 | 由 Go 承接的路由条目（config 优先） |
| `AIH_KONSOLE_PROVIDER_PROFILE` | — | 1 | Konsole profile 名覆盖 |
| `AIH_NATIVE_BINARY_REPAIR` | — | 1 | 原生二进制修复开关 |
| `AIH_NATIVE_CLI_PROJECT_FALLBACK` | — | 1 | 原生 CLI 找不到项目时的回退开关 |
| `AIH_NATIVE_RUN_WATCHDOG` | — | 1 | 原生运行看门狗开关 |
| `AIH_OPENCODE_GATEWAY_BYOK` | — | 1 | opencode BYOK overlay 显式 opt-in |
| `AIH_PERSIST_ACTIVE` | — | 1 | 当前已在持久会话内（防嵌套） |
| `AIH_PERSIST_DETACHED` | — | 1 | 持久会话由 restore 以 detached 方式创建 |
| `AIH_RELAY_USERNAME` | — | 1 | 中转 SOCKS5 用户名（由节点 id 派生） |
| `AIH_RUNTIME_AUTO_SWITCH` | — | 1 | 运行时自动切号（默认开，=0 关） |
| `AIH_RUNTIME_SHOW_USAGE` | — | 1 | 运行时显示用量 |
| `AIH_RUNTIME_USAGE_STATUS_BAR` | — | 1 | 状态栏用量展示开关 |
| `AIH_SERVER_CODEX_CLI_HOOK` | — | 1 | codex CLI hook 垫片路径 |
| `AIH_SERVER_CODEX_DESKTOP_HOOK` | — | 1 | codex 桌面 hook 垫片路径 |
| `AIH_SERVER_UPSTREAM_ERROR_RULES` | — | 1 | 由 Go 承接错误规则的 provider 列表（config 优先） |
| `AIH_SESSION_ARTIFACT_THRESHOLD` | — | 1 | ⚠ 设备会话启动时的产物记录阈值（待确认） |
| `AIH_SESSION_PICKER_ANIMATION` | — | 1 | 会话选择器动画开关 |
| `AIH_SESSION_PICKER_ICONS` | — | 1 | 会话选择器图标开关 |
| `AIH_SESSION_PICKER_SYMBOLS` | — | 1 | 会话选择器符号开关 |
| `AIH_SESSION_SCAN_ALL` | — | 1 | 扫描全部会话（不限当前项目） |
| `AIH_SHELL_DRAWER_HEIGHT` | — | 1 | shell drawer 高度 |
| `AIH_SKILL_INJECT` | — | 1 | 注入 skills 的开关 |
| `AIH_TERMINAL_ICON_AUTO` | — | 1 | 自动设置终端图标 |
| `AIH_TERMINAL_ICON_STRATEGY` | — | 1 | 终端图标策略 |
| `AIH_TRACE` | — | 1 | 统一调试开关：=1 全开，或逗号分隔 scope（agy-warm/models/model-chain/plugin/persist/artifact-hook/claude） |
| `AIH_UPSTREAM_ERROR_GROUP_IDS` | — | 1 | 账号适用的错误规则分组 id |
| `AIH_UPSTREAM_ERROR_RULES` | — | 1 | 账号自定义上游错误规则（JSON） |
| `AIH_WARP_PROVIDER_ICON` | — | 1 | Warp 的 provider 图标覆盖 |
| `AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR` | — | 1 | Windows 图片剪贴板镜像开关 |
| `AIH_WT_PROVIDER_PROFILE` | — | 1 | Windows Terminal profile 名覆盖 |
| `AIH_ZCODE_ALWAYS_THINKING_MODELS` | — | 1 | zcode 始终思考的模型清单 |
| `AIH_ZCODE_CLIENT_LANGUAGE` | — | 1 | zcode 客户端语言 |
| `AIH_ZCODE_CLIENT_TIMEZONE` | — | 1 | zcode 客户端时区 |
| `AIH_ACCOUNT_APP` | — | 0 | ⚠ 账号所属客户端标记（codex app / cli；待确认取值） |
| `AIH_ACCOUNT_ID` | — | 0 | 账号数字别名（cliAccountId） |
| `AIH_ACCOUNT_REF` | — | 0 | 账号唯一标识（accountRef，贯穿 server/WebUI/runtime） |
| `AIH_CLAUDE_TMUX_RENDER_RUNTIME` | — | 0 | claude 在 tmux 内的渲染运行时标记 |
| `AIH_CLI_ACCOUNT_ID` | — | 0 | CLI 账号数字别名（子进程用） |
| `AIH_CODEX_APP_SERVER_PASSTHROUGH` | — | 0 | codex app-server 透传标记 |
| `AIH_CODEX_MANAGED_LAUNCH` | — | 0 | 由 aih 托管的 codex 启动标记 |
| `AIH_CODEX_REMOTE_AUTOSTART` | — | 0 | 远程自动启动 codex 的标记 |
| `AIH_CODEX_USAGE_BULK_JOBS` | — | 0 | codex 批量用量并发任务数 |
| `AIH_IMAGE_API` | — | 0 | ⚠ 上游图像 API 选择标记（账号 env 透传；待确认取值） |
| `AIH_ITERM_PROVIDER_ICON_AUTO` | — | 0 | iTerm provider 图标自动 |
| `AIH_KONSOLE_PROVIDER_ICON_AUTO` | — | 0 | Konsole provider 图标自动 |
| `AIH_MULTIPLEXER` | ✅ | 0 | 复用器选择 auto/tmux/herdr/off（公开；off = 关闭复用器直接跑） |
| `AIH_OPENCODE_RUN_LAYOUT` | — | 0 | opencode run 布局逃生门（v1/v2） |
| `AIH_PERSIST_PROVIDER_SUPERVISOR_RUNTIME` | — | 0 | 持久会话 provider supervisor 运行时标记 |
| `AIH_PERSIST_UTF8_RUNTIME` | — | 0 | 持久会话 UTF-8 runtime 标记 |
| `AIH_PROFILE_ID` | — | 0 | 当前终端 profile id |
| `AIH_PROVIDER_SESSION_CORRELATION_ID` | — | 0 | provider 会话关联 id（事件关联） |
| `AIH_PSMUX_CODEX_LAUNCH_RUNTIME` | — | 0 | psmux 下 codex 启动运行时标记 |
| `AIH_QODER_PROVIDER` | — | 0 | qoder 家族的具体 provider（qoder / qodercn） |
| `AIH_RELAY_MIHOMO_BIN` | — | 0 | mihomo 二进制路径（中转边车） |
| `AIH_RELAY_SING_BOX_BIN` | — | 0 | sing-box 二进制路径（中转边车） |
| `AIH_RUNTIME_SCOPE` | — | 0 | 运行时作用域（accountRef 或 gateway） |
| `AIH_SERVER_AUTOSTART` | — | 0 | 由 autostart 拉起的标记 |
| `AIH_SERVER_BACKGROUND_RESTART` | — | 0 | 后台重启标记 |
| `AIH_SERVER_ELEVATED_RESTART` | — | 0 | 提权重启标记 |
| `AIH_SERVER_SOURCE_AUTO_RESTART` | — | 0 | 源码变更自动重启标记 |
| `AIH_SESSION` | — | 0 | 会话标签（-S / --session 的注入形态） |
| `AIH_SESSION_MIRROR` | — | 0 | 会话镜像模式标记 |
| `AIH_SESSION_RESUME` | — | 0 | 续接标记（restore 用） |
| `AIH_SESSION_TARGET` | — | 0 | 精确会话目标（picker / restore 注入） |
| `AIH_TERMINAL_TITLE_AUTO` | — | 0 | 自动设置终端标题 |
| `AIH_UPSTREAM_HEADERS` | — | 0 | 上游附加请求头（JSON） |
| `AIH_USAGE_BULK_JOBS` | — | 0 | 用量批量任务并发数 |
| `AIH_USAGE_BULK_THRESHOLD` | — | 0 | 进入批量扫描的阈值 |
| `AIH_WARP_PROVIDER_ICON_AUTO` | — | 0 | Warp provider 图标自动 |
| `AIH_ZCODE_SESSION_ATTRIBUTION_SCOPE` | — | 0 | zcode 会话归属作用域 |
| `AIH_ZCODE_USAGE_OWNER_LOG` | — | 0 | zcode 用量归属日志路径 |

