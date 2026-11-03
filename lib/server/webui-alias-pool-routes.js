'use strict';

// WebUI 数据面：账号级「是否进入别名自动选号池」开关。
//
// 语义：全局别名命中某模型时，网关会按模型索引把账号拉进候选池。账号可以声明自己不参与
// 这类自动选号（`participates: false`），但仍可被显式钉选（x-account-ref）或手动选择使用。
// 持久化见 lib/account/alias-pool-store.js（app_kv `account:alias-pool:<ref>`）。
//
// 与 /update 路由分开：那条路由针对凭据编辑，本路由只表达一个调度偏好。

const {
  readAliasPoolConfig,
  writeAliasPoolConfig
} = require('../account/alias-pool-store');
const { resolveAccountRef } = require('./account-ref-store');
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

function resolveAiHomeDir(ctx) {
  const processObj = (ctx && ctx.processObj) || process;
  const env = processObj.env || {};
  return String(
    (ctx && ctx.aiHomeDir)
    || (ctx && ctx.state && ctx.state.aiHomeDir)
    || env.AI_HOME_DIR
    || env.AIH_HOME_DIR
    || ''
  ).trim();
}

function presentSetting(config) {
  // 没有记录 = 默认参与；显式 false 才是退出。
  return { participates: !(config && config.participates === false) };
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
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 503, { ok: false, error: 'ai_home_dir_unavailable' });
    return true;
  }

  let account = null;
  try {
    account = resolveAccountRef(ctx.fs, aiHomeDir, accountRef, { bestEffort: true });
  } catch {
    account = null;
  }
  if (!account) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  if (String(account.provider || '').trim().toLowerCase() !== provider) {
    writeJson(ctx.res, 409, { ok: false, error: 'account_provider_mismatch' });
    return true;
  }

  const method = String(ctx.req && ctx.req.method || '').toUpperCase();
  if (method === 'GET') {
    let config;
    try {
      config = readAliasPoolConfig(ctx.fs, aiHomeDir, accountRef);
    } catch {
      writeJson(ctx.res, 500, { ok: false, error: 'alias_pool_read_failed' });
      return true;
    }
    writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountRef,
      setting: presentSetting(config)
    });
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

  try {
    writeAliasPoolConfig(ctx.fs, aiHomeDir, accountRef, { participates: payload.participates });
  } catch {
    writeJson(ctx.res, 500, { ok: false, error: 'alias_pool_write_failed' });
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

  writeJson(ctx.res, 200, {
    ok: true,
    provider,
    accountRef,
    setting: { participates: payload.participates },
    reloaded
  });
  return true;
}

module.exports = {
  ALIAS_POOL_ROUTE_PATTERN,
  handleAliasPoolRequest,
  matchAliasPoolRoute,
  parseAliasPoolRoute,
  presentSetting
};
