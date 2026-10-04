'use strict';

// /v0/plugins/*：插件的安装、启停、诊断与调试调用。
//
// 安装插件等于以服务端用户身份执行任意代码，所以这里只认管理密钥（authorizeManagementKey），
// 不走 /v0/management 那种「没配密钥时本机免密」的放行；没配管理密钥一律 503。

const { authorizeManagementKey } = require('./management-key-auth');
const { getPluginSystem } = require('../plugins/control/plugin-system');

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
  const { control, runtime } = getPluginSystem(ctx.state, { aiHomeDir: deps.aiHomeDir });
  try {
    if (method === 'GET' && pathname === PREFIX) {
      writeJson(res, 200, { ok: true, ...control.list(), runtime: runtime.status() });
      return true;
    }
    if (method === 'GET' && pathname === `${PREFIX}/doctor`) {
      const report = control.doctor();
      writeJson(res, 200, { ok: true, ...report, healthy: report.ok });
      return true;
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    const body = await readJson(req);
    let result;
    if (pathname === `${PREFIX}/install`) result = control.install(body.file);
    else if (pathname === `${PREFIX}/uninstall`) result = control.uninstall(body);
    else if (pathname === `${PREFIX}/enable`) result = await control.enable(body);
    else if (pathname === `${PREFIX}/disable`) result = await control.disable(body);
    else if (pathname === `${PREFIX}/invoke`) {
      const response = await runtime.invoke(String(body.contributionId || ''), body.value, { timeoutMs: Number(body.timeoutMs) || undefined });
      result = { value: response.value, payloadBytes: response.payload ? response.payload.length : 0 };
    } else {
      writeJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    }
    writeJson(res, 200, { ok: true, ...result });
  } catch (error) {
    writeError(writeJson, res, error);
  }
  return true;
}

module.exports = { handlePluginManagementRequest, PLUGIN_ROUTE_PREFIX: PREFIX };
