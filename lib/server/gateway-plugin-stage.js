'use strict';

// 网关请求路径与插件网关阶段（gateway.request、gateway.account）之间的接缝。
//
// 热路径：没有插件系统、没有活跃代次或该代次没有任何网关类贡献项时立即返回（不取租约、
// 不做序列化、不发 RPC）。有贡献项时：在 v1-router 里取租约固定代次（请求结束时释放），
// 先跑 gateway.request 改写/拒绝请求，再由两个选号循环在首次选号前跑 gateway.account 拿偏好顺序；
// 插件拒绝或失败（deny）时直接写错误响应。

const { peekPluginSystem } = require('../plugins/control/plugin-system');
const { CAPABILITY, runRequestStage } = require('../plugins/gateway/request-stage');
const { CAPABILITY: ACCOUNT_CAPABILITY, runAccountStage } = require('../plugins/gateway/account-stage');
const { runAttemptStage } = require('../plugins/gateway/attempt-stage');

const OBSERVE_CAPABILITY = 'observe';
const ATTEMPT_CAPABILITY = 'gateway.attempt';
// 任何一种出现在活跃代次里，请求都要取租约固定代次，Go 路由也要交回 Node。
const GATEWAY_CAPABILITIES = Object.freeze([CAPABILITY, ACCOUNT_CAPABILITY, OBSERVE_CAPABILITY, ATTEMPT_CAPABILITY]);

function hasGatewayContributions(system) {
  return GATEWAY_CAPABILITIES.some((capability) => system.runtime.hasContributions(capability));
}

function writePluginError(res, writeJson, status, code, message) {
  writeJson(res, status, { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code } });
}

/**
 * @returns {Promise<{ handled: boolean, requestJson?: object, bodyBuffer?: Buffer, generation?: number }>}
 *   handled=true 表示已写出响应（被拒绝或失败），调用方直接结束。
 */
async function applyGatewayRequestPlugins({ state, res, pathname, clientProtocol, requestJson, writeJson, requestMeta }) {
  const system = peekPluginSystem(state);
  if (!system || !hasGatewayContributions(system)) return { handled: false };
  if (!requestJson || typeof requestJson !== 'object' || Array.isArray(requestJson)) return { handled: false };
  const lease = system.runtime.acquire();
  if (!lease) return { handled: false };
  // 代次固定到请求结束：流式响应结束、客户端断开都会触发 close。后续阶段（选号）经 requestMeta 拿同一个租约。
  res.once('close', () => lease.release());
  if (requestMeta) {
    requestMeta.pluginGeneration = lease.generation;
    requestMeta.pluginLease = lease;
    requestMeta.pluginRuntime = system.runtime;
  }
  if (!(lease.snapshot.byCapability.get(CAPABILITY) || []).length) return { handled: false, generation: lease.generation };
  let outcome;
  try {
    outcome = await runRequestStage(system.runtime, lease, { protocol: clientProtocol, path: pathname, body: requestJson });
  } catch (error) {
    writePluginError(res, writeJson, 502, error.code || 'plugin_failed', String(error.message || 'plugin failed'));
    return { handled: true, generation: lease.generation };
  }
  if (outcome.reject) {
    writePluginError(res, writeJson, outcome.reject.status, 'plugin_rejected', outcome.reject.message);
    return { handled: true, generation: lease.generation };
  }
  if (!outcome.changed) return { handled: false, generation: lease.generation };
  return {
    handled: false,
    generation: lease.generation,
    requestJson: outcome.body,
    bodyBuffer: Buffer.from(JSON.stringify(outcome.body))
  };
}

/**
 * 首次选号之前调用：按请求固定的代次运行 gateway.account，返回有序偏好。
 * 没有租约或没有账号策略插件时立即返回空偏好；插件失败（deny）时写出错误响应。
 * @returns {Promise<{ handled: boolean, preferredAccountRefs: string[] }>}
 */
async function resolvePluginAccountPreference({ requestMeta, pool, provider, model, res, writeJson }) {
  const lease = requestMeta && requestMeta.pluginLease;
  if (!lease || !(lease.snapshot.byCapability.get(ACCOUNT_CAPABILITY) || []).length) return { handled: false, preferredAccountRefs: [] };
  try {
    const preferredAccountRefs = await runAccountStage(requestMeta.pluginRuntime, lease, { provider, model, candidates: pool });
    if (requestMeta) requestMeta.pluginAccountPreference = preferredAccountRefs;
    return { handled: false, preferredAccountRefs };
  } catch (error) {
    if (res && !res.headersSent && typeof writeJson === 'function') {
      writePluginError(res, writeJson, 502, error.code || 'plugin_failed', String(error.message || 'plugin failed'));
    }
    return { handled: true, preferredAccountRefs: [] };
  }
}

// Go 承接的路由在网关类插件活跃时交回 Node：Go 侧还没有插件端口，交回 Node 才能保证
// 同一个请求无论入口都经过同一代插件。
function shouldDeferToNodeForPlugins(state) {
  const system = peekPluginSystem(state);
  return Boolean(system && hasGatewayContributions(system));
}

