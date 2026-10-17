# 环境变量目录（全部 `AIH_*`，含含义）

> 生成命令：`npm run env:inventory -- --write`　生成时间：2026-10-17T09:11:12.512Z
> 共 **113** 个：公开 10 个（见 [env-flags.md](./env-flags.md)），其余为内部变量（见 [env-flags.internal.md](./env-flags.internal.md)）。
> 含义的唯一来源是 `lib/config/env-catalog.js`；漏写或多写都会被 `test/env-inventory.test.js` 拦下。

## path（数据/目录/仓库路径，19）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_HOST_HOME` | ✅ | 35 | 宿主真实家目录（公开；沙箱会话里必须钉住） |
| `AIH_HOME_DIR` | ✅ | 11 | 数据根目录（公开；默认 ~/.ai_home） |
| `AIH_CLI_PATH` | — | 5 | aih 可执行文件路径覆盖（自举/远程拉起时定位自身） |
| `AIH_CLAUDE_CODE_COMMANDS_DIR` | — | 2 | claude 自定义 commands 目录（注入 aih 的 slash 命令） |
| `AIH_CODEX_HOME` | — | 2 | codex 配置根（沙箱投影 / 宿主切换） |
| `AIH_CODEX_SQLITE_HOME` | — | 2 | codex 状态 sqlite 目录（读会话与额度时定位） |
| `AIH_OPENCODE_CONFIG_DIR` | — | 2 | opencode 配置根（账号投影） |
| `AIH_ZCODE_DESKTOP_BRIDGE_DIR` | — | 2 | zcode 桌面桥接目录（登录态注入/读取） |
| `AIH_CODEX_AUTO_SKIP_REPO_CHECK` | — | 1 | 跳过 codex 的仓库信任检查（自动化场景） |
| `AIH_CODEX_USAGE_PATH` | — | 1 | codex 用量快照文件路径覆盖 |
| `AIH_EDGE_NGINX_CONF_DIR` | — | 1 | 托管 nginx 的配置目录 |
| `AIH_NODE_DIST_DIR` | — | 1 | 内置 Node 发行目录（无 Node 环境自举） |
| `AIH_PROVIDER_DEFS_DIR` | — | 1 | provider 定义/合同目录覆盖 |
| `AIH_QUOTA_PLUGIN_DIR` | — | 1 | 额度插件目录 |
| `AIH_RUNTIME_TOOLS_DIR` | — | 1 | 运行时工具目录（内置/下载的二进制） |
| `AIH_SSH_CLIP_SHIM_BIN_DIR` | — | 1 | SSH 剪贴板 shim 的 bin 目录 |
| `AIH_SSH_CLIP_SHIM_DIR` | — | 1 | SSH 剪贴板 shim 安装目录 |
| `AIH_ZCODE_CAPTCHA_HOOK_MODULE_PATH` | — | 0 | zcode 验证码 hook 注入模块路径 |
| `AIH_ZCODE_CAPTCHA_HOOK_STATE_PATH` | — | 0 | zcode 验证码 hook 状态文件路径 |

## network（端点 / 代理 / 端口，21）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_SERVER_PROXY_URL` | ✅ | 18 | 上游请求 HTTP(S) 代理（公开；config 优先） |
| `AIH_SERVER_NO_PROXY` | ✅ | 17 | 不走代理的主机列表（公开；config 优先） |
| `AIH_SERVER_PORT` | ✅ | 6 | 网关监听端口（公开；config 优先） |
| `AIH_RELAY_UDP_ADVERTISE_HOST` | — | 4 | 中转 UDP 播报给客户端的主机（config 优先） |
| `AIH_RELAY_UDP_ADVERTISE_PORT` | — | 4 | 中转 UDP 播报给客户端的端口（config 优先） |
| `AIH_SERVER_HOST` | ✅ | 4 | 网关监听地址（公开；config 优先） |
| `AIH_AGY_BASE_URL` | — | 3 | agy（code assist）上游 base URL 覆盖 |
| `AIH_AGY_QUOTA_BASE_URL` | — | 3 | agy 额度接口 base URL 覆盖 |
| `AIH_RELAY_LISTEN_HOST` | — | 3 | 中转入口绑定网卡（config 优先） |
| `AIH_RELAY_PORT_MODE` | — | 3 | 中转端口布局 server/dedicated（config 优先） |
| `AIH_REMOTE_SSH` | — | 3 | 远程主机 SSH 目标（远程 node/relay 操作） |
| `AIH_CLAUDE_API_BASE_URL` | — | 2 | claude API base URL 覆盖 |
| `AIH_CODEX_REMOTE_PROXY` | — | 2 | codex 远程代理开关（=1 开，其它关） |
| `AIH_SSH_CLIP_AGENT` | — | 2 | 远端剪贴板 agent 的启动方式/命令 |
| `AIH_SSH_CLIP_AGENT_SOCKET` | — | 2 | 剪贴板 agent socket 路径 |
| `AIH_SSH_CLIP_AGENT_URL` | — | 2 | 剪贴板 agent 的 URL |
| `AIH_SSH_TERMINAL_CLIPBOARD` | — | 2 | 终端剪贴板透传开关 |
| `AIH_CODEX_USAGE_BASE_URL` | — | 1 | codex 用量 API base URL 覆盖 |
| `AIH_GO_CORE_HOST` | — | 1 | Go Core 子进程监听地址 |
| `AIH_OPENCODE_GATEWAY_BASE_URL` | — | 1 | opencode 网关 base URL 覆盖 |
| `AIH_GO_CORE_PORT` | — | 0 | Go Core 子进程监听端口 |

