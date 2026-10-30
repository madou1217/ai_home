'use strict';

const { listModelDiscoveryAccounts, listModelDiscoveryProviders } = require('./model-discovery-accounts');
const { ensureWebUiModelsCacheLoaded, refreshWebUiModelsCache } = require('./webui-model-cache');
const {
  listAccountModelCacheRefs,
  shouldProbeAccountModels
} = require('./provider-model-discovery');

const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const ACTIVE_MIN_INTERVAL_MS = 45 * 1000;
const ACTIVE_MAX_INTERVAL_MS = 3 * 60 * 1000;
const IDLE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_MAX_INTERVAL_MS = 60 * 60 * 1000;
const ACCOUNT_STALE_MS = 6 * 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 10 * 60 * 1000;
const MANUAL_NUDGE_MIN_DELAY_MS = 750;
const MANUAL_NUDGE_MAX_DELAY_MS = 2500;
// 每个 tick 最多探测几个账号。冷账号（从未探测）串行推进太慢：原先一个 tick 只探一个，
// 再叠加 5–60 分钟的 idle 间隔，新账号可能几个小时都显示「待探测」。
// 3 个是「快速补课」与「不把上游模型接口打爆」之间的折中；失败账号有 10 分钟退避。
const PROBE_BATCH_SIZE = 3;
// 还有冷账号（从未探测 / 目录为空且已过期）没补完时，下一轮的最短间隔。
// 与用户是否打开 WebUI 无关：新导入/启用的账号不该等到下次打开页面才探测。
const COLD_BACKLOG_MIN_DELAY_MS = 60 * 1000;
const COLD_BACKLOG_MAX_DELAY_MS = 120 * 1000;
// 事件优先级请求的有效期：账号启用/导入/凭据变更后插队探测，过期后回到正常排序。
const PRIORITY_TTL_MS = 10 * 60 * 1000;

function getSchedulerState(state) {
  if (!state.webUiModelRefreshScheduler || typeof state.webUiModelRefreshScheduler !== 'object') {
    state.webUiModelRefreshScheduler = {
      timer: null,
      running: false,
      lastActivityAt: 0,
      nextDelayMs: ACTIVE_MIN_INTERVAL_MS,
      cursor: 0,
      // accountRef → 请求时刻：启用/导入/凭据变更的事件插队标记。
      priority: {}
    };
  }
  return state.webUiModelRefreshScheduler;
}

function touchWebUiModelActivity(state) {
  if (!state) return;
  getSchedulerState(state).lastActivityAt = Date.now();
}

function isUserActive(scheduler, now = Date.now()) {
  return now - Number(scheduler.lastActivityAt || 0) <= ACTIVE_WINDOW_MS;
}

function clampDelay(value, active) {
  const min = active ? ACTIVE_MIN_INTERVAL_MS : IDLE_MIN_INTERVAL_MS;
  const max = active ? ACTIVE_MAX_INTERVAL_MS : IDLE_MAX_INTERVAL_MS;
  return Math.max(min, Math.min(max, Number(value) || min));
}

function randomDelay(min, max) {
  const low = Math.max(1, Number(min) || 1);
  const high = Math.max(low, Number(max) || low);
  return Math.round(low + Math.random() * (high - low));
}

function jitterDelay(value, active) {
  const base = clampDelay(value, active);
  return clampDelay(randomDelay(base * 0.8, base * 1.2), active);
}

function getAccountCacheSnapshot(cache, provider, account) {
  const byAccount = cache && cache.byAccount && typeof cache.byAccount === 'object' ? cache.byAccount : {};
  const errorsByAccount = cache && cache.errorsByAccount && typeof cache.errorsByAccount === 'object' ? cache.errorsByAccount : {};
  const accountUpdatedAt = cache && cache.accountUpdatedAt && typeof cache.accountUpdatedAt === 'object'
    ? cache.accountUpdatedAt
    : {};
  let models = null;
  let error = '';
  let updatedAt = 0;
  for (const key of listAccountModelCacheRefs(provider, account)) {
    if (Array.isArray(byAccount[key]) && !models) models = byAccount[key];
    if (!error && errorsByAccount[key]) error = String(errorsByAccount[key] || '');
    updatedAt = Math.max(updatedAt, Number(accountUpdatedAt[key] || 0));
  }
  return { models, error, updatedAt };
}

