'use strict';

// 账号额度统计的编排层：把「维度可用性 → 选 scope → 窗口重建 → 用量聚合 → 汇总」
// 串起来。窗口语义在 quota-window-reconstruction.js，tokens/成本在
// model-usage-store.js；本文件只做选择与拼装，不碰 provider 细节。

const { readWindowActivationState } = require('./window-activation-store');
const {
  listQuotaWindowSamples,
  listQuotaWindowScopeIndex
} = require('./quota-window-store');
const {
  listAccountQuotaResetEventsInRange,
  listAccountQuotaResetEventScopeIndex
} = require('./quota-reset-store');
const {
  buildQuotaWindows
} = require('./quota-window-reconstruction');
const { resolveQuotaStatsWindows } = require('./quota-stats-strategy');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RANGE_DAYS = 1;
const MAX_RANGE_DAYS = 90;
const DEFAULT_RANGE_DAYS = 30;

// 统计粒度：window = 额度窗口（5h/12h/7天…）；day/week = 按自然日/自然周聚合用量。
// 日/周不依赖窗口样本，因此没有窗口明细的账号也有数据可看。
const GRANULARITY_WINDOW = 'window';
const GRANULARITY_DAY = 'day';
const GRANULARITY_WEEK = 'week';
const USAGE_GRANULARITIES = new Set([GRANULARITY_DAY, GRANULARITY_WEEK]);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function toMs(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

// 维度标签只做展示，不参与归维。固定档位用习惯叫法，其余按分钟数推导
// （720 → 12h、724 → 12h4m、1440 → 1天），上游新增窗口长度时页面自动多一个维度。
function formatWindowLabel(minutes) {
  const value = toMs(minutes, 0);
  if (value <= 0) return '当前额度';
  if (value === 300) return '5h';
  if (value === 10080) return '7天';
  if (value === 43200) return '30天';
  const days = Math.floor(value / 1440);
  const hours = Math.floor((value % 1440) / 60);
  const restMinutes = value % 60;
  if (days > 0) return hours > 0 ? `${days}天${hours}h` : `${days}天`;
  if (hours > 0) return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
  return `${restMinutes}分钟`;
}

// 快照里的额度范围标签直接来自上游（"1days" / "5 hours"），页面上和维度标签
// 并排时会显得很脏。只归一「纯时长」写法，其余上游标签原样保留。
function normalizeScopeLabel(raw, fallbackMinutes) {
  const value = text(raw);
  if (!value) return formatWindowLabel(fallbackMinutes);
  const days = /^(\d+)\s*days?$/i.exec(value);
  if (days) return formatWindowLabel(Number(days[1]) * 1440);
  const hours = /^(\d+)\s*(?:hours?|hrs?|h)$/i.exec(value);
  if (hours) return formatWindowLabel(Number(hours[1]) * 60);
  return value;
}

function roundPct(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function clampRangeDays(value) {
  const days = toMs(value, DEFAULT_RANGE_DAYS);
  if (!days) return DEFAULT_RANGE_DAYS;
  return Math.max(MIN_RANGE_DAYS, Math.min(MAX_RANGE_DAYS, days));
}

// 自然日/自然周按服务器本地时区切分：用户看「今天/本周」时不能按 UTC 切。
function startOfLocalDay(ms) {
  const date = new Date(toMs(ms, 0));
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addLocalDays(ms, days) {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** 周一为一周起点（与国内习惯一致）。 */
function startOfLocalWeek(ms) {
  const dayStart = startOfLocalDay(ms);
  const weekday = (new Date(dayStart).getDay() + 6) % 7;
  return addLocalDays(dayStart, -weekday);
}

function buildUsageBuckets(granularity, fromMs, toMs) {
  const stepDays = granularity === GRANULARITY_WEEK ? 7 : 1;
  let cursor = granularity === GRANULARITY_WEEK ? startOfLocalWeek(fromMs) : startOfLocalDay(fromMs);
  const buckets = [];
  let index = 0;
  // 90 天上限下最多 90 个日桶 / 14 个周桶；硬上限只防参数被绕过。
  while (cursor < toMs && buckets.length < 400) {
    const next = addLocalDays(cursor, stepDays);
    buckets.push({
      index,
      startMs: Math.max(cursor, fromMs),
      endMs: Math.min(next, toMs),
      bucketStartMs: cursor
    });
    cursor = next;
    index += 1;
  }
  return buckets;
}

function emptySummary() {
  return {
    windowCount: 0,
    coveredWindowCount: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    costKnown: true,
    requestCount: 0,
    avgConsumedPct: null,
    maxConsumedPct: null,
    minConsumedPct: null,
    avgTokensPerWindow: null,
    avgCostUsdPerWindow: null,
    lastResetAtMs: 0,
    nextCloseAtMs: 0
  };
}

/**
 * 维度可用性 = 样本 ∪ 重置事件 ∪ 当前快照，任一出现该窗口长度即可用。
 * 快照里有、样本里还没有的 scope 标 synthetic：让页面首屏就能显示当前窗口，
 * 而不是「无数据」（采样从本版本才开始）。
 *
 * **窗口长度不写死**：各 Provider 的窗口不同（5h / 12h / 7天 / 30天），
 * 维度从三份数据里实际出现的 windowMinutes 派生；只有完全没有窗口数据时
 * 才退回固定三维度，保持历史空态。
 */
function buildDimension(windowMinutes, { scopeIndex, eventScopeIndex, snapshotScopes }) {
  const scopes = new Map();
  const label = formatWindowLabel(windowMinutes);

  scopeIndex.forEach((row) => {
    if (toMs(row.windowMinutes, 0) !== windowMinutes) return;
    const quotaKey = text(row.quotaKey);
    if (!quotaKey) return;
    scopes.set(quotaKey, {
      quotaKey,
      label: normalizeScopeLabel(row.windowLabel, windowMinutes),
      sampleCount: toMs(row.sampleCount, 0),
      lastCapturedAtMs: toMs(row.lastCapturedAtMs, 0),
      synthetic: false
    });
  });

  eventScopeIndex.forEach((row) => {
    if (toMs(row.windowMinutes, 0) !== windowMinutes) return;
    const quotaKey = text(row.quotaKey);
    if (!quotaKey || scopes.has(quotaKey)) return;
    scopes.set(quotaKey, {
      quotaKey,
      label: normalizeScopeLabel(row.windowLabel, windowMinutes),
      sampleCount: 0,
      lastCapturedAtMs: toMs(row.lastOccurredAtMs, 0),
      synthetic: false
    });
  });

  snapshotScopes.forEach((row) => {
    if (toMs(row.windowMinutes, 0) !== windowMinutes) return;
    const quotaKey = text(row.quotaKey);
    if (!quotaKey || scopes.has(quotaKey)) return;
    scopes.set(quotaKey, {
      quotaKey,
      label: normalizeScopeLabel(row.label, windowMinutes),
      sampleCount: 0,
      lastCapturedAtMs: 0,
      synthetic: true
    });
  });

  const list = Array.from(scopes.values());
  const dataState = list.some((scope) => scope.sampleCount > 0)
    ? 'ready'
    : (list.length > 0 ? 'pending' : 'empty');
  return {
    windowMinutes,
    label,
    available: list.length > 0,
    dataState,
    scopes: list
  };
}

function collectWindowMinutes({ scopeIndex, eventScopeIndex, snapshotScopes }) {
  const minutes = new Set();
  const add = (value) => {
    const parsed = toMs(value, 0);
    if (parsed > 0) minutes.add(parsed);
  };
  scopeIndex.forEach((row) => add(row && row.windowMinutes));
  eventScopeIndex.forEach((row) => add(row && row.windowMinutes));
  snapshotScopes.forEach((row) => add(row && row.windowMinutes));
  return [...minutes].sort((a, b) => a - b);
}

/**
 * 维度 = 账号证据 ∪ 策略层给出的窗口集合。
 *
 * `declaredWindows` 已经由 lib/account/quota-stats-strategy.js 收窄过：
 * 账号有证据时它就是证据本身（声明的泛范围不再参与），只有账号完全给不出答案时
 * 才回落到 provider 声明。这里只做并集，避免样本/事件里出现声明之外的窗口时被丢掉。
 */
function buildDimensions(input) {
  const minutes = new Set(collectWindowMinutes(input));
  for (const value of input.declaredWindows || []) {
    const parsed = toMs(value, 0);
    if (parsed > 0) minutes.add(parsed);
  }
  return [...minutes]
    .sort((a, b) => a - b)
    .map((windowMinutes) => buildDimension(windowMinutes, input));
}

function pickDimension(dimensions, requestedWindowMinutes) {
  const minutes = toMs(requestedWindowMinutes, 0);
  if (minutes) {
    const exact = dimensions.find((dimension) => dimension.windowMinutes === minutes);
    if (exact) return exact;
  }
  // 请求的维度不存在时回落到第一个可用维度：首屏固定传 5h，12h 账号不能因此
  // 先返回一次 dimension_unavailable 再让前端二次请求。
  return dimensions.find((dimension) => dimension.available) || dimensions[0] || null;
}

function pickScope(dimension, requestedQuotaKey) {
  if (!dimension || !dimension.available) return null;
  const quotaKey = text(requestedQuotaKey);
  if (quotaKey) return dimension.scopes.find((scope) => scope.quotaKey === quotaKey) || null;
  return dimension.scopes[0] || null;
}

function safeReadLedger(fs, aiHomeDir, accountRef) {
  try {
    return readWindowActivationState(fs, aiHomeDir, accountRef);
  } catch (_error) {
    // 账本是尽力而为的诊断数据，损坏时按「没有窗口」处理，不能让整页 500。
    return null;
  }
}

function pickCurrent({ samples, ledger, dimension, snapshotScopes, quotaKey }) {
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  if (latest) {
    return {
      remainingPct: latest.remainingPct,
      resetAtMs: toMs(latest.expectedResetAtMs, 0),
      capturedAtMs: toMs(latest.capturedAtMs, 0)
    };
  }
  if (ledger
    && toMs(ledger.windowMinutes, 0) === dimension.windowMinutes
    && toMs(ledger.windowCloseAtMs, 0) > 0) {
    return {
      remainingPct: null,
      resetAtMs: toMs(ledger.windowCloseAtMs, 0),
      capturedAtMs: toMs(ledger.windowObservedAtMs, 0)
    };
  }
  const scope = snapshotScopes.find((row) => (
    text(row.quotaKey) === quotaKey
    && toMs(row.windowMinutes, 0) === dimension.windowMinutes
    && row.phantom !== true
  ));
  if (scope) {
    const remainingPct = Number(scope.remainingPct);
    return {
      remainingPct: Number.isFinite(remainingPct) ? remainingPct : null,
      resetAtMs: toMs(scope.resetAtMs, 0),
      capturedAtMs: 0
    };
  }
  return null;
}

function pickSnapshotCurrent(snapshotScopes) {
  const row = (Array.isArray(snapshotScopes) ? snapshotScopes : []).find((scope) => {
    if (!scope || scope.phantom === true) return false;
    return Number.isFinite(Number(scope.remainingPct));
  });
  if (!row) return null;
  return {
    remainingPct: Math.max(0, Math.min(100, Number(row.remainingPct))),
    resetAtMs: toMs(row.resetAtMs, 0),
    capturedAtMs: 0
  };
}

function summarizeWindows(windows) {
  const consumed = windows
    .map((window) => window.consumedPct)
    .filter((value) => Number.isFinite(value));
  const totalTokens = windows.reduce((sum, window) => sum + (Number(window.tokens) || 0), 0);
  const requestCount = windows.reduce((sum, window) => sum + (Number(window.requestCount) || 0), 0);
  const costWindows = windows.filter((window) => (Number(window.tokens) || 0) > 0);
  const costKnown = costWindows.every((window) => window.costKnown !== false);
  const totalCostUsd = costKnown
    ? windows.reduce((sum, window) => sum + (Number(window.costUsd) || 0), 0)
    : null;
  const live = windows.find((window) => window.live) || null;
  const lastReset = windows.slice().reverse().find((window) => window.resetKind);

  return {
    windowCount: windows.length,
    coveredWindowCount: consumed.length,
    totalTokens,
    totalCostUsd,
    costKnown,
    requestCount,
    avgConsumedPct: consumed.length > 0
      ? roundPct(consumed.reduce((sum, value) => sum + value, 0) / consumed.length)
      : null,
    maxConsumedPct: consumed.length > 0 ? roundPct(Math.max(...consumed)) : null,
    minConsumedPct: consumed.length > 0 ? roundPct(Math.min(...consumed)) : null,
    avgTokensPerWindow: windows.length > 0 ? Math.round(totalTokens / windows.length) : null,
    avgCostUsdPerWindow: costKnown && windows.length > 0
      ? totalCostUsd / windows.length
      : null,
    lastResetAtMs: lastReset ? lastReset.closeAtMs : 0,
    nextCloseAtMs: live ? live.closeAtMs : 0
  };
}

/**
 * 日/周统计：只依赖用量记录，不依赖窗口样本。
 * 这样没有窗口明细的账号（API Key / 积分型 / Go 采集但还没采样）也能看到数据。
 */
function buildUsageStats({ base, granularity, accountRef, rangeFromMs, toMsFinal, snapshotScopes, queryWindowUsage }) {
  const buckets = buildUsageBuckets(granularity, rangeFromMs, toMsFinal);
  const usage = queryWindowUsage
    ? queryWindowUsage({
      accountRef,
      windows: buckets.map((bucket) => ({
        index: bucket.index,
        startMs: bucket.startMs,
        endMs: bucket.endMs
      }))
    })
    : [];
  const usageByIndex = new Map(
    (Array.isArray(usage) ? usage : []).map((row) => [toMs(row.index, 0), row])
  );
  const rows = buckets.map((bucket) => {
    const row = usageByIndex.get(bucket.index);
    return {
      ...bucket,
      tokens: row ? toMs(row.tokens, 0) : 0,
      costUsd: row && row.costKnown === false ? null : (row ? Number(row.costUsd) || 0 : 0),
      costKnown: row ? row.costKnown !== false : true,
      requestCount: row ? toMs(row.requestCount, 0) : 0
    };
  });
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const requestCount = rows.reduce((sum, row) => sum + row.requestCount, 0);
  const costKnown = rows.every((row) => row.costKnown !== false);
  const totalCostUsd = costKnown
    ? rows.reduce((sum, row) => sum + (Number(row.costUsd) || 0), 0)
    : null;
  return {
    ...base,
    granularity,
    current: pickSnapshotCurrent(snapshotScopes),
    usageBuckets: rows,
    usageSummary: {
      bucketCount: rows.length,
      totalTokens,
      totalCostUsd,
      costKnown,
      requestCount,
      avgTokensPerBucket: rows.length > 0 ? Math.round(totalTokens / rows.length) : null,
      avgCostUsdPerBucket: costKnown && rows.length > 0 ? totalCostUsd / rows.length : null
    },
    emptyReason: rows.some((row) => row.tokens > 0 || row.requestCount > 0)
      ? null
      : 'no_usage_in_range'
  };
}

/**
 * @param {object} options
 * @param {object} options.fs
 * @param {string} options.aiHomeDir
 * @param {string} options.accountRef
 * @param {number} [options.windowMinutes] 缺省=第一个可用维度
 * @param {string} [options.quotaKey]      缺省=该维度第一个 scope
 * @param {number} [options.rangeDays]
 * @param {number} [options.toMs]
 * @param {Array}  [options.snapshotScopes] 当前快照里的额度条目（路由侧投影）
 * @param {Function} [options.queryWindowUsage] 注入的窗口用量聚合（model-usage-store）
 */
function buildAccountQuotaStats(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = text(options.aiHomeDir);
  const accountRef = text(options.accountRef);
  const rangeDays = clampRangeDays(options.rangeDays);
  const toMsFinal = toMs(options.toMs, Date.now()) || Date.now();
  const rangeFromMs = toMsFinal - rangeDays * DAY_MS;
  const snapshotScopes = Array.isArray(options.snapshotScopes) ? options.snapshotScopes : [];
  const queryWindowUsage = typeof options.queryWindowUsage === 'function'
    ? options.queryWindowUsage
    : null;

  const scopeIndex = aiHomeDir && accountRef
    ? listQuotaWindowScopeIndex(fs, aiHomeDir, accountRef)
    : [];
  const eventScopeIndex = aiHomeDir && accountRef
    ? listAccountQuotaResetEventScopeIndex(fs, aiHomeDir, accountRef)
    : [];
  // 维度来源：账号证据优先，没有证据才问 provider 声明的泛范围（见策略模块）。
  const resolvedWindows = resolveQuotaStatsWindows({
    provider: text(options.provider),
    observedWindows: [
      ...scopeIndex.map((row) => row && row.windowMinutes),
      ...eventScopeIndex.map((row) => row && row.windowMinutes)
    ],
    snapshotWindows: snapshotScopes.map((row) => row && row.windowMinutes)
  });
  const dimensions = buildDimensions({
    scopeIndex,
    eventScopeIndex,
    snapshotScopes,
    declaredWindows: resolvedWindows.windows
  });

  const dimension = pickDimension(dimensions, options.windowMinutes);
  const scope = pickScope(dimension, options.quotaKey);

  // 未指定粒度时按账号能力自动选：有窗口明细就看窗口，否则直接给日统计（而不是空页）。
  const requestedGranularity = text(options.granularity);
  const granularity = USAGE_GRANULARITIES.has(requestedGranularity)
    || requestedGranularity === GRANULARITY_WINDOW
    ? requestedGranularity
    : (dimensions.some((item) => item.available) ? GRANULARITY_WINDOW : GRANULARITY_DAY);

  const result = {
    generatedAtMs: Date.now(),
    range: { fromMs: rangeFromMs, toMs: toMsFinal, rangeDays },
    granularity,
    dimensions,
    windowMinutes: dimension ? dimension.windowMinutes : 0,
    scope,
    current: null,
    summary: emptySummary(),
    usageBuckets: [],
    usageSummary: null,
    windows: [],
    emptyReason: null
  };

  if (USAGE_GRANULARITIES.has(granularity)) {
    return buildUsageStats({
      base: result,
      granularity,
      accountRef,
      rangeFromMs,
      toMsFinal,
      snapshotScopes,
      queryWindowUsage
    });
  }

  if (!dimension || !dimension.available || !scope) {
    // API Key / 积分型额度没有窗口期：仍然把最新快照的剩余额度返回给页面，
    // 由前端渲染「当前额度」，而不是只给一个 dimension_unavailable 的空态。
    const snapshotCurrent = pickSnapshotCurrent(snapshotScopes);
    return {
      ...result,
      current: snapshotCurrent,
      emptyReason: snapshotCurrent ? 'snapshot_only' : 'dimension_unavailable'
    };
  }

  const windowMs = dimension.windowMinutes * 60 * 1000;
  // 往前多取一个窗口：跨越范围起点的窗口也要能算出完整边界。
  const samples = listQuotaWindowSamples(fs, aiHomeDir, accountRef, {
    quotaKey: scope.quotaKey,
    windowMinutes: dimension.windowMinutes,
    fromMs: rangeFromMs - windowMs,
    toMs: toMsFinal
  });
  const resetEvents = listAccountQuotaResetEventsInRange(fs, aiHomeDir, accountRef, {
    fromMs: rangeFromMs - windowMs,
    toMs: toMsFinal,
    quotaKey: scope.quotaKey
  });
  const ledger = safeReadLedger(fs, aiHomeDir, accountRef);

  const { windows } = buildQuotaWindows({
    samples,
    resetEvents,
    ledger,
    windowMinutes: dimension.windowMinutes,
    quotaKey: scope.quotaKey,
    rangeFromMs,
    rangeToMs: toMsFinal,
    nowMs: toMsFinal
  });

  const usage = queryWindowUsage
    ? queryWindowUsage({
      accountRef,
      windows: windows.map((window) => ({
        index: window.index,
        startMs: window.anchorAtMs,
        endMs: Math.min(window.closeAtMs, toMsFinal)
      }))
    })
    : [];
  const usageByIndex = new Map(
    (Array.isArray(usage) ? usage : []).map((row) => [toMs(row.index, 0), row])
  );
  const merged = windows.map((window) => {
    const row = usageByIndex.get(window.index);
    return {
      ...window,
      tokens: row ? toMs(row.tokens, 0) : 0,
      costUsd: row && row.costKnown === false ? null : (row ? Number(row.costUsd) || 0 : 0),
      costKnown: row ? row.costKnown !== false : true,
      requestCount: row ? toMs(row.requestCount, 0) : 0
    };
  });

  const current = pickCurrent({
    samples,
    ledger,
    dimension,
    snapshotScopes,
    quotaKey: scope.quotaKey
  });
  const summary = summarizeWindows(merged);
  const emptyReason = merged.length > 0
    ? null
    : (samples.length === 0 && resetEvents.length === 0 ? 'no_samples' : 'no_windows_in_range');

  // 自动模式（请求未指定粒度）下，如果这个账号在范围内根本没有窗口明细，
  // 直接给日统计 —— 页面不该默认落在一个空窗口图上。用户仍可手动切回「窗口」。
  if (!requestedGranularity && merged.length === 0 && samples.length === 0) {
    return buildUsageStats({
      base: result,
      granularity: GRANULARITY_DAY,
      accountRef,
      rangeFromMs,
      toMsFinal,
      snapshotScopes,
      queryWindowUsage
    });
  }

  return { ...result, current, summary, windows: merged, emptyReason };
}

module.exports = {
  DAY_MS,
  MIN_RANGE_DAYS,
  MAX_RANGE_DAYS,
  DEFAULT_RANGE_DAYS,
  GRANULARITY_WINDOW,
  GRANULARITY_DAY,
  GRANULARITY_WEEK,
  buildDimensions,
  buildUsageBuckets,
  formatWindowLabel,
  normalizeScopeLabel,
  summarizeWindows,
  buildAccountQuotaStats
};
