'use strict';

// WebUI 数据面：账号级「是否进入别名自动选号池」开关。
//
// 语义：全局别名命中某模型时，网关会按模型索引把账号拉进候选池。账号可以声明自己不参与
// 这类自动选号（participates: false），但仍可被显式钉选（x-account-ref）或手动选择使用。
// 持久化见 lib/account/alias-pool-store.js（app_kv account:alias-pool:<ref>）。
//
// 读写都固定走 Go：账号校验与 app_kv 写入在 Go 侧完成；Node 只在写成功后执行一次
// 运行池重载（请求热路径读的是内存池，不重载会继续按旧值选号）。

const { reloadRuntimeAccountsIfNeeded } = require('./webui-account-routes-utils');

const ALIAS_POOL_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/alias-pool$/;

function parseAliasPoolRoute(pathname) {
  const match = ALIAS_POOL_ROUTE_PATTERN.exec(String(pathname || ''));
  if (!match) return null;
  try {
    return {
      provider: decodeURIComponent(match[1]).trim().toLowerCase(),
      accountRef: decodeURIComponent(match[2]).trim()
    };
  } catch {
    return null;
  }
}

function matchAliasPoolRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return ALIAS_POOL_ROUTE_PATTERN.test(String(pathname || '')) && (verb === 'GET' || verb === 'POST');
}

function writeProxyFailure(ctx, response, message) {
  const status = Number(response && response.status) || 0;
  if ([400, 404, 409, 500].includes(status) && response && response.data) {
    ctx.writeJson(ctx.res, status, response.data);
    return;
  }
  ctx.writeJson(ctx.res, 503, {
    ok: false,
    error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
    message
  });
}

/**
 * GET  /v0/webui/accounts/:provider/:accountRef/alias-pool  读当前设置
 * POST /v0/webui/accounts/:provider/:accountRef/alias-pool  写入设置
 *
 * POST body: { participates: boolean }
 *
 * @returns {Promise<boolean>} 是否已处理该请求
 */
async function handleAliasPoolRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseAliasPoolRoute(pathname);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  const method = String(ctx.req && ctx.req.method || '').toUpperCase();

  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost) {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，别名池设置不可用' });
    return true;
  }

  if (method === 'GET') {
    if (typeof goHost.getAccountAliasPool !== 'function') {
      writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，别名池设置不可读' });
      return true;
    }
    let response = null;
    try {
      response = await goHost.getAccountAliasPool(provider, accountRef);
    } catch (_error) {
      response = null;
    }
    if (response && response.ok === true && response.data) {
      writeJson(ctx.res, 200, response.data);
      return true;
    }
    writeProxyFailure(ctx, response, 'Go Core 未就绪，别名池设置不可读');
    return true;
  }

  let payload;
  try {
    const body = await ctx.readRequestBody(ctx.req, { maxBytes: 16 * 1024 });
    payload = body ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }
  if (typeof payload.participates !== 'boolean') {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_participates' });
    return true;
  }

  let response = null;
  try {
    response = typeof goHost.setAccountAliasPool === 'function'
      ? await goHost.setAccountAliasPool(provider, accountRef, payload.participates)
      : null;
  } catch (_error) {
    response = null;
  }
  if (!response || response.ok !== true || !response.data) {
    writeProxyFailure(ctx, response, 'Go Core 未就绪，别名池设置不可写');
    return true;
  }

  // 运行池里注入的 participates 是请求热路径读的唯一来源：写完必须立即重载，
  // 否则开关看起来保存成功、路由仍按旧值选号。
  let reloaded = false;
  try {
    reloaded = reloadRuntimeAccountsIfNeeded(ctx) === true;
  } catch {
    reloaded = false;
  }

  writeJson(ctx.res, 200, { ...response.data, reloaded });
  return true;
}

module.exports = {
  ALIAS_POOL_ROUTE_PATTERN,
  handleAliasPoolRequest,
  matchAliasPoolRoute,
  parseAliasPoolRoute
};
