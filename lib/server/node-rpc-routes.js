'use strict';

// /v0/node-rpc/*：控制面（Desktop / 远程面板）读取本机事实的只读接口。
//
// 为什么单独一组路由而不是塞进 /v0/management：这组接口是「设备视角」的聚合
// （状态 / 节点 / 账号 / 会话 / 会话消息），控制面用同一套形状描述多台机器；
// 管理接口是「网关视角」，字段口径不同。共用的是鉴权：都需要 Management Key。
//
// 只读：这里没有任何写操作，所有数据都来自运行中的 state / 会话库。

const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { authorizeManagementKey } = require('./management-key-auth');
const { buildManagementStatusPayload } = require('./management');
const { listChatSessions } = require('./webui-chat-store');

const PREFIX = '/v0/node-rpc/';

function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

// deviceId 由主机名与数据目录派生：稳定、不可反查，不依赖任何落盘状态。
function deriveDeviceId(aiHomeDir) {
  const seed = String(os.hostname()) + '|' + String(aiHomeDir || '');
  return 'node-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

function queueTotals(queue) {
  const totals = { running: 0, queued: 0, totalScheduled: 0, totalRejected: 0 };
  Object.values(queue || {}).forEach((item) => {
    totals.running += Number(item && item.running) || 0;
    totals.queued += Number(item && item.queued) || 0;
    totals.totalScheduled += Number(item && item.totalScheduled) || 0;
    totals.totalRejected += Number(item && item.totalRejected) || 0;
  });
  return totals;
}

// buildDeviceStatus 把网关视角的状态映射成控制面视角。
function buildDeviceStatus(state, options, deps, nowMs) {
  const base = buildManagementStatusPayload(state, options, deps);
  return {
    ok: true,
    service: 'aih-control-plane',
    serverTime: new Date(nowMs).toISOString(),
    uptimeSec: base.uptimeSec,
    backend: base.backend,
    providerMode: base.providerMode,
    strategy: base.strategy,
    totalAccounts: base.totalAccounts,
    activeAccounts: base.activeAccounts,
    cooldownAccounts: base.cooldownAccounts,
    statusTotals: base.statusTotals,
    providers: base.providers,
    queue: base.queue,
    queueTotals: queueTotals(base.queue),
    modelsCached: base.modelsCached,
    modelsUpdatedAt: base.modelsUpdatedAt,
    modelRegistryUpdatedAt: base.modelRegistryUpdatedAt,
    successRate: base.successRate,
    timeoutRate: base.timeoutRate,
    totalRequests: base.totalRequests
  };
}

function buildDeviceNode(state, options, nowMs, aiHomeDir) {
  const id = deriveDeviceId(aiHomeDir);
  return {
    id,
    name: String(options && options.host === '0.0.0.0' ? os.hostname() : os.hostname()),
    role: 'server',
    endpointPolicy: 'direct',
    preferredTransports: ['http'],
    capabilities: ['device.status', 'device.accounts', 'device.sessions'],
    fingerprint: id,
    tags: [],
    disabled: false,
    lastSeenAt: nowMs,
    connection: { status: 'online', kind: 'http', lastError: '' },
    createdAt: Number(state && state.startedAt) || nowMs,
    updatedAt: nowMs,
    transports: []
  };
}

function buildDeviceAccounts(state, deps) {
  const accounts = [];
  const { accountStateIndex } = deps;
  const pools = state && state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
  Object.keys(pools).forEach((provider) => {
    const list = Array.isArray(pools[provider]) ? pools[provider] : [];
    list.forEach((account) => {
      const accountRef = String(account && account.accountRef || '').trim();
      if (!accountRef) return;
      const stateInfo = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
        ? accountStateIndex.getAccountState(accountRef)
        : null;
      accounts.push({
        accountRef,
        provider,
        label: String(account.label || account.email || account.phone || account.name || accountRef),
        status: account && account.enabled === false ? 'down' : 'up',
        authMode: account && account.apiKeyMode ? 'api-key' : 'oauth',
        planType: String(account && account.planType || ''),
        runtimeStatus: String(stateInfo && stateInfo.status || ''),
        quotaStatus: '',
        schedulableStatus: String(stateInfo && stateInfo.status || ''),
        remainingPct: typeof account.remainingPct === 'number' ? account.remainingPct : null,
        modelCooldownCount: 0,
        lastRefresh: Number(account && account.lastRefresh) || 0,
        successCount: Number(account && account.successCount) || 0,
        failCount: Number(account && account.failCount) || 0
      });
    });
  });
  const byProvider = {};
  const byRuntimeStatus = {};
  accounts.forEach((account) => {
    byProvider[account.provider] = (byProvider[account.provider] || 0) + 1;
    const key = account.runtimeStatus || 'unknown';
    byRuntimeStatus[key] = (byRuntimeStatus[key] || 0) + 1;
  });
  return {
    accounts,
    summary: {
      total: accounts.length,
      active: accounts.filter((account) => account.status === 'up').length,
      byProvider,
      byRuntimeStatus,
      bySchedulableStatus: { ...byRuntimeStatus }
    }
  };
}

// collectSessions 合并「运行时会话」与「落盘会话」，按更新时间倒序。
//
// 与 /v0/webui/chat-sessions 同源：只读落盘会话会漏掉正在跑的运行时会话
// （控制面看到的会话数会比界面少一大截）。
async function collectSessions(hostHome, runtime) {
  const stored = listChatSessions(hostHome);
  // listSessions 可能是同步返回也可能返回 Promise，两种都要接住。
  let runtimeRows = [];
  if (runtime && typeof runtime.listSessions === 'function') {
    try {
      runtimeRows = await runtime.listSessions({ chatOnly: true, limit: 500 });
    } catch (_error) {
      runtimeRows = [];
    }
  }
  if (!Array.isArray(runtimeRows)) runtimeRows = [];
  const merged = [
    ...runtimeRows.map((session) => ({
      id: session.sessionId,
      project: session.projectPath,
      provider: session.provider,
      title: session.policy && session.policy.title,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt || session.updatedAt
    })),
    ...stored
  ];
  return merged
    .map((session) => ({
      sessionRef: String(session.id || ''),
      projectRef: String(session.project || session.cwd || 'local'),
      provider: String(session.provider || ''),
      title: String(session.title || ''),
      projectName: path.basename(String(session.project || session.cwd || 'local')),
      status: 'idle',
      updatedAt: Number(session.updatedAt) || 0,
      startedAt: Number(session.createdAt) || 0
    }))
    .filter((session) => session.sessionRef)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

async function buildDeviceSessions(hostHome, runtime) {
  const sessions = await collectSessions(hostHome, runtime);
  const byProvider = {};
  const byStatus = {};
  const byProject = {};
  sessions.forEach((session) => {
    byProvider[session.provider || 'unknown'] = (byProvider[session.provider || 'unknown'] || 0) + 1;
    byStatus[session.status] = (byStatus[session.status] || 0) + 1;
    byProject[session.projectRef] = (byProject[session.projectRef] || 0) + 1;
  });
  return {
    sessions,
    summary: {
      total: sessions.length,
      returned: sessions.length,
      byProvider,
      byStatus,
      byProject,
      recentlyUpdatedAt: sessions.length > 0 ? sessions[0].updatedAt : 0
    }
  };
}

// resolveSession 先查运行时会话，再退回落盘会话。
//
// 运行时才是大多数（真机 32 条里绝大多数只存在于运行时），只查落盘会让
// 「会话列表里有、点进去 404」——控制面看到的正是这种自相矛盾。
function resolveSession(hostHome, runtime, sessionRef) {
  const wanted = String(sessionRef || '').trim();
  if (!wanted) return null;
  const store = runtime && runtime.store && typeof runtime.store.getSession === 'function'
    ? runtime.store
    : null;
  if (store) {
    try {
      const session = store.getSession(wanted);
      if (session) return session;
    } catch (_error) {
      // 运行时存储不可用时退回落盘会话。
    }
  }
  return listChatSessions(hostHome).find((item) => String(item.id) === String(wanted)) || null;
}

// readRuntimeTimeline 读运行时会话的消息时间线。
//
// 运行时会话不把消息挂在 session 对象上，而是事件流投影（store.readTimeline）。
// 只读 session.messages 会得到空数组——真机上就是这样「会话有、消息永远为空」。
function readRuntimeTimeline(runtime, sessionRef, limit) {
  const store = runtime && runtime.store;
  if (!store || typeof store.readTimeline !== 'function') return null;
  try {
    const page = store.readTimeline(sessionRef, { limit: limit > 0 ? Math.min(limit, 100) : 50 });
    return page && Array.isArray(page.items) ? page.items : null;
  } catch (_error) {
    return null;
  }
}

function sessionMessages(session) {
  const items = Array.isArray(session && session.messages)
    ? session.messages
    : (Array.isArray(session && session.items) ? session.items : []);
  return items;
}

// describeTimeline 输出条目的形状（键名与计数，不含正文）。
//
// 为什么需要它：时间线条目由上游事件投影而来，不同 Provider 的 kind/字段完全不同；
// 不看真实形状就只能靠猜，而猜错的表现是「消息永远为空」。
function describeTimeline(items) {
  const kinds = new Set();
  const keyShapes = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (item.kind) kinds.add(String(item.kind));
    keyShapes.add(Object.keys(item).sort().join(','));
  });
  return {
    itemCount: Array.isArray(items) ? items.length : 0,
    kinds: [...kinds],
    keyShapes: [...keyShapes].slice(0, 5)
  };
}

