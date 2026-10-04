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

const GATEWAY_CAPABILITIES = Object.freeze([CAPABILITY, ACCOUNT_CAPABILITY]);

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

module.exports = { applyGatewayRequestPlugins, resolvePluginAccountPreference, shouldDeferToNodeForPlugins };
