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
  AIH_CLI_FEATURES: 'CLI 功能开关（psmux 提示/skill 注入/Windows 镜像）',
  AIH_CLI_PATH: 'aih 可执行文件路径覆盖（自举/远程拉起时定位自身）',
  AIH_CODEX_USAGE_PROBE: 'codex 用量探测上下文（direct/baseUrl/path 三项合一）',
  AIH_RUNTIME_USAGE: '运行时用量显示/调度（show/scheduler 两项合一）',
  AIH_RUNTIME_TOOLS_DIR: '运行时工具目录（内置/下载的二进制）',

  // ── network：端点 / 代理 / 端口（55）─────────────────────────────
  AIH_SERVER_PROXY_URL: '上游请求 HTTP(S) 代理（公开；config 优先）',
  AIH_SERVER_NO_PROXY: '不走代理的主机列表（公开；config 优先）',
  AIH_SERVER_HOST: '网关监听地址（公开；config 优先）',
  AIH_SERVER_PORT: '网关监听端口（公开；config 优先）',
  AIH_SSH_CLIPBOARD: 'SSH 剪贴板桥模式（terminal/agent/endpoint 三项合一）',
  AIH_SSH_CLIP_SHIM_CONTEXT: 'SSH 剪贴板 shim 路径（bin/邮箱根 两项合一）',

  // ── credential：凭据与密钥（27）──────────────────────────────────
  AIH_SERVER_MANAGEMENT_KEY: '管理面 key（公开；config 优先；空 = 管理面关闭）',
  AIH_CODEX_REMOTE_AUTH_TOKEN: '远程 codex 认证 token',
  AIH_SERVER_API_KEY: '客户端 key（公开；含 Go Core；config 优先）',
  AIH_GO_CORE_CLIENT_KEY: '传给 Go Core 的客户端 key',
  AIH_GO_CORE_MANAGEMENT_KEY: '传给 Go Core 的管理 key',
  AIH_CLAUDE_USAGE_PROBE: 'claude 用量探测上下文（token/baseUrl）',
  AIH_GEMINI_USAGE_PROBE: 'gemini 用量探测上下文（token/projectId）',
  AIH_CLAUDE_CREDENTIAL_TYPE: 'claude 凭据类型标记（oauth / api-key），透传给 CLI',
  AIH_CODEX_LOCAL_REMOTE_TOKEN: '本地 codex app-server 远程控制 token',

  // ── tuning：可调参数（51）───────────────────────────────────────

  // ── flag：开关与逃生门（8）─────────────────────────────────────
  AIH_GO_CORE_ENABLED: '启用 Go Core 数据面（config 优先）',
  AIH_TRACE: '统一调试开关：=1 全开，或逗号分隔 scope（agy-warm/models/model-chain/plugin/persist/artifact-hook/claude）',
  AIH_LAUNCH_CONTEXT: '单文件启动上下文：父进程写 0600 JSON，子进程只收文件路径（取代一批零散 AIH_* 上下文字段）',
  AIH_NO_PERSIST: '交互式逃生门：=1 时不套 tmux（公开）',

  // ── test：测试 / 探针（2）───────────────────────────────────────

  // ── plumbing：内部传递的身份 / 标记（153）───────────────────────
  AIH_AGY_USAGE: 'agy 用量上下文（baseUrl/quotaBaseUrls/clientVersion）',
  AIH_CODEX_GATEWAY_ACCOUNT_REF: '网关请求钉选的账号（x-account-ref 来源）',
  AIH_PROVIDER_ACCOUNT_REF: '当前运行账号的 accountRef（沙箱注入）',
  AIH_PROVIDER_EXTENSION_DIRS: '外部 provider 扩展目录（defs/quota 两项合一）',
  AIH_CODEX_BIN: 'codex 可执行文件路径',

  AIH_EDGE_CONTEXT: '边缘代理配置位置（caddyfile/nginxConfDir/frpcConfig 三项合一）',
  AIH_GO_CORE_ACCOUNT_SYNC: 'Go Core 账号同步开关',
  AIH_GO_CORE_BIND: 'Go Core 子进程监听地址与端口（host/port 两项合一）',
  AIH_GO_CORE_BINARY: 'Go Core 二进制路径',
  AIH_GO_CORE_DELEGATE_REFRESH: '由 Go Core 代办 token 刷新',
  AIH_GO_CORE_ROUTES: '由 Go 承接的路由条目（config 优先）',
  AIH_OPENCODE_GATEWAY: 'opencode 网关连接（baseUrl/apiKey 两项合一）',
  AIH_SERVER_RESTART: '服务重启上下文（mode/sourceAuto 两项合一）',
  AIH_SERVER_UPSTREAM_ERROR_RULES: '由 Go 承接错误规则的 provider 列表（config 优先）',
  AIH_UPSTREAM_ERROR_GROUP_IDS: '账号适用的错误规则分组 id',
  AIH_UPSTREAM_ERROR_RULES: '账号自定义上游错误规则（JSON）',
  AIH_ZCODE_CONTEXT: 'ZCode 运行时上下文（scope/验证码状态/用量日志 三项合一）',
  AIH_ACCOUNT_APP: '⚠ 账号所属客户端标记（codex app / cli；待确认取值）',
  AIH_CODEX_APP_SERVER_PASSTHROUGH: 'codex app-server 透传标记',
  AIH_CODEX_FLAGS: 'codex 启动/恢复开关（authPreflight/autoSkipRepoCheck/disableRemoteResume 三项合一）',
  AIH_IMAGE_API: '⚠ 上游图像 API 选择标记（账号 env 透传；待确认取值）',
  AIH_MULTIPLEXER: '复用器选择 auto/tmux/herdr/off（公开；off = 关闭复用器直接跑）',
  AIH_RUNTIME_MARKER: '持久会话运行时兼容标记（utf8/claude/psmux/supervisor 四项合一）',
  AIH_SESSION_INTENT: '会话意图（label/resume/mirror/target/active/detached 六项合一）',
  AIH_RELAY_SETTINGS: '中转运行参数（udp/播报地址/端口/端口模式/绑定网卡 五项合一）',
  AIH_UPSTREAM_HEADERS: '上游附加请求头（JSON）',
};

module.exports = { ENV_MEANINGS };
