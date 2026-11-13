'use strict';

// /v0/node-rpc/* 控制面只读接口的零回退 Go 代理。
// 全部状态、节点派生、账号聚合、会话合并与时间线消息投影均已迁至 Go
// (/v1/management/webui/node-rpc/*)。

const { authorizeManagementKey } = require('./management-key-auth');
const { proxyWebuiGo } = require('./webui-go-proxy');

const PREFIX = '/v0/node-rpc/';
const KNOWN_RPCS = new Set([
  'device-status',
  'device-nodes',
  'device-accounts',
  'device-sessions',
  'device-node-sessions',
  'device-session-messages',
  'device-node-session-messages'
]);

function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function handleNodeRpcRoutes(ctx) {
  const pathname = String((ctx && ctx.pathname) || '');
  if (!pathname.startsWith(PREFIX)) return false;

  const { method, req, res, deps = {} } = ctx;
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

  if (String(method || '').toUpperCase() !== 'GET') {
    writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  const op = pathname.slice(PREFIX.length);
  if (!KNOWN_RPCS.has(op)) {
    writeJson(res, 404, { ok: false, error: 'rpc_not_found' });
    return true;
  }

  const query = ctx && ctx.url && typeof ctx.url.search === 'string' ? ctx.url.search : '';
  // go-core-host.webuiRequest 拦截含 ".." 的 path；消息查询中不会存在合法 ".." sessionRef，直接返回 404。
  if (query.includes('..') && (op === 'device-session-messages' || op === 'device-node-session-messages')) {
    writeJson(res, 404, { ok: false, error: 'session_not_found' });
    return true;
  }

  const proxyCtx = ctx.writeJson
    ? ctx
    : { ...ctx, writeJson: (targetRes, status, payload) => writeJson(targetRes, status, payload) };

  return proxyWebuiGo(proxyCtx, {
    method: 'GET',
    path: `/v1/management/webui/node-rpc/${op}`,
    query,
    passStatuses: [400, 401, 404, 405, 409],
    message: 'Go Core 未就绪，无法执行设备 RPC 查询'
  });
}

module.exports = {
  handleNodeRpcRoutes
};
