'use strict';

// `AIH_*` 的**含义目录**（唯一人读说明）。名字/分类/引用处来自
// `scripts/collect-env-flags.js` 的扫描，含义来自这里；
// `docs/architecture/env-flags.catalog.md` 由两者合并渲染。
//
// 纪律：每个扫到的变量都必须在这里有一行，反之亦然
// （`test/env-inventory.test.js` 双向核对，漏写/多写都会红）。
// 写「它是什么 / 谁设置 / 影响什么」，不要写实现细节；不确定就写「待确认」，不要猜。

const ENV_MEANINGS = {
  // ── path：数据 / 目录 / 仓库路径（24）─────────────────────────────
  AIH_HOME_DIR: '数据根目录（公开；默认 ~/.ai_home）',
  AIH_HOST_HOME: '宿主真实家目录（公开；沙箱会话里必须钉住）',
  AIH_CLI_PATH: 'aih 可执行文件路径覆盖（自举/远程拉起时定位自身）',
  AIH_CODEX_HOME: 'codex 配置根（沙箱投影 / 宿主切换）',
  AIH_CODEX_SQLITE_HOME: 'codex 状态 sqlite 目录（读会话与额度时定位）',
  AIH_OPENCODE_CONFIG_DIR: 'opencode 配置根（账号投影）',
  AIH_ZCODE_DESKTOP_BRIDGE_DIR: 'zcode 桌面桥接目录（登录态注入/读取）',
  AIH_CODEX_USAGE_PROBE: 'codex 用量探测上下文（direct/baseUrl/path 三项合一）',
  AIH_CODEX_AUTH_PREFLIGHT: '启动前做一次 token 预检（内部/测试可关）',
  AIH_CODEX_AUTO_SKIP_REPO_CHECK: '跳过 codex 的仓库信任检查（自动化场景）',
  AIH_EDGE_NGINX_CONF_DIR: '托管 nginx 的配置目录',
  AIH_NODE_DIST_DIR: '内置 Node 发行目录（无 Node 环境自举）',
  AIH_PROVIDER_DEFS_DIR: 'provider 定义/合同目录覆盖',
  AIH_QUOTA_PLUGIN_DIR: '额度插件目录',
  AIH_RUNTIME_TOOLS_DIR: '运行时工具目录（内置/下载的二进制）',

  // ── network：端点 / 代理 / 端口（55）─────────────────────────────
  AIH_SERVER_PROXY_URL: '上游请求 HTTP(S) 代理（公开；config 优先）',
  AIH_SERVER_NO_PROXY: '不走代理的主机列表（公开；config 优先）',
  AIH_SERVER_HOST: '网关监听地址（公开；config 优先）',
  AIH_SERVER_PORT: '网关监听端口（公开；config 优先）',
  AIH_AGY_BASE_URL: 'agy（code assist）上游 base URL 覆盖',
  AIH_AGY_QUOTA_BASE_URL: 'agy 额度接口 base URL 覆盖',
  AIH_REMOTE_SSH: '远程主机 SSH 目标（远程 node/relay 操作）',
  AIH_CLAUDE_API_BASE_URL: 'claude API base URL 覆盖',
  AIH_SSH_CLIP_SHIM_CONTEXT: 'SSH 剪贴板 shim 路径（bin/邮箱根 两项合一）',
  AIH_SSH_CLIP_AGENT_ENDPOINT: '剪贴板 agent 端点（unix:/path 或 URL）',
  AIH_SSH_CLIP_AGENT: '远端剪贴板 agent 的启动方式/命令',
  AIH_SSH_TERMINAL_CLIPBOARD: '终端剪贴板透传开关',
  AIH_CODEX_REMOTE_PROXY: 'codex 远程代理开关（=1 开，其它关）',
  AIH_GO_CORE_HOST: 'Go Core 子进程监听地址',
  AIH_GO_CORE_PORT: 'Go Core 子进程监听端口',
  AIH_OPENCODE_GATEWAY_BASE_URL: 'opencode 网关 base URL 覆盖',

  // ── credential：凭据与密钥（27）──────────────────────────────────
  AIH_SERVER_MANAGEMENT_KEY: '管理面 key（公开；config 优先；空 = 管理面关闭）',
  AIH_CLAUDE_OAUTH_TOKEN: '注入 claude CLI 的 OAuth token（沙箱运行）',
  AIH_CODEX_REMOTE_AUTH_TOKEN: '远程 codex 认证 token',
  AIH_GEMINI_OAUTH_TOKEN: '注入 gemini CLI 的 OAuth token',
  AIH_SERVER_API_KEY: '客户端 key（公开；含 Go Core；config 优先）',
  AIH_GO_CORE_CLIENT_KEY: '传给 Go Core 的客户端 key',
  AIH_GO_CORE_MANAGEMENT_KEY: '传给 Go Core 的管理 key',
  AIH_OPENCODE_GATEWAY_KEY: 'opencode 网关 key 覆盖',
  AIH_CLAUDE_CREDENTIAL_TYPE: 'claude 凭据类型标记（oauth / api-key），透传给 CLI',
  AIH_CODEX_LOCAL_REMOTE_TOKEN: '本地 codex app-server 远程控制 token',

  // ── tuning：可调参数（51）───────────────────────────────────────

  // ── flag：开关与逃生门（8）─────────────────────────────────────
  AIH_CODEX_DISABLE_REMOTE_RESUME: '禁止自动附加远程 resume 参数',
  AIH_GO_CORE_ENABLED: '启用 Go Core 数据面（config 优先）',
  AIH_RUNTIME_ENABLE_USAGE_SCHEDULER: '启用运行时用量调度（内部）',
  AIH_TRACE: '统一调试开关：=1 全开，或逗号分隔 scope（agy-warm/models/model-chain/plugin/persist/artifact-hook/claude）',
  AIH_LAUNCH_CONTEXT: '单文件启动上下文：父进程写 0600 JSON，子进程只收文件路径（取代一批零散 AIH_* 上下文字段）',
  AIH_NO_PERSIST: '交互式逃生门：=1 时不套 tmux（公开）',

  // ── test：测试 / 探针（2）───────────────────────────────────────

  // ── plumbing：内部传递的身份 / 标记（153）───────────────────────
  AIH_CODEX_GATEWAY_ACCOUNT_REF: '网关请求钉选的账号（x-account-ref 来源）',
  AIH_PROVIDER_ACCOUNT_REF: '当前运行账号的 accountRef（沙箱注入）',
  AIH_AGY_QUOTA_BASE_URLS: 'agy 额度端点候选列表',
  AIH_AGY_CODE_ASSIST_CLIENT_VERSION: 'code-assist 客户端版本（伪装头）',
  AIH_CODEX_BIN: 'codex 可执行文件路径',
  AIH_GEMINI_PROJECT_ID: 'gemini OAuth 项目 id（模板替换）',
  AIH_PSMUX_INSTALL_PROMPT: '是否提示安装 psmux',
  AIH_ZCODE_DESKTOP_BRIDGE_IDENTITY: 'zcode 桌面桥接身份',

  AIH_CODEX_TUI_LOCAL_REMOTE: 'codex TUI 本地 app-server 的远程控制开关',
  AIH_EDGE_CADDY_BIN: '托管 caddy 可执行文件路径',
  AIH_EDGE_CADDYFILE: '托管 caddy 的 Caddyfile 路径',
  AIH_EDGE_FRPC_BIN: '托管 frpc 可执行文件路径',
  AIH_EDGE_FRPC_CONFIG: '托管 frpc 配置路径',
  AIH_EDGE_NGINX_BIN: '托管 nginx 可执行文件路径',
  AIH_GO_CORE_ACCOUNT_SYNC: 'Go Core 账号同步开关',
  AIH_GO_CORE_BINARY: 'Go Core 二进制路径',
  AIH_GO_CORE_DELEGATE_REFRESH: '由 Go Core 代办 token 刷新',
  AIH_GO_CORE_DOWNLOAD_BASE: 'Go Core 工件下载基地址',
  AIH_GO_CORE_ROUTES: '由 Go 承接的路由条目（config 优先）',
  AIH_OPENCODE_GATEWAY_BYOK: 'opencode BYOK overlay 显式 opt-in',
  AIH_RUNTIME_SHOW_USAGE: '运行时显示用量',
  AIH_SERVER_UPSTREAM_ERROR_RULES: '由 Go 承接错误规则的 provider 列表（config 优先）',
  AIH_SKILL_INJECT: '注入 skills 的开关',
  AIH_UPSTREAM_ERROR_GROUP_IDS: '账号适用的错误规则分组 id',
  AIH_UPSTREAM_ERROR_RULES: '账号自定义上游错误规则（JSON）',
  AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR: 'Windows 图片剪贴板镜像开关',
  AIH_ZCODE_CONTEXT: 'ZCode 运行时上下文（scope/验证码状态/用量日志 三项合一）',
  AIH_ZCODE_ALWAYS_THINKING_MODELS: 'zcode 始终思考的模型清单',
  AIH_ACCOUNT_APP: '⚠ 账号所属客户端标记（codex app / cli；待确认取值）',
  AIH_CODEX_APP_SERVER_PASSTHROUGH: 'codex app-server 透传标记',
  AIH_CODEX_HOOKS: 'codex hook 安装开关（cli/desktop/none 列表）',
  AIH_CODEX_MANAGED_LAUNCH: '由 aih 托管的 codex 启动标记',
  AIH_IMAGE_API: '⚠ 上游图像 API 选择标记（账号 env 透传；待确认取值）',
  AIH_MULTIPLEXER: '复用器选择 auto/tmux/herdr/off（公开；off = 关闭复用器直接跑）',
  AIH_OPENCODE_RUN_LAYOUT: 'opencode run 布局逃生门（v1/v2）',
  AIH_PROVIDER_SESSION_CORRELATION_ID: 'provider 会话关联 id（事件关联）',
  AIH_RUNTIME_MARKER: '持久会话运行时兼容标记（utf8/claude/psmux/supervisor 四项合一）',
  AIH_SESSION_INTENT: '会话意图（label/resume/mirror/target/active/detached 六项合一）',
  AIH_RELAY_SETTINGS: '中转运行参数（udp/播报地址/端口/端口模式/绑定网卡 五项合一）',
  AIH_RELAY_MIHOMO_BIN: 'mihomo 二进制路径（中转边车）',
  AIH_RELAY_SING_BOX_BIN: 'sing-box 二进制路径（中转边车）',
  AIH_SERVER_AUTOSTART: '由 autostart 拉起的标记',
  AIH_SERVER_BACKGROUND_RESTART: '后台重启标记',
  AIH_SERVER_ELEVATED_RESTART: '提权重启标记',
  AIH_SERVER_SOURCE_AUTO_RESTART: '源码变更自动重启标记',
  AIH_UPSTREAM_HEADERS: '上游附加请求头（JSON）',
};

module.exports = { ENV_MEANINGS };
