'use strict';

// 额度窗口重建：把「采样 + 重置事件 + 当前窗口账本」翻成一段连续的窗口列表。
//
// 依据的是 window-ledger.js 里已经固化的 F1–F4：
//   F1 窗口由「关闭后的第一个真实请求」锚定，reset = 锚点 + 窗口时长；
//   F2 窗口内的请求不移动锚点 → 同一个 resetAtMs 就代表同一个窗口；
//   F3 窗口关闭且空闲时，上游报 reset ≈ 读取时刻 + 窗口时长（幻影），必须剔除；
//   F4 只有真实请求会开窗。
//
// 所以「一个窗口」的天然主键是 expectedResetAtMs：锚点永远由 reset - 时长反推。
// 本文件是纯函数：不读盘、不发请求、不含 provider 名。
//
// 本文件只回答「有哪些窗口、每个窗口的额度消耗是多少」；token/成本由
// lib/usage/quota-window-stats.js 用 model_usage_records 按窗口区间再聚合一次。

const {
  MS_PER_MINUTE,
  isPhantomSample
} = require('../server/window-activation/window-ledger');

const QUOTA_WINDOW_DIMENSIONS = Object.freeze([
  Object.freeze({ windowMinutes: 300, label: '5h' }),
  Object.freeze({ windowMinutes: 10080, label: '7days' }),
  Object.freeze({ windowMinutes: 43200, label: '30days' })
]);

// cycle_rollover 的 occurredAt 就是计划关窗时刻（秒级精确），2 分钟足够吸收落库延迟。
const RESET_MATCH_TOLERANCE_MS = 2 * 60 * 1000;
// 锚点后 10 分钟内没有样本 → 起点是估的（真实消耗可能已经发生了一部分）。
const START_COVERAGE_TOLERANCE_MS = 10 * 60 * 1000;
// 关窗时刻附近 15 分钟内没有样本 → 末端是估的。
const END_COVERAGE_TOLERANCE_MS = 15 * 60 * 1000;
// 90 天 / 5h ≈ 432 个窗口，500 足够覆盖最大查询范围。
const MAX_WINDOWS = 500;

