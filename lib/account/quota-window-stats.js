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
  QUOTA_WINDOW_DIMENSIONS,
  buildQuotaWindows
} = require('./quota-window-reconstruction');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RANGE_DAYS = 1;
const MAX_RANGE_DAYS = 90;
const DEFAULT_RANGE_DAYS = 30;

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

function roundPct(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function clampRangeDays(value) {
  const days = toMs(value, DEFAULT_RANGE_DAYS);
  if (!days) return DEFAULT_RANGE_DAYS;
  return Math.max(MIN_RANGE_DAYS, Math.min(MAX_RANGE_DAYS, days));
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
      label: text(row.windowLabel) || label,
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
      label: text(row.windowLabel) || label,
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
      label: text(row.label) || label,
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

function buildDimensions(input) {
  const minutes = collectWindowMinutes(input);
  if (minutes.length === 0) {
    return QUOTA_WINDOW_DIMENSIONS.map((dimension) => buildDimension(dimension.windowMinutes, input));
  }
  return minutes.map((windowMinutes) => buildDimension(windowMinutes, input));
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
  const dimensions = buildDimensions({ scopeIndex, eventScopeIndex, snapshotScopes });

  const dimension = pickDimension(dimensions, options.windowMinutes);
  const scope = pickScope(dimension, options.quotaKey);

  const result = {
    generatedAtMs: Date.now(),
    range: { fromMs: rangeFromMs, toMs: toMsFinal, rangeDays },
    dimensions,
    windowMinutes: dimension ? dimension.windowMinutes : 0,
    scope,
    current: null,
    summary: emptySummary(),
    windows: [],
    emptyReason: null
  };

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

  return { ...result, current, summary, windows: merged, emptyReason };
}

module.exports = {
  DAY_MS,
  MIN_RANGE_DAYS,
  MAX_RANGE_DAYS,
  DEFAULT_RANGE_DAYS,
  buildDimensions,
  formatWindowLabel,
  summarizeWindows,
  buildAccountQuotaStats
};
