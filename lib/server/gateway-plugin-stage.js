'use strict';

// v1-router 与插件 gateway.request 阶段之间的接缝。
//
// 热路径：没有插件系统、没有活跃代次或该代次没有 gateway.request 贡献项时立即返回（不取租约、
// 不做序列化、不发 RPC）。有贡献项时：取租约固定代次（请求结束时释放），运行插件链，
// 把结果写回请求 JSON 与上游请求体；插件拒绝或失败时直接写错误响应。

const { peekPluginSystem } = require('../plugins/control/plugin-system');
const { CAPABILITY, runRequestStage } = require('../plugins/gateway/request-stage');

function writePluginError(res, writeJson, status, code, message) {
  writeJson(res, status, { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code } });
}

/**
 * @returns {Promise<{ handled: boolean, requestJson?: object, bodyBuffer?: Buffer, generation?: number }>}
 *   handled=true 表示已写出响应（被拒绝或失败），调用方直接结束。
 */
async function applyGatewayRequestPlugins({ state, res, pathname, clientProtocol, requestJson, writeJson, requestMeta }) {
  const system = peekPluginSystem(state);
  if (!system || !system.runtime.hasContributions(CAPABILITY)) return { handled: false };
  if (!requestJson || typeof requestJson !== 'object' || Array.isArray(requestJson)) return { handled: false };
  const lease = system.runtime.acquire();
  if (!lease) return { handled: false };
  // 代次固定到请求结束：流式响应结束、客户端断开都会触发 close。
  res.once('close', () => lease.release());
  if (requestMeta) requestMeta.pluginGeneration = lease.generation;
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

// Go 承接的路由在网关请求类插件活跃时交回 Node：Go 侧还没有插件端口，交回 Node 才能保证
// 同一个请求无论入口都经过同一代插件。
function shouldDeferToNodeForPlugins(state) {
  const system = peekPluginSystem(state);
  return Boolean(system && system.runtime.hasContributions(CAPABILITY));
}

module.exports = { applyGatewayRequestPlugins, shouldDeferToNodeForPlugins };
