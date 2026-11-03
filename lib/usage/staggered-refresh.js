'use strict';

// 后台刷新的统一错峰策略。
//
// 以前的做法是「到点了所有账号一起扫」，账号一多、机器一小就扛不住，于是只能
// 整个关掉（小内存机器直接禁用用量扫描，账号统计跟着停更）。这里换成：
//   - 活跃账号（最近有请求/会话）按短周期刷新；
//   - 静默账号按长周期刷新；
//   - 每个周期都带随机抖动，账号之间自然错开，不会同一秒一起触发；
//   - 每一轮最多处理 batchSize 个账号，剩下的顺延到下一轮。
// 所有需要「定时把每个账号刷一遍」的后台任务都应该用这一套，而不是各写一个 setInterval。

const ONE_MINUTE_MS = 60 * 1000;

const DEFAULT_STAGGERED_REFRESH_POLICY = Object.freeze({
  // 最近这么久内有活动的账号算活跃。
  activeWindowMs: 15 * ONE_MINUTE_MS,
  // 活跃账号：3–6 分钟刷新一次。
  activeMinMs: 3 * ONE_MINUTE_MS,
  activeMaxMs: 6 * ONE_MINUTE_MS,
  // 静默账号：30–60 分钟刷新一次。
  idleMinMs: 30 * ONE_MINUTE_MS,
  idleMaxMs: 60 * ONE_MINUTE_MS,
  // 每轮最多处理的账号数。
  batchSize: 4
});

function positiveMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeStaggeredRefreshPolicy(policy = {}) {
  const base = DEFAULT_STAGGERED_REFRESH_POLICY;
  const activeMinMs = positiveMs(policy.activeMinMs, base.activeMinMs);
  const idleMinMs = positiveMs(policy.idleMinMs, base.idleMinMs);
  return {
    activeWindowMs: positiveMs(policy.activeWindowMs, base.activeWindowMs),
    activeMinMs,
    activeMaxMs: Math.max(activeMinMs, positiveMs(policy.activeMaxMs, base.activeMaxMs)),
    idleMinMs,
    idleMaxMs: Math.max(idleMinMs, positiveMs(policy.idleMaxMs, base.idleMaxMs)),
    batchSize: Math.max(1, Math.floor(positiveMs(policy.batchSize, base.batchSize)))
  };
}

function randomBetween(min, max, random = Math.random) {
  if (max <= min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * 按账号记住「下次该刷新的时间」，每次刷新完重新抽一个带抖动的间隔。
 * 首次见到的账号也随机落在一个周期内，避免启动时全部同时到期。
 */
function createStaggeredRefreshPlanner(options = {}) {
  const policy = normalizeStaggeredRefreshPolicy(options.policy);
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const dueAtByKey = new Map();

  function isActive(lastActivityAt, at) {
    const last = Number(lastActivityAt) || 0;
    return last > 0 && at - last <= policy.activeWindowMs;
  }

  function nextIntervalMs(active) {
    return active
      ? randomBetween(policy.activeMinMs, policy.activeMaxMs, random)
      : randomBetween(policy.idleMinMs, policy.idleMaxMs, random);
  }

  /**
   * @param {Array<{key: string, lastActivityAt?: number, urgent?: boolean}>} candidates
   * @returns {Array} 本轮应该刷新的账号（已按「到期越久越靠前」排序并截断到 batchSize）
   */
  function pickDue(candidates = []) {
    const at = now();
    const due = [];
    const seen = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const key = String(candidate && candidate.key || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const active = isActive(candidate.lastActivityAt, at);
      let dueAt = dueAtByKey.get(key);
      if (dueAt == null) {
        // 第一次见到：随机散布在一个周期内，而不是立刻到期。
        dueAt = at + Math.floor(random() * nextIntervalMs(active));
        dueAtByKey.set(key, dueAt);
      } else if (active && dueAt - at > policy.activeMaxMs) {
        // 静默账号刚变活跃：把很远的到期时间拉回到活跃周期内。
        dueAt = at + randomBetween(0, policy.activeMaxMs, random);
        dueAtByKey.set(key, dueAt);
      }
      if (candidate.urgent === true || dueAt <= at) {
        due.push({ candidate, overdueMs: candidate.urgent === true ? Infinity : at - dueAt });
      }
    }
    // 不再出现的账号（被删/停用）不要一直占着表。
    for (const key of dueAtByKey.keys()) {
      if (!seen.has(key)) dueAtByKey.delete(key);
    }
    due.sort((a, b) => b.overdueMs - a.overdueMs);
    return due.slice(0, policy.batchSize).map((item) => item.candidate);
  }

  function markRefreshed(key, lastActivityAt) {
    const text = String(key || '').trim();
    if (!text) return;
    const at = now();
    dueAtByKey.set(text, at + nextIntervalMs(isActive(lastActivityAt, at)));
  }

  return {
    policy,
    pickDue,
    markRefreshed,
    nextIntervalMs,
    _dueAtByKey: dueAtByKey
  };
}

/**
 * 单个全局任务的错峰定时器：每次执行完再抽一个 [minMs, maxMs] 的随机间隔，
 * 取代固定 setInterval（多个任务、多台机器不会永远在同一相位一起跑）。
 */
function scheduleJitteredLoop(run, options = {}) {
  const minMs = positiveMs(options.minMs, ONE_MINUTE_MS);
  const maxMs = Math.max(minMs, positiveMs(options.maxMs, minMs));
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout;
  let timer = null;
  let stopped = false;

  function arm(delayMs) {
    if (stopped) return;
    timer = setTimeoutFn(async () => {
      timer = null;
      try {
        await run();
      } catch (_error) {
        // 调用方负责记录错误；循环不能因为一次失败就停掉。
      }
      arm(randomBetween(minMs, maxMs, random));
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  const firstDelayMs = options.firstDelayMs != null
    ? Math.max(0, Number(options.firstDelayMs) || 0)
    : randomBetween(minMs, maxMs, random);
  arm(firstDelayMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeoutFn(timer);
      timer = null;
    }
  };
}

module.exports = {
  DEFAULT_STAGGERED_REFRESH_POLICY,
  normalizeStaggeredRefreshPolicy,
  createStaggeredRefreshPlanner,
  scheduleJitteredLoop
};