## flag（开关与逃生门（环境准入），5）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_CODEX_ENABLE_STOP_NOTIFY_HOOK` | — | 2 | 启用 codex stop hook 通知 |
| `AIH_CODEX_DISABLE_REMOTE_RESUME` | — | 1 | 禁止自动附加远程 resume 参数 |
| `AIH_GO_CORE_ENABLED` | — | 1 | 启用 Go Core 数据面（config 优先） |
| `AIH_RUNTIME_ENABLE_USAGE_SCHEDULER` | — | 1 | 启用运行时用量调度（内部） |
| `AIH_NO_PERSIST` | ✅ | 0 | 交互式逃生门：=1 时不套 tmux（公开） |

## credential（凭据与密钥（文档只写变量名，绝不放真实值），11）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_SERVER_MANAGEMENT_KEY` | ✅ | 22 | 管理面 key（公开；config 优先；空 = 管理面关闭） |
| `AIH_CLAUDE_OAUTH_TOKEN` | — | 2 | 注入 claude CLI 的 OAuth token（沙箱运行） |
| `AIH_CODEX_REMOTE_AUTH_TOKEN` | — | 2 | 远程 codex 认证 token |
| `AIH_GEMINI_OAUTH_TOKEN` | — | 2 | 注入 gemini CLI 的 OAuth token |
| `AIH_SERVER_API_KEY` | ✅ | 2 | 客户端 key（公开；含 Go Core；config 优先） |
| `AIH_CODEX_AUTH_PREFLIGHT` | — | 1 | 启动前做一次 token 预检（内部/测试可关） |
| `AIH_GO_CORE_CLIENT_KEY` | — | 1 | 传给 Go Core 的客户端 key |
| `AIH_GO_CORE_MANAGEMENT_KEY` | — | 1 | 传给 Go Core 的管理 key |
| `AIH_OPENCODE_GATEWAY_KEY` | — | 1 | opencode 网关 key 覆盖 |
| `AIH_CLAUDE_CREDENTIAL_TYPE` | — | 0 | claude 凭据类型标记（oauth / api-key），透传给 CLI |
| `AIH_CODEX_LOCAL_REMOTE_TOKEN` | — | 0 | 本地 codex app-server 远程控制 token |

## test（测试与探针专用，1）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_FFPROBE` | — | 2 | ffprobe 路径覆盖（视频附件抽帧） |

