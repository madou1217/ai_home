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

function buildSessionMessages(hostHome, sessionRef, limit) {
  const session = listChatSessions(hostHome).find((item) => String(item.id) === String(sessionRef));
  if (!session) return null;
  const messages = (Array.isArray(session.messages) ? session.messages : [])
    .map((message) => ({
      role: message && (message.role === 'assistant' || message.role === 'user') ? message.role : null,
      content: String(message && message.content || ''),
      timestamp: Number(message && message.timestamp) || 0
    }))
    .filter((message) => message.role && message.content);
  const capped = limit > 0 ? messages.slice(-limit) : messages;
  return {
    session: {
      sessionRef: String(session.id),
      projectRef: String(session.project || session.cwd || 'local'),
      provider: String(session.provider || ''),
      title: String(session.title || ''),
      projectName: path.basename(String(session.project || session.cwd || 'local')),
      status: 'idle',
      updatedAt: Number(session.updatedAt) || 0,
      startedAt: Number(session.createdAt) || 0
    },
    messages: capped,
    summary: {
      total: messages.length,
      returned: capped.length,
      truncated: capped.length < messages.length,
      cursor: 0
    }
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
    const result = buildSessionMessages(hostHome, sessionRef, limit);
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
    const result = buildSessionMessages(hostHome, sessionRef, limit);
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
  deriveDeviceId,
  buildDeviceStatus,
  buildDeviceAccounts,
  buildDeviceSessions
};
