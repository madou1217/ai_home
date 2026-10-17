# 环境变量目录（全部 `AIH_*`，含含义）

> 生成命令：`npm run env:inventory -- --write`　生成时间：2026-10-17T12:03:48.244Z
> 共 **54** 个：公开 10 个（见 [env-flags.md](./env-flags.md)），其余为内部变量（见 [env-flags.internal.md](./env-flags.internal.md)）。
> 含义的唯一来源是 `lib/config/env-catalog.js`；漏写或多写都会被 `test/env-inventory.test.js` 拦下。

## path（数据/目录/仓库路径，4）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_HOST_HOME` | ✅ | 35 | 宿主真实家目录（公开；沙箱会话里必须钉住） |
| `AIH_HOME_DIR` | ✅ | 11 | 数据根目录（公开；默认 ~/.ai_home） |
| `AIH_CLI_PATH` | — | 5 | aih 可执行文件路径覆盖（自举/远程拉起时定位自身） |
| `AIH_RUNTIME_TOOLS_DIR` | — | 1 | 运行时工具目录（内置/下载的二进制） |

## network（端点 / 代理 / 端口，8）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_SERVER_PROXY_URL` | ✅ | 18 | 上游请求 HTTP(S) 代理（公开；config 优先） |
| `AIH_SERVER_NO_PROXY` | ✅ | 17 | 不走代理的主机列表（公开；config 优先） |
| `AIH_SERVER_PORT` | ✅ | 6 | 网关监听端口（公开；config 优先） |
| `AIH_SERVER_HOST` | ✅ | 4 | 网关监听地址（公开；config 优先） |
| `AIH_GO_CORE_HOST` | — | 1 | Go Core 子进程监听地址 |
| `AIH_GO_CORE_PORT` | — | 0 | Go Core 子进程监听端口 |
| `AIH_SSH_CLIP_SHIM_CONTEXT` | — | 0 | SSH 剪贴板 shim 路径（bin/邮箱根 两项合一） |
| `AIH_SSH_CLIPBOARD` | — | 0 | SSH 剪贴板桥模式（terminal/agent/endpoint 三项合一） |

## flag（开关与逃生门（环境准入），2）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_GO_CORE_ENABLED` | — | 1 | 启用 Go Core 数据面（config 优先） |
| `AIH_NO_PERSIST` | ✅ | 0 | 交互式逃生门：=1 时不套 tmux（公开） |

## credential（凭据与密钥（文档只写变量名，绝不放真实值），7）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_SERVER_MANAGEMENT_KEY` | ✅ | 22 | 管理面 key（公开；config 优先；空 = 管理面关闭） |
| `AIH_CODEX_REMOTE_AUTH_TOKEN` | — | 2 | 远程 codex 认证 token |
| `AIH_SERVER_API_KEY` | ✅ | 2 | 客户端 key（公开；含 Go Core；config 优先） |
| `AIH_GO_CORE_CLIENT_KEY` | — | 1 | 传给 Go Core 的客户端 key |
| `AIH_GO_CORE_MANAGEMENT_KEY` | — | 1 | 传给 Go Core 的管理 key |
| `AIH_CLAUDE_CREDENTIAL_TYPE` | — | 0 | claude 凭据类型标记（oauth / api-key），透传给 CLI |
| `AIH_CODEX_LOCAL_REMOTE_TOKEN` | — | 0 | 本地 codex app-server 远程控制 token |

## test（测试与探针专用，3）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_CLAUDE_USAGE_PROBE` | — | 2 | claude 用量探测上下文（token/baseUrl） |
| `AIH_CODEX_USAGE_PROBE` | — | 2 | codex 用量探测上下文（direct/baseUrl/path 三项合一） |
| `AIH_GEMINI_USAGE_PROBE` | — | 2 | gemini 用量探测上下文（token/projectId） |

## plumbing（内部管道（进程间传递的身份 / 标记），30）

