'use strict';

// WebUI 出口池面板的数据面：
//   GET  /v0/webui/egress-pool                       服务状态 + 节点账本（统计 / 冷却 / 探测 / 账号）+ 事件流 + 绑定了池的账号
//   POST /v0/webui/egress-pool/probe                 立即探测（body.node 为空 = 全部节点）
//   POST /v0/webui/egress-pool/nodes/:name/select    切到指定节点
//   POST /v0/webui/egress-pool/nodes/:name/clear-cooldown  人工解除冷却
// 鉴权由 webui-auth-gate 统一负责（Management Key）。节点凭据从不出现在响应里：账本只存
// 出口身份（协议 / 服务器 / 端口）与展示名。

const { describeEgressPool, runEgressPoolAction } = require('../runtime/egress-pool-registry');
const { listEgressPoolBoundAccounts } = require('../account/zcode-egress-binding-store');

const ROOT_PATH = '/v0/webui/egress-pool';
const NODE_ACTION_PATTERN = /^\/v0\/webui\/egress-pool\/nodes\/([^/]+)\/(select|clear-cooldown)$/;

function matchEgressPoolRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'GET' && path === ROOT_PATH) return true;
  if (verb === 'POST' && path === `${ROOT_PATH}/probe`) return true;
  return verb === 'POST' && NODE_ACTION_PATTERN.test(path);
}

function resolveDependency(ctx, name, fallback) {
  const injected = ctx && ctx.deps && ctx.deps[name];
  return typeof injected === 'function' ? injected : fallback;
}

function resolveAiHomeDir(ctx) {
  return String((ctx && ctx.aiHomeDir) || (ctx && ctx.deps && ctx.deps.aiHomeDir) || '').trim();
}

async function readJsonBody(ctx) {
  try {
    const body = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes: 4 * 1024 })
      : null;
    const parsed = body ? JSON.parse(body.toString('utf8')) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

async function handleEgressPoolRequest(ctx) {
  const { writeJson } = ctx;
  const method = String(ctx.method || (ctx.req && ctx.req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');
  const describe = resolveDependency(ctx, 'describeEgressPool', describeEgressPool);
  const runAction = resolveDependency(ctx, 'runEgressPoolAction', runEgressPoolAction);

  if (method === 'GET') {
    const view = describe();
    let boundAccounts = [];
    const listBound = resolveDependency(ctx, 'listEgressPoolBoundAccounts', listEgressPoolBoundAccounts);
    try {
      const aiHomeDir = resolveAiHomeDir(ctx);
      boundAccounts = aiHomeDir ? listBound(ctx.fs, aiHomeDir) : [];
    } catch {
      boundAccounts = [];
    }
    writeJson(ctx.res, 200, { ok: true, ...view, boundAccounts, serverTime: Date.now() });
    return true;
  }

  if (pathname === `${ROOT_PATH}/probe`) {
    const body = await readJsonBody(ctx);
    if (!body) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    const result = await runAction('probe', String(body.node || '').trim());
    writeJson(ctx.res, result.ok ? 200 : 409, result);
    return true;
  }

  const match = NODE_ACTION_PATTERN.exec(pathname);
  let node = '';
  try {
    node = decodeURIComponent(match[1]).trim();
  } catch {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_node_name' });
    return true;
  }
  const result = await runAction(match[2], node);
  writeJson(ctx.res, result.ok ? 200 : 409, result);
  return true;
}

module.exports = {
  handleEgressPoolRequest,
  matchEgressPoolRoute
};
