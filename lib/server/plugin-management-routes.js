'use strict';

// /v0/plugins/*：插件的安装、启停、诊断与调试调用。
//
// 安装插件等于以服务端用户身份执行任意代码，所以这里只认管理密钥（authorizeManagementKey），
// 不走 /v0/management 那种「没配密钥时本机免密」的放行；没配管理密钥一律 503。

const fs = require('node:fs');
const path = require('node:path');
const { authorizeManagementKey } = require('./management-key-auth');
const { proxyWebuiGo } = require('./webui-go-proxy');

const PREFIX = '/v0/plugins';
const MAX_BODY_BYTES = 256 * 1024;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.code = 'plugin_request_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_error) {
    const error = new Error('请求体不是合法 JSON');
    error.code = 'plugin_request_invalid';
    throw error;
  }
}

function writeError(writeJson, res, error) {
  const code = error?.code || 'plugin_error';
  const status = code === 'plugin_runtime_unavailable' || code === 'plugin_runtime_inactive' ? 503
    : code === 'plugin_revision_conflict' || code === 'plugin_in_use' || code === 'plugin_version_conflict' ? 409
      : code === 'plugin_not_installed' || code === 'plugin_instance_unknown' ? 404
        : 400;
  writeJson(res, status, { ok: false, error: code, message: String(error?.message || code), diagnostics: error?.diagnostics || [] });
}

// Browser inventory is served directly by Go at /v0/plugins.
// Remaining plugin operations below keep their existing transport contracts.
const GO_CORE_UNAVAILABLE = 'go_core_unavailable';

/**
 * 把信任根的请求转给 Go，并把 Go 的状态码与响应体原样回给调用方。
 *
 * 为什么不在 Node 再映射一次错误：信任根只有「参数不对 / 存储损坏」两类领域错误，
 * Go 已按 Node writeError 的语义给出 400 + 错误码；再映射一遍只会让两边分叉。
 * 只有拿不到 HTTP 响应（status 0 / 抛错）才收敛成 503——那是 Go 没接住，不是请求有错。
 *
 * @returns {Promise<object|null>} 成功时的响应体，供 trust/untrust 写审计；失败为 null
 */
async function callGoTrustRoute({ writeJson, res, deps, method, args = [] }) {
  const goHost = deps.goCoreSync;
  const unavailable = () => writeJson(res, 503, {
    ok: false,
    error: GO_CORE_UNAVAILABLE,
    message: 'Go Core 未就绪，插件信任根不可用'
  });
  if (!goHost || typeof goHost[method] !== 'function') {
    unavailable();
    return null;
  }
  let response = null;
  try {
    response = await goHost[method](...args);
  } catch (_error) {
    response = null;
  }
  // status 0 = 传输失败；Go 自己的错误一定有 HTTP 状态码，必须原样透传。
  if (!response || !response.status) {
    unavailable();
    return null;
  }
  const body = response.body && typeof response.body === 'object' ? response.body : response.data;
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : { ok: response.ok === true };
  writeJson(res, response.status, payload);
  return response.ok === true ? payload : null;
}

/**
 * 把安装/卸载/启停转发给 Go，并把 Go 的状态码与响应体原样回给调用方。
 *
 * 不在 Node 重做错误归类：Go 已按 Node writeError 的语义给出 400/404/409/503，
 * 再映射一遍只会让两边分叉。只有拿不到 HTTP 响应（status 0 / 抛错）才收敛成 503。
 */
async function callGoPluginAction({ writeJson, res, deps, method, args = [], message }) {
  const goHost = deps.goCoreSync;
  const unavailable = () => writeJson(res, 503, {
    ok: false,
    error: GO_CORE_UNAVAILABLE,
    message
  });
  if (!goHost || typeof goHost[method] !== 'function') {
    unavailable();
    return null;
  }
  let response = null;
  try {
    response = await goHost[method](...args);
  } catch (_error) {
    response = null;
  }
  // status 0 = 传输失败；Go 自己的错误一定有 HTTP 状态码，必须原样透传。
  if (!response || !response.status) {
    unavailable();
    return null;
  }
  const body = response.body && typeof response.body === 'object' ? response.body : response.data;
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : { ok: response.ok === true };
  writeJson(res, response.status, payload);
  return response.ok === true ? payload : null;
}

/**
 * @returns {Promise<boolean>} 是否处理了该请求
 */