## plumbing（内部管道（进程间传递的身份 / 标记），56）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_CODEX_GATEWAY_ACCOUNT_REF` | — | 6 | 网关请求钉选的账号（x-account-ref 来源） |
| `AIH_AGY_QUOTA_BASE_URLS` | — | 4 | agy 额度端点候选列表 |
| `AIH_PROVIDER_ACCOUNT_REF` | — | 4 | 当前运行账号的 accountRef（沙箱注入） |
| `AIH_RELAY_UDP` | — | 4 | 中转 UDP 开关（config 会写 0/1） |
| `AIH_AGY_CODE_ASSIST_CLIENT_VERSION` | — | 3 | code-assist 客户端版本（伪装头） |
| `AIH_CODEX_BIN` | — | 3 | codex 可执行文件路径 |
| `AIH_FFMPEG` | — | 2 | ffmpeg 路径 |
| `AIH_GEMINI_PROJECT_ID` | — | 2 | gemini OAuth 项目 id（模板替换） |
| `AIH_PSMUX_INSTALL_PROMPT` | — | 2 | 是否提示安装 psmux |
| `AIH_ZCODE_AGENT_ENTRY` | — | 2 | zcode agent 入口脚本 |
| `AIH_ZCODE_AGENT_NODE` | — | 2 | zcode agent 使用的 node |
| `AIH_ZCODE_AGENT_RUNNER` | — | 2 | zcode agent runner 脚本 |
| `AIH_ZCODE_DESKTOP_BRIDGE_IDENTITY` | — | 2 | zcode 桌面桥接身份 |
| `AIH_CODEX_TUI_LOCAL_REMOTE` | — | 1 | codex TUI 本地 app-server 的远程控制开关 |
| `AIH_CODEX_USAGE_DIRECT` | — | 1 | 直接读取 codex 用量（内部/测试可关，回退 app-server） |
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
| `AIH_OPENCODE_GATEWAY_BYOK` | — | 1 | opencode BYOK overlay 显式 opt-in |
| `AIH_RUNTIME_SHOW_USAGE` | — | 1 | 运行时显示用量 |
| `AIH_SERVER_CODEX_CLI_HOOK` | — | 1 | codex CLI hook 垫片路径 |
| `AIH_SERVER_CODEX_DESKTOP_HOOK` | — | 1 | codex 桌面 hook 垫片路径 |
| `AIH_SERVER_UPSTREAM_ERROR_RULES` | — | 1 | 由 Go 承接错误规则的 provider 列表（config 优先） |
| `AIH_SESSION_INTENT` | — | 1 | 会话意图（label/resume/mirror/target/active/detached 六项合一） |
| `AIH_SKILL_INJECT` | — | 1 | 注入 skills 的开关 |
| `AIH_TRACE` | — | 1 | 统一调试开关：=1 全开，或逗号分隔 scope（agy-warm/models/model-chain/plugin/persist/artifact-hook/claude） |
| `AIH_UPSTREAM_ERROR_GROUP_IDS` | — | 1 | 账号适用的错误规则分组 id |
| `AIH_UPSTREAM_ERROR_RULES` | — | 1 | 账号自定义上游错误规则（JSON） |
| `AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR` | — | 1 | Windows 图片剪贴板镜像开关 |
| `AIH_WT_PROVIDER_PROFILE` | — | 1 | Windows Terminal profile 名覆盖 |
| `AIH_ZCODE_ALWAYS_THINKING_MODELS` | — | 1 | zcode 始终思考的模型清单 |
| `AIH_ACCOUNT_APP` | — | 0 | ⚠ 账号所属客户端标记（codex app / cli；待确认取值） |
| `AIH_CODEX_APP_SERVER_PASSTHROUGH` | — | 0 | codex app-server 透传标记 |
| `AIH_CODEX_MANAGED_LAUNCH` | — | 0 | 由 aih 托管的 codex 启动标记 |
| `AIH_IMAGE_API` | — | 0 | ⚠ 上游图像 API 选择标记（账号 env 透传；待确认取值） |
| `AIH_LAUNCH_CONTEXT` | — | 0 | 单文件启动上下文：父进程写 0600 JSON，子进程只收文件路径（取代一批零散 AIH_* 上下文字段） |
| `AIH_MULTIPLEXER` | ✅ | 0 | 复用器选择 auto/tmux/herdr/off（公开；off = 关闭复用器直接跑） |
| `AIH_OPENCODE_RUN_LAYOUT` | — | 0 | opencode run 布局逃生门（v1/v2） |
| `AIH_PROVIDER_SESSION_CORRELATION_ID` | — | 0 | provider 会话关联 id（事件关联） |
| `AIH_RELAY_MIHOMO_BIN` | — | 0 | mihomo 二进制路径（中转边车） |
| `AIH_RELAY_SING_BOX_BIN` | — | 0 | sing-box 二进制路径（中转边车） |
| `AIH_RUNTIME_MARKER` | — | 0 | 持久会话运行时兼容标记（utf8/claude/psmux/supervisor 四项合一） |
| `AIH_SERVER_AUTOSTART` | — | 0 | 由 autostart 拉起的标记 |
| `AIH_SERVER_BACKGROUND_RESTART` | — | 0 | 后台重启标记 |
| `AIH_SERVER_ELEVATED_RESTART` | — | 0 | 提权重启标记 |
| `AIH_SERVER_SOURCE_AUTO_RESTART` | — | 0 | 源码变更自动重启标记 |
| `AIH_UPSTREAM_HEADERS` | — | 0 | 上游附加请求头（JSON） |
| `AIH_ZCODE_SESSION_ATTRIBUTION_SCOPE` | — | 0 | zcode 会话归属作用域 |
| `AIH_ZCODE_USAGE_OWNER_LOG` | — | 0 | zcode 用量归属日志路径 |