// 候选集：需要（重新）探测的账号，按「插队 > 从未探测 > 探测失败 > 最久未探测」排序。
//
// 「探测过」的判定用 accountUpdatedAt（探测时间戳），不是「有没有模型」：
// 成功但目录为空的账号同样算探测过——模型很少变，空目录在 stale 周期内不该反复打上游。
// 之前用 `!models` 判定，空目录每次 tick 都是候选，冷热不分，热闹的 provider 永远占着队首。
function listProbeCandidates(state, now = Date.now(), deps = null) {
  const cache = state && state.webUiModelsCache || {};
  const scheduler = getSchedulerState(state);
  const priority = scheduler.priority && typeof scheduler.priority === 'object' ? scheduler.priority : {};
  const isPriority = (accountRef) => {
    const at = Number(priority[accountRef] || 0);
    return at > 0 && now - at <= PRIORITY_TTL_MS;
  };
  const providers = listModelDiscoveryProviders(state, deps).sort();
  const items = [];
  providers.forEach((provider) => {
    listModelDiscoveryAccounts(state, provider, deps).forEach((account) => {
      if (!shouldProbeAccountModels(provider, account)) return;
      const snapshot = getAccountCacheSnapshot(cache, provider, account);
      const accountRef = listAccountModelCacheRefs(provider, account)[0] || '';
      const missing = !snapshot.models;
      const age = now - Number(snapshot.updatedAt || 0);
      const priorityHit = isPriority(accountRef);
      if (!priorityHit) {
        // 失败：退避 10 分钟，避免一个坏账号占满每个 tick。
        if (snapshot.error && age < ERROR_BACKOFF_MS) return;
        // 探测过（含成功的空目录）：stale 周期内不重探。刷新有手动按钮与生命周期事件
        // 两个入口，不需要后台反复扫。
        if (!snapshot.error && Number(snapshot.updatedAt || 0) > 0 && age < ACCOUNT_STALE_MS) return;
      }
      items.push({ provider, account, accountRef, missing, error: Boolean(snapshot.error), age, priority: priorityHit });
    });
  });
  return items.sort((left, right) => (
    Number(right.priority) - Number(left.priority)
    || Number(right.missing) - Number(left.missing)
    || Number(right.error) - Number(left.error)
    || Number(right.age) - Number(left.age)
  ));
}

/** 本 tick 要探测的账号批次（冷账号优先，最多 PROBE_BATCH_SIZE 个）。 */
function pickProbeCandidates(state, scheduler, now = Date.now(), deps = null, limit = PROBE_BATCH_SIZE) {
  const candidates = listProbeCandidates(state, now, deps);
  return candidates.slice(0, Math.max(1, Number(limit) || PROBE_BATCH_SIZE));
}

function pickProbeCandidate(state, scheduler, now = Date.now(), deps = null) {
  return pickProbeCandidates(state, scheduler, now, deps, 1)[0] || null;
}

/** 事件插队：账号启用/导入/凭据变更后，让它进入下一批探测。 */
function requestWebUiModelProbe(state, provider, accountRef, now = Date.now()) {
  if (!state) return false;
  const ref = String(accountRef || '').trim();
  if (!ref) return false;
  const scheduler = getSchedulerState(state);
  if (!scheduler.priority || typeof scheduler.priority !== 'object') scheduler.priority = {};
  // 顺手清理过期标记，避免长期运行的进程里无限增长。
  for (const [key, value] of Object.entries(scheduler.priority)) {
    if (!(Number(value) > 0) || now - Number(value) > PRIORITY_TTL_MS) delete scheduler.priority[key];
  }
  scheduler.priority[ref] = now;
  return true;
}

function buildScheduledAccountScope(candidate) {
  const provider = String(candidate && candidate.provider || '').trim();
  const account = candidate && candidate.account;
  const accountRef = provider && account ? listAccountModelCacheRefs(provider, account)[0] || '' : '';
  return { accountRef };
}

function nextDelayAfterRun(scheduler, ok, hasBacklog = false) {
  const active = isUserActive(scheduler);
  const previous = Number(scheduler.nextDelayMs || 0);
  // 队列里还有待探测账号（从未探测 / 插队 / 过期 / 错误退避到期）：用短间隔连续补课，
  // 与用户是否在看 WebUI 无关。补完后立刻回到「用户活跃 45s–3min / 空闲 5–60min」。
  // 注意必须按「还有没有候选」而不是「有没有冷账号」判断：大账号池里过期账号永远轮不到
  // 队首时，按冷账号判断会让调度器退回 5–60 分钟的 idle 节奏 → 后排账号永远等不到探测。
  if (ok && hasBacklog) return randomDelay(COLD_BACKLOG_MIN_DELAY_MS, COLD_BACKLOG_MAX_DELAY_MS);
  if (ok && active) return randomDelay(ACTIVE_MIN_INTERVAL_MS, ACTIVE_MAX_INTERVAL_MS);
  if (ok) return jitterDelay(Math.max(IDLE_MIN_INTERVAL_MS, previous * 1.5), false);
  return jitterDelay(Math.max(ERROR_BACKOFF_MS, previous * 2), active);
}

