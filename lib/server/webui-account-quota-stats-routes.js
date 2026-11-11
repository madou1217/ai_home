'use strict';

// 账号额度统计：窗口期视图（5h / 7天 / 30天…）与日/周用量视图。
//
// **切流（2026-11-08）**：统计口径全部由 Go 决定，本文件只做四件事：
//   1. 账号校验——账号必须存在且 Provider 匹配，404 语义留在 Node；
//   2. 参数翻译——window / rangeDays / scope / granularity 的校验与取值范围；
//   3. 调用 Go 的两个只读接口：
//        /v1/management/accounts/{ref}/quota-stats —— 窗口维度、重建、成本（application/accountusage）
//        /v1/management/usage/buckets            —— 日/周用量桶（usagestatsapi）
//   4. snake→camel 契约映射（见 account-quota-stats-go-mapping.js）。
//
// 为什么不保留本地回落：迁移总账第 9 条记的就是「两套算法并存，页面口径随 Go 抖动跳变」
// 导致的那次回滚。现在 usage_ledger 已有数据，第二套算法（lib/account/quota-window-stats.js）
// 已删除；Go 不可用一律 503，由前端显示加载失败，而不是悄悄换一套数。
//
// 窗口语义与调度器同源（lib/server/window-activation/window-ledger.js 的 F1–F4）：
// 窗口由「关闭后的第一个真实请求」锚定，不会自然滚动；空闲期快照报的 reset 是幻影，
// 必须剔除。重建逻辑在 Go 侧，本文件不再读采样/事件/账本。

const { resolveAccountRef } = require('./account-ref-store');
const { resolveAccountAnywhere } = require('./webui-account-routes-utils');
const { mapGoQuotaStats, resolveGranularity } = require('./account-quota-stats-go-mapping');

const QUOTA_STATS_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/quota-stats$/;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 90;
// 只防脏参数（负数/小数/荒谬值），不限制具体窗口长度：上游随时可能新增档位。
const MAX_WINDOW_MINUTES = 366 * 24 * 60;
const ALLOWED_GRANULARITIES = new Set(['window', 'day', 'week']);
const DAY_MS = 24 * 60 * 60 * 1000;

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

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * 把页面参数翻译成 Go 的查询参数。
 *
 * 返回 { error } 表示参数非法（直接 400）；否则给出 windowMinutes / rangeDays /
 * scope / granularity。rangeDays 只在这里夹到 1..90：Go 侧也会拒绝越界值，
 * 两边都夹会让「谁先拒绝」取决于调用顺序，只在一处夹才有确定语义。
 */
function translateQuery(searchParams) {
  const rawWindow = text(searchParams && searchParams.get('window'));
  let windowMinutes = 0;
  if (rawWindow) {
    const parsed = Number(rawWindow);
    if (
      !Number.isFinite(parsed)
      || !Number.isInteger(parsed)
      || parsed <= 0
      || parsed > MAX_WINDOW_MINUTES
    ) {
      return { error: { error: 'invalid_quota_window', message: '窗口期必须是正整数分钟数' } };
    }
    windowMinutes = parsed;
  }

  // 兼容两种写法：页面用 rangeDays，Go 契约是 range_days。只认一种会让同一组参数
  // 在两条路径上得到不同范围（真机：range_days=7 时 Node 仍按 30 天统计）。
  const rawRange = text(searchParams && (searchParams.get('rangeDays') || searchParams.get('range_days')));
  const parsedRange = Number(rawRange);
  const rangeDays = rawRange && Number.isFinite(parsedRange) && parsedRange > 0
    ? Math.max(1, Math.min(MAX_RANGE_DAYS, Math.trunc(parsedRange)))
    : DEFAULT_RANGE_DAYS;

  const granularity = text(searchParams && searchParams.get('granularity')).toLowerCase();
  if (granularity && !ALLOWED_GRANULARITIES.has(granularity)) {
    return { error: { error: 'invalid_quota_granularity', message: '统计粒度只支持 window / day / week' } };
  }

  return {
    windowMinutes,
    rangeDays,
    granularity,
    scope: text(searchParams && searchParams.get('scope'))
  };
}

// 日/周桶来自另一个 Go 接口：窗口接口不带时间桶，桶接口不带窗口维度。
// 两次调用都只读，任何一次失败都整体 503——只给一半数据比没有数据更难解释。
async function readUsageBuckets(goHost, accountRef, rangeDays, granularity) {
  if (typeof goHost.getUsageBuckets !== 'function') {
    return { errorCode: 'go_core_unavailable' };
  }
  const toMs = Date.now();
  const fromMs = toMs - rangeDays * DAY_MS;
  const response = await goHost.getUsageBuckets(accountRef, {
    fromISO: new Date(fromMs).toISOString(),
    toISO: new Date(toMs).toISOString(),
    granularity
  });
  if (!response || response.ok !== true) {
    return { errorCode: (response && response.errorCode) || 'go_usage_buckets_failed' };
  }
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  return { buckets: Array.isArray(data.buckets) ? data.buckets : [] };
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

  // 额度统计由 Go 提供：Node 账号库没有时按 Go 的账号库判定归属（Go 独有账号）。
  const { account: owner } = resolveAccountAnywhere(ctx, provider, accountRef);
  if (!owner) {
    ctx.writeJson(ctx.res, 404, {
      ok: false,
      error: 'account_not_found',
      message: `未找到 ${provider} 账号 ${accountRef}`
    });
    return true;
  }

  const searchParams = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : null;
  const query = translateQuery(searchParams);
  if (query.error) {
    ctx.writeJson(ctx.res, 400, { ok: false, ...query.error });
    return true;
  }

  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost || typeof goHost.getAccountQuotaStats !== 'function') {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: '额度统计由 Go 提供，当前不可用'
    });
    return true;
  }

  const response = await goHost.getAccountQuotaStats(accountRef, {
    windowMinutes: query.windowMinutes,
    rangeDays: query.rangeDays,
    scope: query.scope
  });
  if (!response || response.ok !== true) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: (response && response.errorCode) || 'go_quota_stats_failed'
    });
    return true;
  }

  const goData = response.data && typeof response.data === 'object' ? response.data : {};

  // format=go：对拍/取证入口，原样返回 Go 的结果（不经过契约映射）。
  // 与 scripts/compare-quota-stats.js 配套：切流后正常响应已经来自 Go，
  // 这个入口只剩「看 Go 原始字段」一个用途。
  if (text(searchParams && searchParams.get('format')) === 'go') {
    ctx.writeJson(ctx.res, 200, { ok: true, provider, accountRef, go: goData });
    return true;
  }

  // 未指定粒度时按账号能把哪些维度算出来决定：有可用窗口给窗口，否则给日统计。
  const granularity = resolveGranularity(goData, query.granularity);
  let buckets = null;
  if (granularity !== 'window') {
    const result = await readUsageBuckets(goHost, accountRef, query.rangeDays, granularity);
    if (result.errorCode) {
      ctx.writeJson(ctx.res, 503, { ok: false, error: result.errorCode });
      return true;
    }
    buckets = result.buckets;
  }

  ctx.writeJson(ctx.res, 200, mapGoQuotaStats(goData, { provider, accountRef, buckets, granularity }));
  return true;
}

module.exports = {
  QUOTA_STATS_PATTERN,
  MAX_WINDOW_MINUTES,
  translateQuery,
  handleWebUiAccountQuotaStatsRoutes
};
