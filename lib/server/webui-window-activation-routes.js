'use strict';

// WebUI 数据面：账号「窗口激活」开关与间隔的读写。
//
// 背景见 window-activation-scheduler.js：对 5h 滚动限额类账号定期发一个极小探测以
// 推进窗口。本路由只负责这一项账号级设置的 HTTP 边界：解析路径、校验入参、调 store、回 JSON。
// 持久化在 lib/account/window-activation-store.js（app_kv 键 account:window-activation:<ref>）。
//
// 与 /update 路由分开：那条路由针对凭据编辑，与「是否参与某个后台调度」不是一回事，
// 单独一条路由语义更干净（与 zcode 出口绑定同样的取舍，见 webui-zcode-egress-routes.js）。

const {
  readWindowActivationConfig,
  writeWindowActivationConfig
} = require('../account/window-activation-store');
const { listProbeProviders } = require('./window-activation/probe-specs');
const { resolveAccountRef } = require('./account-ref-store');

const WINDOW_ACTIVATION_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/window-activation$/;
// 间隔下限 1 分钟（与前端控件一致）；上限留一年，防手滑写成天文数字。
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

// 支持的 provider 以探测规格注册表为准（当前仅 codex），新增 spec 自动放开。
const SUPPORTED_PROVIDERS = new Set(listProbeProviders());

function parseWindowActivationRoute(pathname) {
  const match = WINDOW_ACTIVATION_ROUTE_PATTERN.exec(String(pathname || ''));
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

function resolveAiHomeDir(ctx) {
  const processObj = (ctx && ctx.processObj) || process;
  const env = processObj.env || {};
  return String(
    (ctx && ctx.aiHomeDir)
    || (ctx && ctx.state && ctx.state.aiHomeDir)
    || env.AI_HOME_DIR
    || env.AIH_HOME
    || ''
  ).trim();
}

function matchWindowActivationRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return WINDOW_ACTIVATION_ROUTE_PATTERN.test(String(pathname || '')) && (verb === 'GET' || verb === 'POST');
}

function resolveRouteDependency(ctx, name, fallback) {
  const injected = ctx && ctx.deps && ctx.deps[name];
  return typeof injected === 'function' ? injected : fallback;
}

function presentSetting(config) {
  return {
    enabled: Boolean(config && config.enabled === true),
    intervalMs: config && Number.isFinite(Number(config.intervalMs)) && Number(config.intervalMs) > 0
      ? Math.floor(Number(config.intervalMs))
      : null
  };
}

/**
 * GET  /v0/webui/accounts/:provider/:accountRef/window-activation  读当前设置
 * POST /v0/webui/accounts/:provider/:accountRef/window-activation  写入设置
 *
 * POST body: { enabled: boolean, intervalMs?: number|null }
 *   intervalMs 为 null/缺省表示「跟随全局默认间隔」。
 *
 * @returns {Promise<boolean>} 是否已处理该请求
 */
async function handleWindowActivationRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseWindowActivationRoute(pathname);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'window_activation_unsupported_provider' });
    return true;
  }
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

  const readConfig = resolveRouteDependency(ctx, 'readWindowActivationConfig', readWindowActivationConfig);
  const writeConfig = resolveRouteDependency(ctx, 'writeWindowActivationConfig', writeWindowActivationConfig);
  const method = String(ctx.req && ctx.req.method || '').toUpperCase();

  if (method === 'GET') {
    let config;
    try {
      config = readConfig(ctx.fs, aiHomeDir, accountRef);
    } catch {
      writeJson(ctx.res, 500, { ok: false, error: 'window_activation_read_failed' });
      return true;
    }
    writeJson(ctx.res, 200, { ok: true, provider, accountRef, setting: presentSetting(config) });
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

  const enabled = payload.enabled === true;
  let intervalMs = null;
  if (payload.intervalMs !== null && payload.intervalMs !== undefined && payload.intervalMs !== '') {
    const value = Number(payload.intervalMs);
    if (!Number.isFinite(value) || value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_interval_ms' });
      return true;
    }
    intervalMs = Math.floor(value);
  }

  try {
    writeConfig(ctx.fs, aiHomeDir, accountRef, { enabled, intervalMs });
  } catch {
    writeJson(ctx.res, 500, { ok: false, error: 'window_activation_write_failed' });
    return true;
  }

  let config;
  try {
    config = readConfig(ctx.fs, aiHomeDir, accountRef);
  } catch {
    writeJson(ctx.res, 500, { ok: false, error: 'window_activation_read_failed' });
    return true;
  }
  writeJson(ctx.res, 200, { ok: true, provider, accountRef, setting: presentSetting(config) });
  return true;
}

module.exports = {
  WINDOW_ACTIVATION_ROUTE_PATTERN,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  handleWindowActivationRequest,
  matchWindowActivationRoute,
  parseWindowActivationRoute
};
