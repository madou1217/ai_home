'use strict';

// 审批传输策略表（Approval Transport Strategy Table）。
//
// 「confirm/plan 模式下，权限请求怎么到达用户、决策怎么回到 CLI」每个 provider 都不一样，
// 差异是**数据**，不是驱动里的 if/else：
//
//   claude   → 官方 --permission-prompt-tool(MCP)：权限工具 POST 回本机，
//              HTTP 响应长挂到用户决策（channel=http-callback，spawner=native-stream）
//   opencode → 常驻 `opencode serve`：SSE permission.asked → POST /permission/:id/reply
//              （channel=serve-permission，spawner=opencode-serve）
//   grok     → 只有 --permission-mode，确认点在交互式终端里：需要 terminal 通道，未接线
//   codex    → app-server JSON-RPC（canonical 已有专用驱动，不经过本表）
//
// 每一行声明：哪些 provider / 哪些审批模式 / 哪些账号类型 命中它，用哪个执行器（spawner id），
// 以及启动参数怎么拼（launch）。求值顺序 = 表顺序，第一个谓词全命中的行胜出；都不命中则
// fail closed（unsupported + 原因），绝不静默降级为无权限提示直跑。
//
// 新增 provider / 新增账号类型 = 加一行或改一行声明（+ 需要时换 spawner），派发代码不动。

// 注意：具体 CLI 参数拼装留在引擎（native-session-chat / claude-permission-mcp-tool），
// 本表只声明「哪条通道、哪个执行器、需要哪些上下文」，避免两处维护同一套 args。

// 账号类型词表：登录态（OAuth/宿主登录）与 API Key。与 web 侧 account-state 的口径一致。
const LOGIN_ACCOUNT = 'login';
const API_KEY_ACCOUNT = 'api-key';
const ALL_ACCOUNT_TYPES = Object.freeze([LOGIN_ACCOUNT, API_KEY_ACCOUNT]);

// spawner 词表（执行器 id）：驱动侧注册表按 id 取实现，表里不写函数。
const SPAWNER_NATIVE_STREAM = 'native-stream';
const SPAWNER_OPENCODE_SERVE = 'opencode-serve';

const APPROVAL_TRANSPORTS = Object.freeze([
  Object.freeze({
    id: 'claude-permission-prompt-tool',
    channel: 'http-callback',
    providers: Object.freeze(['claude']),
    modes: Object.freeze(['confirm', 'plan']),
    accountTypes: ALL_ACCOUNT_TYPES,
    spawner: SPAWNER_NATIVE_STREAM,
    // 引擎在 confirm/plan 下自己追加 --permission-mode + MCP 权限工具（args 拼装留在引擎，
    // 避免两处维护）；这里只把「回传端点 + 本次 run 身份」交给它，工具 POST 回来即进 canonical 审批面。
    launch: ({ approvalMode, approvalRequestUrl, runId }) => ({
      approvalMode,
      approvalRequestUrl,
      approvalRunId: runId
    })
  }),
  Object.freeze({
    id: 'opencode-serve-permission',
    channel: 'serve-permission',
    providers: Object.freeze(['opencode']),
    modes: Object.freeze(['confirm', 'plan']),
    accountTypes: ALL_ACCOUNT_TYPES,
    spawner: SPAWNER_OPENCODE_SERVE,
    // serve runner 已实现 permission.asked → 审批面 → POST /permission/:id/reply；
    // 这里只把 canonical 审批面注入给它（未注入时它仍走 legacy 审批桥，行为不变）。
    launch: ({ approvalSurface }) => ({ approvalSurface })
  }),
  Object.freeze({
    // ACP（Agent Client Protocol）：agent → client 的 session/request_permission 逐项往返，
    // 选项原样来自 agent（允许一次 / 本会话总是允许 / 拒绝）。新会话走 session/new、续聊走
    // session/load（同一会话，不 fork）。执行器仍是引擎 native-stream，acpApproval 让引擎改走
    // ACP 通道（见 native-session-chat 的 acpApprovalRun 与 acp-session-runner）。
    // 2026-10-31 真机：gemini 0.66 --acp 拿到 request_permission(kind=execute)，回 reject 后工具未执行；
    // cline 3.0.71 / codebuddy 握手 + session/new 通过（本机账号余额/登录态限制，未跑到工具轮）。
    // 家族推断行（codebuddycn / workbuddy / workbuddycn）沿用 acp-layouts 的 verified:false 证据。
    id: 'acp-request-permission',
    channel: 'acp-permission',
    providers: Object.freeze(['gemini', 'cline', 'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']),
    modes: Object.freeze(['confirm', 'plan']),
    accountTypes: ALL_ACCOUNT_TYPES,
    spawner: SPAWNER_NATIVE_STREAM,
    launch: ({ approvalMode, approvalSurface }) => ({ approvalMode, approvalSurface, acpApproval: true })
  }),
  Object.freeze({
    id: 'grok-terminal-prompt',
    channel: 'terminal-prompt',
    providers: Object.freeze(['grok']),
    modes: Object.freeze(['confirm', 'plan']),
    accountTypes: ALL_ACCOUNT_TYPES,
    spawner: null,
    unsupportedReason: 'native_session_terminal_approval_not_wired'
  })
]);