function scheduleNextModelRefresh(ctx, delayMs, options = {}) {
  const scheduler = getSchedulerState(ctx.state);
  if (scheduler.timer && options.force !== true) return;
  if (scheduler.timer) clearTimeout(scheduler.timer);
  scheduler.nextDelayMs = Math.max(1, Math.round(Number(delayMs) || 1));
  scheduler.timer = setTimeout(() => {
    scheduler.timer = null;
    runScheduledModelRefresh(ctx).catch(() => {});
  }, scheduler.nextDelayMs);
  if (scheduler.timer && typeof scheduler.timer.unref === 'function') scheduler.timer.unref();
}

async function runScheduledModelRefresh(ctx) {
  const scheduler = getSchedulerState(ctx.state);
  if (scheduler.running) return;
  scheduler.running = true;
  let ok = false;
  let hasBacklog = false;
  try {
    const fsImpl = ctx.fs || ctx.deps && ctx.deps.fs;
    const aiHomeDir = ctx.aiHomeDir || ctx.deps && ctx.deps.aiHomeDir;
    const discoveryDeps = { fs: fsImpl, aiHomeDir };
    // 一批最多 PROBE_BATCH_SIZE 个，冷账号优先。每个账号单独 scope 探测：
    // 一个账号超时/失败不会拖累同批其它账号，也不会把别人的目录覆盖成空。
    const candidates = pickProbeCandidates(ctx.state, scheduler, Date.now(), discoveryDeps, PROBE_BATCH_SIZE);
    for (const candidate of candidates) {
      await refreshWebUiModelsCache(ctx.state, ctx.options || {}, {
        fs: fsImpl,
        aiHomeDir,
        fetchModelsForAccount: ctx.deps && ctx.deps.fetchModelsForAccount,
        accountScope: buildScheduledAccountScope(candidate)
      });
    }
    ok = true;
    hasBacklog = listProbeCandidates(ctx.state, scheduler, Date.now(), discoveryDeps).length > 0;
  } finally {
    scheduler.running = false;
    scheduleNextModelRefresh(ctx, nextDelayAfterRun(scheduler, ok, hasBacklog));
  }
}

function ensureWebUiModelRefreshScheduler(ctx) {
  if (!ctx || !ctx.state) return;
  const scheduler = getSchedulerState(ctx.state);
  if (scheduler.timer || scheduler.running) return;
  const fsImpl = ctx.fs || ctx.deps && ctx.deps.fs;
  const aiHomeDir = ctx.aiHomeDir || ctx.deps && ctx.deps.aiHomeDir;
  const discoveryDeps = { fs: fsImpl, aiHomeDir };
  // 进程刚启动时内存 cache 还是空的。不先读持久快照的话，所有账号都会被当成「从未探测」，
  // 每次重启都会触发一轮全量补探；反之若照旧睡 5–10 分钟，真正没探测过的账号又得干等。
  try {
    ensureWebUiModelsCacheLoaded(ctx.state, discoveryDeps);
  } catch (_error) {}
  // 启动即补课：有候选账号（冷/过期/插队）就几秒内开工，而不是等下一次 idle 间隔。
  if (listProbeCandidates(ctx.state, Date.now(), discoveryDeps).length > 0) {
    scheduleNextModelRefresh(ctx, randomDelay(3000, 8000));
    return;
  }
  const delay = isUserActive(scheduler)
    ? randomDelay(ACTIVE_MIN_INTERVAL_MS, ACTIVE_MAX_INTERVAL_MS)
    : randomDelay(IDLE_MIN_INTERVAL_MS, IDLE_MIN_INTERVAL_MS * 2);
  scheduleNextModelRefresh(ctx, delay);
}

function triggerWebUiModelRefreshSoon(ctx) {
  if (!ctx || !ctx.state) return;
  touchWebUiModelActivity(ctx.state);
  scheduleNextModelRefresh(ctx, randomDelay(MANUAL_NUDGE_MIN_DELAY_MS, MANUAL_NUDGE_MAX_DELAY_MS), { force: true });
}

module.exports = {
  ensureWebUiModelRefreshScheduler,
  getSchedulerState,
  listProbeCandidates,
  pickProbeCandidates,
  requestWebUiModelProbe,
  triggerWebUiModelRefreshSoon,
  touchWebUiModelActivity,
  __private: {
    getAccountCacheSnapshot,
    buildScheduledAccountScope,
    nextDelayAfterRun,
    pickProbeCandidate
  }
};