| 变量 | 公开 | 读取 | 含义 |
| --- | --- | --- | --- |
| `AIH_CODEX_GATEWAY_ACCOUNT_REF` | — | 6 | 网关请求钉选的账号（x-account-ref 来源） |
| `AIH_PROVIDER_ACCOUNT_REF` | — | 4 | 当前运行账号的 accountRef（沙箱注入） |
| `AIH_CODEX_BIN` | — | 3 | codex 可执行文件路径 |
| `AIH_GO_CORE_ACCOUNT_SYNC` | — | 1 | Go Core 账号同步开关 |
| `AIH_GO_CORE_BINARY` | — | 1 | Go Core 二进制路径 |
| `AIH_GO_CORE_DELEGATE_REFRESH` | — | 1 | 由 Go Core 代办 token 刷新 |
| `AIH_GO_CORE_DOWNLOAD_BASE` | — | 1 | Go Core 工件下载基地址 |
| `AIH_GO_CORE_ROUTES` | — | 1 | 由 Go 承接的路由条目（config 优先） |
| `AIH_SERVER_UPSTREAM_ERROR_RULES` | — | 1 | 由 Go 承接错误规则的 provider 列表（config 优先） |
| `AIH_SESSION_INTENT` | — | 1 | 会话意图（label/resume/mirror/target/active/detached 六项合一） |
| `AIH_TRACE` | — | 1 | 统一调试开关：=1 全开，或逗号分隔 scope（agy-warm/models/model-chain/plugin/persist/artifact-hook/claude） |
| `AIH_UPSTREAM_ERROR_GROUP_IDS` | — | 1 | 账号适用的错误规则分组 id |
| `AIH_UPSTREAM_ERROR_RULES` | — | 1 | 账号自定义上游错误规则（JSON） |
| `AIH_ACCOUNT_APP` | — | 0 | ⚠ 账号所属客户端标记（codex app / cli；待确认取值） |
| `AIH_AGY_USAGE` | — | 0 | agy 用量上下文（baseUrl/quotaBaseUrls/clientVersion） |
| `AIH_CLI_FEATURES` | — | 0 | CLI 功能开关（psmux 提示/skill 注入/Windows 镜像） |
| `AIH_CODEX_APP_SERVER_PASSTHROUGH` | — | 0 | codex app-server 透传标记 |
| `AIH_CODEX_FLAGS` | — | 0 | codex 启动/恢复开关（authPreflight/autoSkipRepoCheck/disableRemoteResume 三项合一） |
| `AIH_EDGE_CONTEXT` | — | 0 | 边缘代理配置位置（caddyfile/nginxConfDir/frpcConfig 三项合一） |
| `AIH_IMAGE_API` | — | 0 | ⚠ 上游图像 API 选择标记（账号 env 透传；待确认取值） |
| `AIH_LAUNCH_CONTEXT` | — | 0 | 单文件启动上下文：父进程写 0600 JSON，子进程只收文件路径（取代一批零散 AIH_* 上下文字段） |
| `AIH_MULTIPLEXER` | ✅ | 0 | 复用器选择 auto/tmux/herdr/off（公开；off = 关闭复用器直接跑） |
| `AIH_OPENCODE_GATEWAY` | — | 0 | opencode 网关连接（baseUrl/apiKey 两项合一） |
| `AIH_PROVIDER_EXTENSION_DIRS` | — | 0 | 外部 provider 扩展目录（defs/quota 两项合一） |
| `AIH_RELAY_SETTINGS` | — | 0 | 中转运行参数（udp/播报地址/端口/端口模式/绑定网卡 五项合一） |
| `AIH_RUNTIME_MARKER` | — | 0 | 持久会话运行时兼容标记（utf8/claude/psmux/supervisor 四项合一） |
| `AIH_RUNTIME_USAGE` | — | 0 | 运行时用量显示/调度（show/scheduler 两项合一） |
| `AIH_SERVER_RESTART` | — | 0 | 服务重启上下文（mode/sourceAuto 两项合一） |
| `AIH_UPSTREAM_HEADERS` | — | 0 | 上游附加请求头（JSON） |
| `AIH_ZCODE_CONTEXT` | — | 0 | ZCode 运行时上下文（scope/验证码状态/用量日志 三项合一） |

