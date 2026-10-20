'use strict';

// WebUI 数据面：账号活动（签到 / 领试用套餐）的执行入口。
//
// 动作清单来自 provider 描述符的 `activity` 能力（见 lib/providers/defs/*.js），
// 因此这里没有 provider 名单：新增 provider 只加描述符，前端只渲染服务端下发的
// `activityActions`。执行本身复用 CLI 同一条策略执行器（lib/account/activity-claim），
// 保证「CLI 能领的，WebUI 同一套逻辑领」。
//
// 两条路由：
//   POST /v0/webui/accounts/activity/run
//     —— 对声明了 activity 的账号逐个执行。可选 JSON 体 `{ providers, actionId }`
//        把范围收窄到当前供应商 tab（账号页入口按 tab 展示，不提供全局按钮）。
//   POST /v0/webui/accounts/:provider/:accountRef/activity/:actionId
//     —— 单账号单动作（账号菜单项）
//
// 领取失败（活动未开放、验证码失败、凭据失效）是**正常业务结果**：HTTP 200 + ok:false，
// 由界面按 result.status / error 显示，不伪装成服务器故障。

const {
  listActivityActions,
  listActivityProviders,
  runActivityClaim
} = require('../account/activity-claim');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const { listAccountCredentialRecords } = require('./account-credential-store');
const { fetchWithTimeout } = require('./http-utils');
const { resolveAccountEgressRequestOptions } = require('./account-egress-request-options');

const BULK_ROUTE = '/v0/webui/accounts/activity/run';
const ACTION_ROUTE = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/activity\/([a-z0-9][a-z0-9._-]{0,63})$/;
const DEFAULT_TIMEOUT_MS = 20_000;

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

function resolveDep(ctx, name, fallback) {
  const injected = ctx && ctx.deps && ctx.deps[name];
  return typeof injected === 'function' ? injected : fallback;
}

function matchAccountActivityRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  if (verb !== 'POST') return null;
  const path = String(pathname || '');
  if (path === BULK_ROUTE) return { bulk: true };
  const match = ACTION_ROUTE.exec(path);
  if (!match) return null;
  try {
    return {
      bulk: false,
      provider: decodeURIComponent(match[1]).trim().toLowerCase(),
      accountRef: decodeURIComponent(match[2]).trim(),
      actionId: decodeURIComponent(match[3]).trim().toLowerCase()
    };
  } catch (_error) {
    return null;
  }
}

function summarize(results) {
  const summary = {
    accounts: results.length,
    claimed: 0,
    alreadyClaimed: 0,
    nothingClaimable: 0,
    notApplicable: 0,
    failed: 0
  };
  for (const result of results) {
    if (result.status === 'claimed') summary.claimed += 1;
    else if (result.status === 'already_claimed') summary.alreadyClaimed += 1;
    else if (result.status === 'nothing_claimable') summary.nothingClaimable += 1;
    else if (result.status === 'not_applicable') summary.notApplicable += 1;
    else if (result.status === 'error') summary.failed += 1;
  }
  return summary;
}

