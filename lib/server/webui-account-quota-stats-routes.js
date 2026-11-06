'use strict';

// 账号额度统计：按窗口期返回每个窗口的额度消耗、tokens、成本。
//
// 窗口长度不写死、也不靠「碰巧有数据」反推：
//   1. 账号证据（样本 ∪ 重置事件 ∪ 当前快照）说了算；
//   2. 账号给不出答案时，问 provider 声明的泛范围（descriptor.quota.stats.windows）；
//   3. 两者都没有 → 没有窗口维度，页面走日/周统计。
// 选择逻辑在 lib/account/quota-stats-strategy.js。请求里带任意正整数 window 都放行，
// 具体有没有这个维度由上面两步决定，前端按返回的 dimensions 渲染。
//
// 窗口语义与调度器同源（lib/server/window-activation/window-ledger.js 的 F1–F4）：
// 窗口由「关闭后的第一个真实请求」锚定，不会自然滚动；空闲期快照报的 reset 是幻影，
// 必须剔除。重建逻辑在 lib/account/quota-window-reconstruction.js。

const { resolveAccountRef } = require('./account-ref-store');
const { readAccountUsageSnapshot } = require('../account/usage-snapshot-store');
const { extractQuotaObservations } = require('../account/quota-reset-detector');
const { buildAccountQuotaStats } = require('../account/quota-window-stats');
const { isPhantomSample } = require('./window-activation/window-ledger');

const QUOTA_STATS_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/quota-stats$/;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 90;
// 只防脏参数（负数/小数/荒谬值），不限制具体窗口长度：上游随时可能新增档位。
const MAX_WINDOW_MINUTES = 366 * 24 * 60;
const ALLOWED_GRANULARITIES = new Set(['window', 'day', 'week']);

function writeNoStoreHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}

function decodePathValue(value) {
  try {
    return decodeURIComponent(String(value || '')).trim();
  } catch (_error) {
    return '';
  }
}

function readSnapshotScopes(fs, aiHomeDir, accountRef, provider) {
  try {
    const snapshot = readAccountUsageSnapshot(fs, aiHomeDir, accountRef);
    if (!snapshot) return [];
    return extractQuotaObservations(provider, snapshot).map((observation) => ({
      quotaKey: observation.quotaKey,
      label: observation.windowLabel,
      windowMinutes: Number(observation.windowMinutes) || 0,
      remainingPct: observation.remainingPct,
      resetAtMs: Number(observation.expectedResetAtMs) || 0,
      // 空闲时上游报的 reset 是「读取时刻 + 窗口时长」：仍能证明账号有这种窗口，
      // 但不能当成当前活跃窗口展示。
      phantom: isPhantomSample(
        Number(observation.capturedAt) || 0,
        Number(observation.expectedResetAtMs) || 0,
        Number(observation.windowMinutes) || 0
      )
    }));
  } catch (_error) {
    // 快照只用来补维度可用性和当前值；读不到时退化成「只有样本/事件」。
    return [];
  }
}