function buildSessionMessages(hostHome, runtime, sessionRef, limit, debug = false) {
  const session = resolveSession(hostHome, runtime, sessionRef);
  if (!session) return null;
  const timeline = readRuntimeTimeline(runtime, sessionRef, limit);
  // 不按 kind 过滤：时间线条目的 kind 由上游事件决定（不同 Provider 命名不同），
  // 只认「有 role 且 role 是 user/assistant」这一件事，否则换一个 Provider 就全空。
  const source = timeline || sessionMessages(session);
  const messages = source
    .map((item) => {
      const kind = String((item && item.kind) || '').toLowerCase();
      // 角色不在条目顶层，而在 detail.role（见 chat-session-coordinator 的投影）。
      const declared = String(
        (item && item.role) || (item && item.detail && item.detail.role) || ''
      ).toLowerCase();
      const role = declared === 'user' || declared === 'assistant'
        ? declared
        : (kind.includes('user') ? 'user' : (kind.includes('assistant') ? 'assistant' : null));
      return {
        role,
        content: String((item && (item.content || item.text)) || ''),
        timestamp: Number(item && (item.timestamp || item.at || item.createdAt)) || 0
      };
    })
    .filter((message) => message.role && message.content);
  const capped = limit > 0 ? messages.slice(-limit) : messages;
  return {
    session: {
      sessionRef: String(session.sessionId || session.id || sessionRef),
      projectRef: String(session.projectPath || session.project || session.cwd || 'local'),
      provider: String(session.provider || ''),
      title: String((session.policy && session.policy.title) || session.title || ''),
      projectName: path.basename(String(session.projectPath || session.project || session.cwd || 'local')),
      status: 'idle',
      updatedAt: Number(session.updatedAt) || 0,
      startedAt: Number(session.createdAt || session.updatedAt) || 0
    },
    messages: capped,
    summary: {
      total: messages.length,
      returned: capped.length,
      truncated: capped.length < messages.length,
      cursor: 0
    },
    // 只在 ?debug=1 时出现：用于核对上游条目的真实形状，不含正文。
    ...(debug ? { debug: describeTimeline(source) } : {})
  };
}