function buildClaimDeps(ctx, aiHomeDir) {
  return {
    fs: (ctx && ctx.fs) || (ctx && ctx.deps && ctx.deps.fs) || nodeFs,
    aiHomeDir,
    hostHomeDir: String(
      (ctx && ctx.deps && ctx.deps.hostHomeDir)
      || (ctx && ctx.state && ctx.state.hostHomeDir)
      || (ctx && ctx.processObj && ctx.processObj.env && ctx.processObj.env.AIH_HOST_HOME)
      || nodeOs.homedir()
    ).trim(),
    processObj: (ctx && ctx.processObj) || process,
    fetchWithTimeout: resolveDep(ctx, 'fetchWithTimeout', fetchWithTimeout),
    resolveAccountEgressRequestOptions: resolveDep(
      ctx,
      'resolveAccountEgressRequestOptions',
      resolveAccountEgressRequestOptions
    ),
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
}

async function runOne(ctx, deps, provider, record, actionId) {
  const execute = resolveDep(ctx, 'runActivityClaim', runActivityClaim);
  try {
    const result = await execute({
      ...deps,
      provider,
      record,
      actionId,
      ...(ctx && ctx.deps && ctx.deps.accountEgressDeps
        ? { accountEgressDeps: ctx.deps.accountEgressDeps }
        : {})
    });
    return result && typeof result === 'object'
      ? result
      : { provider, accountRef: record.accountRef, status: 'error', error: 'activity_empty_result' };
  } catch (error) {
    return {
      provider,
      accountRef: record.accountRef,
      status: 'error',
      error: `activity_failed:${String(error && error.message || error).trim()}`
    };
  }
}

async function readBulkSelection(ctx) {
  if (!ctx || typeof ctx.readRequestBody !== 'function' || !ctx.req) {
    return { providers: null, actionId: '' };
  }
  // 空体 / 非法 JSON 都按「不筛选」处理（保持旧调用方语义）。
  const payload = await ctx.readRequestBody(ctx.req, { maxBytes: 8 * 1024 })
    .then((buffer) => (buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : null))
    .catch(() => null);
  const providers = Array.isArray(payload && payload.providers)
    ? payload.providers
      .map((item) => String(item === undefined || item === null ? '' : item).trim().toLowerCase())
      .filter(Boolean)
    : null;
  const actionId = typeof (payload && payload.actionId) === 'string'
    ? payload.actionId.trim().toLowerCase()
    : '';
  return { providers, actionId };
}

async function handleBulk(ctx, deps, aiHomeDir) {
  const allProviders = typeof (ctx.deps && ctx.deps.listActivityProviders) === 'function'
    ? ctx.deps.listActivityProviders()
    : listActivityProviders();
  if (allProviders.length === 0) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'activity_unsupported' });
    return true;
  }
  const selection = await readBulkSelection(ctx);
  let providers = allProviders;
  if (selection.providers) {
    const wanted = new Set(selection.providers);
    providers = allProviders.filter((provider) => wanted.has(provider));
  }
  if (providers.length === 0) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'activity_unsupported' });
    return true;
  }
  const listActions = resolveDep(ctx, 'listActivityActions', listActivityActions);
  const listRecords = resolveDep(ctx, 'listAccountCredentialRecords', listAccountCredentialRecords);
  const results = [];
  for (const provider of providers) {
    let actionId = '';
    if (selection.actionId) {
      const actions = listActions(provider);
      const action = actions.find((entry) => entry.id === selection.actionId);
      // 同一族里可能只有部分站点声明了该动作：没有声明的站点直接跳过。
      if (!action) continue;
      actionId = action.id;
    }
    let records = [];
    try {
      records = listRecords(deps.fs, aiHomeDir, provider);
    } catch (error) {
      results.push({
        provider,
        accountRef: '',
        status: 'error',
        error: `account_list_failed:${String(error && error.message || error).trim()}`
      });
      continue;
    }
    for (const record of records) {
      results.push(await runOne(ctx, deps, provider, record, actionId));
    }
  }
  const summary = summarize(results);
  ctx.writeJson(ctx.res, 200, {
    ok: summary.failed === 0,
    capturedAt: new Date().toISOString(),
    results,
    summary
  });
  return true;
}

async function handleSingle(ctx, deps, aiHomeDir, route) {
  const actions = typeof (ctx.deps && ctx.deps.listActivityActions) === 'function'
    ? ctx.deps.listActivityActions(route.provider)
    : listActivityActions(route.provider);
  if (actions.length === 0) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: `activity_unsupported:${route.provider}` });
    return true;
  }
  if (!actions.some((action) => action.id === route.actionId)) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: `activity_action_unknown:${route.actionId}` });
    return true;
  }
  const listRecords = resolveDep(ctx, 'listAccountCredentialRecords', listAccountCredentialRecords);
  let records = [];
  try {
    records = listRecords(deps.fs, aiHomeDir, route.provider);
  } catch (error) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: `account_list_failed:${String(error && error.message || error).trim()}`
    });
    return true;
  }
  const record = records.find((item) => String(item && item.accountRef || '') === route.accountRef);
  if (!record) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const result = await runOne(ctx, deps, route.provider, record, route.actionId);
  ctx.writeJson(ctx.res, 200, { ok: result.status !== 'error', ...result });
  return true;
}

async function handleAccountActivityRequest(ctx) {
  const route = matchAccountActivityRoute(ctx.method, ctx.pathname);
  if (!route) return false;
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'aih_home_dir_unavailable' });
    return true;
  }
  const deps = buildClaimDeps(ctx, aiHomeDir);
  if (route.bulk) return handleBulk(ctx, deps, aiHomeDir);
  return handleSingle(ctx, deps, aiHomeDir, route);
}

module.exports = {
  handleAccountActivityRequest,
  matchAccountActivityRoute,
  summarizeActivityResults: summarize
};