function toMs(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

// 只把真正的数值当成剩余额度。SQLite 的 NULL 会读成 null，
// 而 Number(null) === 0 —— 直接转换会把「未知」算成「剩余 0%（即消耗 100%）」。
function finitePct(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getQuotaWindowDimension(windowMinutes) {
  const minutes = toMs(windowMinutes, 0);
  return QUOTA_WINDOW_DIMENSIONS.find((dimension) => dimension.windowMinutes === minutes) || null;
}

/**
 * 事件能不能归到当前维度。
 *
 * 老事件可能没有 window_minutes：这时只有 quotaKey 也能定位维度（同一个 quotaKey
 * 不会同时对应 5h 和 7d）。两者都没有的事件无法归维，直接跳过 —— 宁可少一个窗口，
 * 也不要把 5h 的重置画进 7 天图。
 */
function eventMatchesDimension(event, windowMinutes, quotaKey) {
  const eventQuotaKey = text(event && event.quotaKey);
  if (quotaKey && eventQuotaKey && eventQuotaKey !== quotaKey) return false;
  const eventWindowMinutes = toMs(event && event.windowMinutes, 0);
  if (eventWindowMinutes > 0) return eventWindowMinutes === windowMinutes;
  return Boolean(quotaKey && eventQuotaKey && eventQuotaKey === quotaKey);
}

function findGroup(groups, predicate) {
  for (const group of groups.values()) {
    if (predicate(group)) return group;
  }
  return null;
}

function createGroup(key, closeAtMs, windowMs, extra = {}) {
  return {
    key,
    closeAtMs,
    anchorAtMs: closeAtMs - windowMs,
    samples: [],
    phantomCount: 0,
    event: null,
    truncated: false,
    ledgerBacked: false,
    ledgerAnchorEstimated: false,
    anchorEstimated: false,
    approximateClose: false,
    ...extra
  };
}

/**
 * @param {object} input
 * @param {Array} input.samples          account_quota_window_samples 行（ASC）
 * @param {Array} input.resetEvents      account_quota_reset_events 行（ASC）
 * @param {object|null} input.ledger     readWindowActivationState() 的归一化状态
 * @param {number} input.windowMinutes   300 / 10080 / 43200
 * @param {string} [input.quotaKey]      只统计某个 quotaKey（为空则全部）
 * @param {number} input.rangeFromMs
 * @param {number} input.rangeToMs
 * @param {number} input.nowMs
 * @returns {{windows: Array<object>, droppedPhantomGroups: number}}
 */
function buildQuotaWindows(input = {}) {
  const windowMinutes = toMs(input.windowMinutes, 0);
  if (!windowMinutes) return { windows: [], droppedPhantomGroups: 0 };

  const windowMs = windowMinutes * MS_PER_MINUTE;
  const quotaKey = text(input.quotaKey);
  const nowMs = toMs(input.nowMs, Date.now());
  const rangeToMs = toMs(input.rangeToMs, nowMs);
  const rangeFromMs = toMs(input.rangeFromMs, rangeToMs - 30 * 24 * 60 * 60 * 1000);
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const resetEvents = Array.isArray(input.resetEvents) ? input.resetEvents : [];
  const ledger = input.ledger && typeof input.ledger === 'object' ? input.ledger : null;

  const groups = new Map();
  let droppedPhantomGroups = 0;

  // ---- 1. 按 expectedResetAtMs 分组，组内剔除幻影 ----
  for (const sample of samples) {
    if (toMs(sample && sample.windowMinutes, 0) !== windowMinutes) continue;
    const sampleQuotaKey = text(sample && sample.quotaKey);
    if (quotaKey && sampleQuotaKey && sampleQuotaKey !== quotaKey) continue;
    const closeAtMs = toMs(sample && sample.expectedResetAtMs, 0);
    const capturedAtMs = toMs(sample && sample.capturedAtMs, 0);
    if (!closeAtMs || !capturedAtMs) continue;

    const key = `w:${closeAtMs}`;
    let group = groups.get(key);
    if (!group) {
      group = createGroup(key, closeAtMs, windowMs);
      groups.set(key, group);
    }
    if (isPhantomSample(capturedAtMs, closeAtMs, windowMinutes)) {
      group.phantomCount += 1;
      continue;
    }
    group.samples.push(sample);
  }

  // 整组都是幻影 = 那段时间根本没有窗口（F3），不能造出「读取时刻开始」的假窗口。
  for (const [key, group] of groups) {
    if (group.samples.length > 0) continue;
    groups.delete(key);
    droppedPhantomGroups += 1;
  }

  // ---- 2. 挂重置事件 ----
  const ensureResetOnlyGroup = (event, occurredAtMs) => {
    const key = `e:${event.id != null ? event.id : occurredAtMs}`;
    const existing = groups.get(key);
    if (existing) return existing;
    const isReplenishment = text(event.eventKind) === 'replenishment';
    const group = createGroup(key, occurredAtMs, windowMs, {
      event,
      // replenishment 的 occurredAt 是「发现时刻」，真实关窗可能更早一个采集间隔；
      // cycle_rollover 的 occurredAt 是计划关窗时刻，锚点因此是精确的。
      anchorEstimated: isReplenishment,
      approximateClose: isReplenishment
    });
    groups.set(key, group);
    return group;
  };

  for (const event of resetEvents) {
    if (!eventMatchesDimension(event, windowMinutes, quotaKey)) continue;
    const occurredAtMs = toMs(event.occurredAtMs, 0) || toMs(event.detectedAtMs, 0);
    if (!occurredAtMs) continue;

    const exact = findGroup(groups, (group) => (
      Math.abs(group.closeAtMs - occurredAtMs) <= RESET_MATCH_TOLERANCE_MS
    ));
    if (exact) {
      if (!exact.event) exact.event = event;
      continue;
    }

    const containing = findGroup(groups, (group) => (
      group.anchorAtMs <= occurredAtMs && occurredAtMs < group.closeAtMs
    ));
    if (containing) {
      if (!containing.event) containing.event = event;
      if (text(event.eventKind) === 'replenishment') {
        // 提前回血：旧窗口在回血时刻结束，新窗口等下一个真实请求再锚定。
        containing.truncated = true;
        containing.approximateClose = true;
      }
      continue;
    }

    ensureResetOnlyGroup(event, occurredAtMs);
  }

  // ---- 3. 合并当前窗口账本 ----
  // 只合并同一窗口长度的账本：账本只有一份（通常是 5h），切到 7 天维度时必须跳过，
  // 否则会把 5h 的活跃窗口错画进 7 天图。
  if (ledger) {
    const ledgerWindowMinutes = toMs(ledger.windowMinutes, 0);
    const ledgerCloseAtMs = toMs(ledger.windowCloseAtMs, 0);
    if (ledgerWindowMinutes === windowMinutes && ledgerCloseAtMs > 0) {
      const match = findGroup(groups, (group) => (
        Math.abs(group.closeAtMs - ledgerCloseAtMs) <= RESET_MATCH_TOLERANCE_MS
      ));
      if (match) {
        match.ledgerBacked = true;
        match.ledgerAnchorEstimated = text(ledger.windowSource) === 'activity';
      } else if (ledgerCloseAtMs > nowMs) {
        // 仍在运行中的窗口即使一条样本都没有也要出现；
        // 已关闭的账本窗口必须有样本或事件背书，不凭空造窗。
        const group = createGroup('l:ledger', ledgerCloseAtMs, windowMs, {
          ledgerBacked: true,
          ledgerAnchorEstimated: text(ledger.windowSource) === 'activity'
        });
        const ledgerAnchorAtMs = toMs(ledger.windowAnchorAtMs, 0);
        if (ledgerAnchorAtMs > 0) group.anchorAtMs = ledgerAnchorAtMs;
        groups.set(group.key, group);
      }
    }
  }

  // ---- 4. 逐窗计算 ----
  const rows = [];
  for (const group of groups.values()) {
    const occurredAtMs = group.event ? toMs(group.event.occurredAtMs, 0) : 0;
    const closeAtMs = group.truncated && occurredAtMs > 0 ? occurredAtMs : group.closeAtMs;
    const live = closeAtMs > nowMs;

    const realSamples = group.samples
      .slice()
      .sort((left, right) => toMs(left.capturedAtMs, 0) - toMs(right.capturedAtMs, 0));
    const first = realSamples[0] || null;
    const last = realSamples[realSamples.length - 1] || null;

    const samplePcts = realSamples
      .map((sample) => finitePct(sample.remainingPct))
      .filter((value) => value !== null);
    const eventEndPct = group.event ? finitePct(group.event.previousRemainingPct) : null;
    const lastPct = last ? finitePct(last.remainingPct) : null;
    const remainingStartPct = first ? finitePct(first.remainingPct) : null;
    // 事件里的 previousRemainingPct 是重置前最后一次观测，比我们自己的最后一条样本更新。
    const remainingEndPct = eventEndPct !== null ? eventEndPct : lastPct;
    const allPcts = eventEndPct !== null ? [...samplePcts, eventEndPct] : samplePcts;
    const remainingMinPct = allPcts.length > 0 ? Math.min(...allPcts) : null;

    // 新窗口的起点必然是满额：消耗 = 100 - 窗口末剩余。
    // 不能拿「第一个观测样本」当起点，否则晚采样会把消耗算少。
    const consumedPct = remainingEndPct === null
      ? null
      : clamp(100 - remainingEndPct, 0, 100);
    const peakConsumedPct = remainingMinPct === null
      ? null
      : clamp(100 - remainingMinPct, 0, 100);

    const startEstimated = group.anchorEstimated
      || !first
      || (toMs(first.capturedAtMs, 0) - group.anchorAtMs) > START_COVERAGE_TOLERANCE_MS;
    const endCovered = group.event
      ? true
      : (live
        ? Boolean(last) && (nowMs - toMs(last.capturedAtMs, 0)) <= END_COVERAGE_TOLERANCE_MS
        : Boolean(last) && Math.abs(closeAtMs - toMs(last.capturedAtMs, 0)) <= END_COVERAGE_TOLERANCE_MS);

    let source;
    if (realSamples.length === 0) source = live ? 'live' : 'reset';
    else if (startEstimated || !endCovered) source = 'reconstructed';
    else source = 'sample';

    let confidence;
    if (realSamples.length === 0) confidence = 'low';
    else if (realSamples.length >= 3 && !startEstimated && endCovered) confidence = 'high';
    else confidence = 'medium';

    rows.push({
      anchorAtMs: group.anchorAtMs,
      closeAtMs,
      scheduledCloseAtMs: group.closeAtMs,
      truncated: group.truncated,
      live,
      remainingStartPct,
      remainingEndPct,
      remainingMinPct,
      consumedPct,
      peakConsumedPct,
      startEstimated,
      sampleCount: realSamples.length,
      observedFromMs: first ? toMs(first.capturedAtMs, 0) : 0,
      observedToMs: last ? toMs(last.capturedAtMs, 0) : 0,
      source,
      confidence,
      resetKind: group.event ? text(group.event.eventKind) : '',
      classification: group.event ? text(group.event.classification) : '',
      planType: (group.event && text(group.event.currentPlanType))
        || (last && text(last.planType))
        || (first && text(first.planType))
        || '',
      approximateClose: group.approximateClose,
      anchorEstimated: group.anchorEstimated || group.ledgerAnchorEstimated
    });
  }

  // ---- 5. 排序 / 裁剪 / 编号 ----
  const clipped = rows
    .filter((window) => window.closeAtMs > rangeFromMs && window.anchorAtMs < rangeToMs)
    .sort((left, right) => left.anchorAtMs - right.anchorAtMs)
    .slice(-MAX_WINDOWS)
    .map((window, index) => ({ ...window, index }));

  return { windows: clipped, droppedPhantomGroups };
}

module.exports = {
  QUOTA_WINDOW_DIMENSIONS,
  RESET_MATCH_TOLERANCE_MS,
  START_COVERAGE_TOLERANCE_MS,
  END_COVERAGE_TOLERANCE_MS,
  MAX_WINDOWS,
  getQuotaWindowDimension,
  buildQuotaWindows
};