// handleNodeRpcRoutes 返回 true 表示请求已被本模块处理。
async function handleNodeRpcRoutes(ctx) {
  const pathname = String(ctx.pathname || '');
  if (!pathname.startsWith(PREFIX)) return false;
  const { method, req, res, state, deps = {} } = ctx;

  // 管理密钥在宿主里是「可轮换的取值函数」，不是静态字符串。
  const resolveKey = (value) => (typeof value === 'function' ? value() : value);
  const requiredKey = resolveKey(deps.managementKey)
    || resolveKey(deps.getManagementKey)
    || resolveKey(ctx.managementKey)
    || String(ctx.requiredManagementKey || '').trim();
  const auth = authorizeManagementKey({ req, requiredManagementKey: requiredKey, deps });
  if (!auth.ok) {
    writeJson(res, auth.statusCode || 401, { ok: false, error: auth.error || 'webui_unauthorized' });
    return true;
  }
  if (method !== 'GET') {
    writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  const nowMs = Date.now();
  const aiHomeDir = ctx.aiHomeDir || deps.aiHomeDir || '';
  const hostHome = ctx.hostHomeDir || deps.hostHomeDir || '';

  if (pathname === PREFIX + 'device-status') {
    writeJson(res, 200, {
      ok: true,
      rpc: 'control_plane.device.status',
      result: { status: buildDeviceStatus(state, ctx.options || {}, deps, nowMs) }
    });
    return true;
  }
  if (pathname === PREFIX + 'device-nodes') {
    writeJson(res, 200, {
      ok: true,
      rpc: 'control_plane.device.nodes',
      result: { nodes: [buildDeviceNode(state, ctx.options, nowMs, aiHomeDir)] }
    });
    return true;
  }
  if (pathname === PREFIX + 'device-accounts') {
    writeJson(res, 200, {
      ok: true,
      rpc: 'control_plane.device.accounts',
      result: buildDeviceAccounts(state, deps)
    });
    return true;
  }
  if (pathname === PREFIX + 'device-sessions') {
    writeJson(res, 200, {
      ok: true,
      rpc: 'control_plane.device.sessions',
      result: await buildDeviceSessions(hostHome, deps.chatRuntimeService)
    });
    return true;
  }
  if (pathname === PREFIX + 'device-node-sessions') {
    const nodeId = String((ctx.url && ctx.url.searchParams.get('nodeId')) || '').trim();
    if (nodeId && nodeId !== deriveDeviceId(aiHomeDir)) {
      writeJson(res, 200, {
        ok: true,
        rpc: 'control_plane.device.node_sessions',
        nodeId,
        result: { sessions: [], summary: { total: 0, returned: 0, byProvider: {}, byStatus: {}, byProject: {}, recentlyUpdatedAt: 0 } }
      });
      return true;
    }
    const result = await buildDeviceSessions(hostHome, deps.chatRuntimeService);
    writeJson(res, 200, { ok: true, rpc: 'control_plane.device.node_sessions', nodeId, result });
    return true;
  }
  if (pathname === PREFIX + 'device-session-messages') {
    const sessionRef = String((ctx.url && ctx.url.searchParams.get('sessionRef')) || '').trim();
    const limit = Number((ctx.url && ctx.url.searchParams.get('limit')) || 0) || 0;
    const debug = (ctx.url && ctx.url.searchParams.get('debug')) === '1';
    const result = buildSessionMessages(hostHome, deps.chatRuntimeService, sessionRef, limit, debug);
    if (!result) {
      writeJson(res, 404, { ok: false, error: 'session_not_found' });
      return true;
    }
    writeJson(res, 200, { ok: true, rpc: 'control_plane.device.session_messages', result });
    return true;
  }
  if (pathname === PREFIX + 'device-node-session-messages') {
    const nodeId = String((ctx.url && ctx.url.searchParams.get('nodeId')) || '').trim();
    const sessionRef = String((ctx.url && ctx.url.searchParams.get('sessionRef')) || '').trim();
    const limit = Number((ctx.url && ctx.url.searchParams.get('limit')) || 0) || 0;
    const debug = (ctx.url && ctx.url.searchParams.get('debug')) === '1';
    const result = buildSessionMessages(hostHome, deps.chatRuntimeService, sessionRef, limit, debug);
    if (!result) {
      writeJson(res, 404, { ok: false, error: 'session_not_found' });
      return true;
    }
    writeJson(res, 200, {
      ok: true,
      rpc: 'control_plane.device.node_session_messages',
      nodeId,
      result
    });
    return true;
  }

  writeJson(res, 404, { ok: false, error: 'rpc_not_found' });
  return true;
}

module.exports = {
  handleNodeRpcRoutes,
  buildSessionMessages,
  deriveDeviceId,
  buildDeviceStatus,
  buildDeviceAccounts,
  buildDeviceSessions
};