async function handleWebUiAccountQuotaStatsRoutes(ctx) {
  const match = String(ctx.pathname || '').match(QUOTA_STATS_PATTERN);
  if (!match) return false;

  writeNoStoreHeaders(ctx.res);

  if (ctx.method !== 'GET') {
    ctx.writeJson(ctx.res, 405, {
      ok: false,
      error: 'method_not_allowed',
      message: 'Method not allowed'
    });
    return true;
  }

  const provider = decodePathValue(match[1]).toLowerCase();
  const accountRef = decodePathValue(match[2]);
  if (!provider || !accountRef) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_quota_stats_path',
      message: '无效的额度统计路径'
    });
    return true;
  }

  const fs = ctx.fs || (ctx.deps && ctx.deps.fs) || require('node:fs');
  const aiHomeDir = ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir) || '';

  const account = resolveAccountRef(fs, aiHomeDir, accountRef, { bestEffort: true });
  if (!account || (account.provider && account.provider.toLowerCase() !== provider)) {
    ctx.writeJson(ctx.res, 404, {
      ok: false,
      error: 'account_not_found',
      message: `未找到 ${provider} 账号 ${accountRef}`
    });
    return true;
  }

  const searchParams = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : null;

  // format=go：把同一个请求同时打给 Go，返回它的原始结果。
  // 切流前用它做 Node/Go 对拍（Go 的 management key 只存在 Node 进程里，
  // 外部脚本拿不到，所以对拍入口必须在这里）。
  if (String(searchParams ? searchParams.get('format') || '' : '') === 'go') {
    const goHost = ctx.deps && ctx.deps.goCoreSync;
    if (!goHost || typeof goHost.getAccountQuotaStats !== 'function') {
      ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
      return true;
    }
    const rangeDaysParam = Number(searchParams.get('range_days'));
    const response = await goHost.getAccountQuotaStats(accountRef, {
      windowMinutes: Number(searchParams.get('window')) || 0,
      rangeDays: Number.isFinite(rangeDaysParam) ? rangeDaysParam : 0,
      scope: String(searchParams.get('scope') || '')
    });
    if (!response || response.ok !== true) {
      ctx.writeJson(ctx.res, (response && response.status) || 502, {
        ok: false,
        error: (response && response.errorCode) || 'go_quota_stats_failed'
      });
      return true;
    }
    ctx.writeJson(ctx.res, 200, { ok: true, provider, accountRef, go: response.data });
    return true;
  }

  const rawWindow = String(searchParams ? searchParams.get('window') || '' : '').trim();
  const windowParam = rawWindow ? Number(rawWindow) : 0;
  if (rawWindow && (
    !Number.isFinite(windowParam)
    || !Number.isInteger(windowParam)
    || windowParam <= 0
    || windowParam > MAX_WINDOW_MINUTES
  )) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_quota_window',
      message: '窗口期必须是正整数分钟数'
    });
    return true;
  }

  const rangeDaysParam = Number(searchParams ? searchParams.get('rangeDays') : 0);
  const rangeDays = Number.isFinite(rangeDaysParam) && rangeDaysParam > 0
    ? Math.max(1, Math.min(MAX_RANGE_DAYS, Math.trunc(rangeDaysParam)))
    : DEFAULT_RANGE_DAYS;
  const toMs = Number(searchParams ? searchParams.get('to') : 0) || 0;
  const quotaKey = searchParams ? String(searchParams.get('scope') || '').trim() : '';
  const rawGranularity = String(searchParams ? searchParams.get('granularity') || '' : '').trim().toLowerCase();
  if (rawGranularity && !ALLOWED_GRANULARITIES.has(rawGranularity)) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_quota_granularity',
      message: '统计粒度只支持 window / day / week'
    });
    return true;
  }

  const modelUsageService = ctx.deps && ctx.deps.modelUsageService;
  const queryWindowUsage = modelUsageService
    && typeof modelUsageService.getAccountQuotaWindowUsage === 'function'
    ? (query) => modelUsageService.getAccountQuotaWindowUsage(query)
    : null;

  try {
    const result = buildAccountQuotaStats({
      fs,
      aiHomeDir,
      provider,
      accountRef,
      windowMinutes: windowParam,
      quotaKey,
      granularity: rawGranularity,
      rangeDays,
      toMs,
      snapshotScopes: readSnapshotScopes(fs, aiHomeDir, accountRef, provider),
      queryWindowUsage
    });
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountRef,
      ...result
    });
    return true;
  } catch (error) {
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'quota_stats_failed',
      message: String((error && error.message) || error || 'quota_stats_failed')
    });
    return true;
  }
}

module.exports = {
  QUOTA_STATS_PATTERN,
  MAX_WINDOW_MINUTES,
  handleWebUiAccountQuotaStatsRoutes
};