/**
 * 两个选号循环各自调用：返回每次尝试结束后的观察回调（没有 observe 贡献项时返回 null）。
 * 事件只含低敏字段，不含请求体、回复体或凭据；投递异步、有界，不影响请求。
 */
function createAttemptObserver({ requestMeta, provider, model, res }) {
  const lease = requestMeta && requestMeta.pluginLease;
  if (!lease || !(lease.snapshot.byCapability.get(OBSERVE_CAPABILITY) || []).length) return null;
  const runtime = requestMeta.pluginRuntime;
  return (summary) => runtime.observe(lease, {
    type: 'gateway.attempt',
    generation: lease.generation,
    provider: String(provider || ''),
    model: String(model || ''),
    attempt: summary.attempt,
    accountRef: summary.accountRef,
    outcome: summary.outcome,
    error: summary.error,
    durationMs: summary.durationMs,
    committed: Boolean(res && (res.headersSent || res.writableEnded))
  });
}

// 提交点：响应头写给客户端的那一刻（write/end/flushHeaders 隐式写头也经过 writeHead）。
// 每个响应只包一次，多次尝试共用，避免重试叠加包装。
const commitTrackers = new WeakMap();
function commitTracker(res) {
  let tracker = commitTrackers.get(res);
  if (tracker) return tracker;
  const listeners = new Set();
  const writeHead = res.writeHead;
  res.writeHead = function trackedWriteHead(...args) {
    const result = writeHead.apply(this, args);
    for (const listener of [...listeners]) listener(res.statusCode);
    return result;
  };
  tracker = {
    committed: () => Boolean(res.headersSent),
    onCommit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  commitTrackers.set(res, tracker);
  return tracker;
}

/**
 * 两个选号循环各自调用：返回包在每次尝试外面的 gateway.attempt 中间件（没有该贡献项时返回 null）。
 * 返回的 outcome 交给 request-orchestrator：插件拒绝时已写出错误响应并按 return 结束；
 * 插件要求停止换号时带 pluginStop，按尝试耗尽结束。
 */
function createAttemptMiddleware({ requestMeta, provider, model, res, writeJson }) {
  const lease = requestMeta && requestMeta.pluginLease;
  if (!lease || !(lease.snapshot.byCapability.get(ATTEMPT_CAPABILITY) || []).length || !res) return null;
  const runtime = requestMeta.pluginRuntime;
  const commit = commitTracker(res);
  const disconnect = new AbortController();
  res.once('close', () => { if (!res.writableFinished) disconnect.abort(); });
  return async (account, info, runAttempt) => {
    const stage = await runAttemptStage(runtime, lease, {
      attempt: {
        provider: String(provider || ''),
        model: String(model || ''),
        attempt: info.attempt,
        accountRef: String(account && account.accountRef || ''),
        authType: account && (account.apiKeyMode || account.authType === 'api-key') ? 'api-key' : String(account && account.authType || 'oauth')
      },
      runAttempt,
      commit,
      lastError: info.lastError,
      signal: disconnect.signal
    });
    for (const failure of stage.failures) runtime.recordFailure({ capability: ATTEMPT_CAPABILITY, ...failure });
    if (!stage.started) {
      const rejected = stage.rejected;
      if (!res.headersSent && typeof writeJson === 'function') {
        if (rejected.code) writePluginError(res, writeJson, rejected.status, rejected.code, rejected.message);
        else writePluginError(res, writeJson, rejected.status, 'plugin_rejected', rejected.message);
      }
      return { action: 'return', pluginRejected: true };
    }
    return stage.stop ? { ...stage.outcome, pluginStop: true } : stage.outcome;
  };
}

// Responses WebSocket 桥还没有按 response.create 接入插件阶段。会改变请求行为的网关插件
// （request / account / attempt）活跃时拒绝升级并回 426：codex 遇到 426 会在本会话内回落 HTTPS
// （插件阶段齐全），而不是让 WS 静默绕过插件。只有 observe 时不拒绝，WS 尝试只是缺少观察事件。
const WEBSOCKET_BLOCKING_CAPABILITIES = Object.freeze([CAPABILITY, ACCOUNT_CAPABILITY, ATTEMPT_CAPABILITY]);
function rejectWebSocketForGatewayPlugins(state, socket) {
  const system = peekPluginSystem(state);
  if (!system || !WEBSOCKET_BLOCKING_CAPABILITIES.some((capability) => system.runtime.hasContributions(capability))) return false;
  if (!socket.destroyed) {
    const body = JSON.stringify({ ok: false, error: 'plugin_websocket_unsupported', message: '网关插件活跃时 Responses WebSocket 暂不可用，请改用 HTTPS' });
    socket.end(`HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  }
  return true;
}

// 当前活跃代次的快照（没有插件系统或没有活跃代次时为 null），供目录合并使用。
function currentPluginSnapshot(state) {
  const system = peekPluginSystem(state);
  const snapshot = system ? system.runtime.snapshot() : null;
  return snapshot && snapshot.generation ? snapshot : null;
}

module.exports = {
  applyGatewayRequestPlugins,
  createAttemptMiddleware,
  createAttemptObserver,
  currentPluginSnapshot,
  rejectWebSocketForGatewayPlugins,
  resolvePluginAccountPreference,
  shouldDeferToNodeForPlugins
};