async function handlePluginManagementRequest(ctx) {
  const { method, pathname, req, res, requiredManagementKey, deps = {} } = ctx;
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
  const { writeJson, parseAuthorizationBearer } = deps;
  const authorization = authorizeManagementKey({ req, requiredManagementKey, deps: { parseAuthorizationBearer } });
  if (!authorization.ok) {
    writeJson(res, authorization.statusCode, { ok: false, error: authorization.error });
    return true;
  }
  // 信任根固定读 Go：Node 不再自己读文件，Go 未就绪直接 503（无回退）。
  if (method === 'GET' && pathname === `${PREFIX}/trusted`) {
    await callGoTrustRoute({ writeJson, res, deps, method: 'getPluginTrustedKeys' });
    return true;
  }
  const proxyCtx = ctx.writeJson ? ctx : { ...ctx, writeJson };
  if (method === 'GET' && pathname === `${PREFIX}/pricing/sources`) {
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: '/v1/management/webui/pricing/sources',
      message: 'Go Core 未就绪，价格源目录不可读'
    });
  }
  if (method === 'GET' && pathname === `${PREFIX}/pricing/reviews`) {
    const status = new URL(req.url || '/', 'http://localhost').searchParams.get('status') || '';
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: '/v1/management/webui/pricing/reviews',
      query: status ? `status=${encodeURIComponent(status)}` : '',
      message: 'Go Core 未就绪，价格复核队列不可读'
    });
  }
  if (method === 'GET' && pathname === `${PREFIX}/pricing/status`) {
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: '/v1/management/webui/pricing/status',
      message: 'Go Core 未就绪，价格状态不可读'
    });
  }
  const notifyPricingChanged = async () => {
    if (typeof deps.pricingChanged === 'function') return deps.pricingChanged();
    if (deps.modelUsageService && typeof deps.modelUsageService.syncPricingIfStale === 'function') {
      return deps.modelUsageService.syncPricingIfStale({ force: true, recalculateCosts: true });
    }
    return null;
  };
  try {
    if (method === 'GET' && pathname === `${PREFIX}/doctor`) {
      return proxyWebuiGo(proxyCtx, {
        method: 'GET',
        path: '/v1/management/webui/plugins/doctor',
        passStatuses: [400, 404, 409, 503],
        message: 'Go Core 未就绪，插件诊断不可用'
      });
    }
    if (method === 'POST' && pathname === `${PREFIX}/demo`) {
      writeJson(res, 410, { ok: false, error: 'plugin_demo_removed', message: '演示插件已移除，请使用正式插件' });
      return true;
    }
    if (method === 'GET' && pathname === `${PREFIX}/accounts/sources`) {
      const provider = new URL(req.url || '/', 'http://localhost').searchParams.get('provider') || '';
      return proxyWebuiGo(proxyCtx, {
        method: 'GET',
        path: '/v1/management/webui/plugins/accounts/sources',
        query: provider ? `provider=${encodeURIComponent(provider)}` : '',
        passStatuses: [400, 404, 409, 503],
        message: 'Go Core 未就绪，账号插件来源不可读'
      });
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    const body = await readJson(req);
    if (pathname === `${PREFIX}/pricing/refresh`) {
      const sourceId = String(body.sourceId || '').trim();
      const goBody = sourceId
        ? { sourceId }
        : (Number(body.timeoutMs) > 0 ? { timeoutMs: Number(body.timeoutMs) } : {});
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/plugins/pricing/refresh',
        body: goBody,
        passStatuses: [400, 404, 409, 502, 503],
        message: 'Go Core 未就绪，价格刷新不可用',
        transform: async (data) => {
          const applied = sourceId
            ? Boolean(data && data.applied === true)
            : Boolean(data && data.pluginRun && Array.isArray(data.pluginRun.sources) && data.pluginRun.sources.some((item) => item && item.applied === true));
          if (applied) await notifyPricingChanged();
          return data;
        }
      });
    }
    if (pathname === `${PREFIX}/pricing/quote`) {
      const provider = String(body.provider || '').trim().toLowerCase();
      const model = String(body.model || '').trim();
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/plugins/pricing/quote',
        body: {
          provider,
          model,
          accountRef: String(body.accountRef || '').trim(),
          ...(Number(body.timeoutMs) > 0 ? { timeoutMs: Number(body.timeoutMs) } : {})
        },
        passStatuses: [400, 404, 409, 502, 503],
        message: 'Go Core 未就绪，报价合并不可用'
      });
    }
    if (pathname === `${PREFIX}/pricing/approve`) {
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/pricing/approve',
        body: { sourceId: String(body.sourceId || '') },
        message: 'Go Core 未就绪，价格复核批准不可用',
        transform: async (data) => {
          await notifyPricingChanged();
          return data;
        }
      });
    }
    if (pathname === `${PREFIX}/pricing/reject`) {
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/pricing/reject',
        body: { sourceId: String(body.sourceId || '') },
        message: 'Go Core 未就绪，价格复核拒绝不可用',
        transform: async (data) => {
          await notifyPricingChanged();
          return data;
        }
      });
    }
    if (pathname === `${PREFIX}/accounts/import`) {
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/plugins/accounts/import',
        body,
        passStatuses: [400, 404, 409, 503],
        message: 'Go Core 未就绪，插件账号导入不可用'
      });
    }
    if (pathname === `${PREFIX}/accounts/refresh`) {
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/plugins/accounts/refresh',
        body,
        passStatuses: [400, 404, 409, 503],
        message: 'Go Core 未就绪，插件账号刷新不可用'
      });
    }
    if (pathname === `${PREFIX}/accounts/materialize`) {
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/plugins/accounts/materialize',
        body,
        passStatuses: [400, 404, 409, 503],
        message: 'Go Core 未就绪，插件凭据物化不可用'
      });
    }
    if (pathname === `${PREFIX}/install`) {
      // 安装与审计写面已完全收敛到 Go：file 在 Node 先 resolve 成绝对路径——Go 进程的 cwd 与 Node 不一定相同。
      await callGoPluginAction({
        writeJson,
        res,
        deps,
        method: 'installPlugin',
        args: [{ file: path.resolve(String(body.file || '')), requireSigned: body.requireSigned === true }],
        message: 'Go Core 未就绪，插件安装不可用'
      });
      return true;
    }
    if (pathname === `${PREFIX}/uninstall`) {
      await callGoPluginAction({
        writeJson,
        res,
        deps,
        method: 'uninstallPlugin',
        args: [{
          pluginId: body.pluginId,
          version: body.version,
          expectedRevision: body.expectedRevision
        }],
        message: 'Go Core 未就绪，插件卸载不可用'
      });
      return true;
    }
    if (pathname === `${PREFIX}/enable`) {
      // 启停入口已切 Go：Node 只做参数兜底与转发，绝不在本地构建候选或写状态。
      const instanceId = String(body.instanceId || body.pluginId || '').trim();
      if (!instanceId) {
        writeJson(res, 400, { ok: false, error: 'plugin_id_required' });
        return true;
      }
      await callGoPluginAction({
        writeJson, res, deps, method: 'enablePlugin', args: [instanceId, body], message: 'Go Core 未就绪，插件启用不可用'
      });
      return true;
    }
    if (pathname === `${PREFIX}/disable`) {
      const instanceId = String(body.instanceId || '').trim();
      if (!instanceId) {
        writeJson(res, 404, { ok: false, error: 'plugin_instance_unknown', message: `没有实例 ${instanceId}` });
        return true;
      }
      await callGoPluginAction({
        writeJson, res, deps, method: 'disablePlugin', args: [instanceId, body], message: 'Go Core 未就绪，插件停用不可用'
      });
      return true;
    }
    if (pathname === `${PREFIX}/trust`) {
      // body.file 的读取留在 Node：Go 不接服务器本地路径，只接 PEM 内容；审计在 Go 落盘。
      const publicKey = body.publicKey || (body.file ? fs.readFileSync(String(body.file), 'utf8') : '');
      await callGoTrustRoute({
        writeJson,
        res,
        deps,
        method: 'addPluginTrustedKey',
        args: [{ publicKey, keyId: body.keyId }]
      });
      return true;
    }
    if (pathname === `${PREFIX}/untrust`) {
      await callGoTrustRoute({
        writeJson,
        res,
        deps,
        method: 'removePluginTrustedKey',
        args: [body.keyId]
      });
      return true;
    }
    if (pathname === `${PREFIX}/invoke`) {
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/plugins/invoke',
        body: {
          contributionId: String(body.contributionId || ''),
          value: body.value,
          ...(Number(body.timeoutMs) > 0 ? { timeoutMs: Number(body.timeoutMs) } : {})
        },
        passStatuses: [400, 404, 409, 503],
        message: 'Go Core 未就绪，插件调用不可用'
      });
    }
    writeJson(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    writeError(writeJson, res, error);
  }
  return true;
}

module.exports = { handlePluginManagementRequest, PLUGIN_ROUTE_PREFIX: PREFIX };