// 驱动侧执行器注册表：spawner id → 实现（由驱动模块注入，见 native-session-driver）。
function createApprovalSpawnerRegistry(implementations = {}) {
  const registry = new Map(Object.entries(implementations)
    .filter(([, implementation]) => typeof implementation === 'function'));
  return {
    has: (id) => registry.has(id),
    get: (id) => registry.get(id) || null,
    ids: () => [...registry.keys()]
  };
}

// 单个谓词求值：声明式名单（数组）命中即真；调用方未提供该维度时不过滤（不猜）。
function matchesDimension(declared, actual) {
  if (!Array.isArray(declared) || declared.length === 0) return true;
  const value = String(actual === undefined || actual === null ? '' : actual).trim().toLowerCase();
  if (!value) return true;
  return declared.includes(value);
}

function matchesRow(row, input) {
  return matchesDimension(row.providers, input.provider)
    && matchesDimension(row.modes, input.approvalMode)
    && matchesDimension(row.accountTypes, input.accountType);
}

function findApprovalTransport(input = {}) {
  const probe = {
    provider: String(input.provider || '').trim().toLowerCase(),
    approvalMode: String(input.approvalMode || '').trim().toLowerCase(),
    accountType: String(input.accountType || '').trim().toLowerCase()
  };
  return APPROVAL_TRANSPORTS.find((row) => matchesRow(row, probe)) || null;
}

/**
 * 解析一次审批回路。返回：
 *   { support: 'not_required' }                         —— bypass：不需要权限回路
 *   { support: 'native', transport, spawner, launch }   —— 有声明且执行器可用
 *   { support: 'unsupported', transport, reason }        —— 声明存在但通道未接线
 *   { support: 'unsupported', transport: null, reason: 'native_session_approval_transport_undeclared' }
 *
 * 注意：`spawner` 可用性由调用方用执行器注册表校验（resolver 不持有实现）。
 */
function resolveNativeApprovalTransport(input = {}) {
  if (String(input.approvalMode || '').trim().toLowerCase() === 'bypass'
    || !String(input.approvalMode || '').trim()) {
    return Object.freeze({ support: 'not_required' });
  }
  const transport = findApprovalTransport(input);
  if (!transport) {
    return Object.freeze({
      support: 'unsupported',
      transport: null,
      reason: 'native_session_approval_transport_undeclared'
    });
  }
  if (!transport.spawner) {
    return Object.freeze({
      support: 'unsupported',
      transport,
      reason: transport.unsupportedReason || 'native_session_approval_transport_not_wired'
    });
  }
  return Object.freeze({
    support: 'native',
    transport,
    spawner: transport.spawner,
    launch: transport.launch
  });
}

function listNativeApprovalTransports() {
  return APPROVAL_TRANSPORTS;
}

// 声明了审批通道的 provider 名单（就绪度守卫用：注册了原生驱动就必须有审批声明）。
function declaredApprovalProviders() {
  const providers = new Set();
  for (const row of APPROVAL_TRANSPORTS) {
    for (const provider of row.providers || []) providers.add(provider);
  }
  return [...providers].sort();
}

module.exports = {
  ALL_ACCOUNT_TYPES,
  API_KEY_ACCOUNT,
  LOGIN_ACCOUNT,
  SPAWNER_NATIVE_STREAM,
  SPAWNER_OPENCODE_SERVE,
  createApprovalSpawnerRegistry,
  declaredApprovalProviders,
  findApprovalTransport,
  listNativeApprovalTransports,
  resolveNativeApprovalTransport
};
