'use strict';

const { refreshWebUiModelsCache } = require('./webui-model-cache');
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

function getSchedulerState(state) {
  if (!state.webUiModelRefreshScheduler || typeof state.webUiModelRefreshScheduler !== 'object') {
    state.webUiModelRefreshScheduler = {
      timer: null,
      running: false,
      lastActivityAt: 0,
      nextDelayMs: ACTIVE_MIN_INTERVAL_MS,
      cursor: 0
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

function listProbeCandidates(state, now = Date.now()) {
  const accountsByProvider = state && state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
  const cache = state && state.webUiModelsCache || {};
  const providers = Object.keys(accountsByProvider).sort();
  const items = [];
  providers.forEach((provider) => {
    (Array.isArray(accountsByProvider[provider]) ? accountsByProvider[provider] : []).forEach((account) => {
      if (!shouldProbeAccountModels(provider, account)) return;
      const snapshot = getAccountCacheSnapshot(cache, provider, account);
      const missing = !snapshot.models;
      const age = now - Number(snapshot.updatedAt || 0);
      if (!missing && !snapshot.error && age < ACCOUNT_STALE_MS) return;
      items.push({ provider, account, missing, error: Boolean(snapshot.error), age });
    });
  });
  return items.sort((left, right) => (
    Number(right.missing) - Number(left.missing)
    || Number(right.error) - Number(left.error)
    || Number(right.age) - Number(left.age)
  ));
}

function pickProbeCandidate(state, scheduler, now = Date.now()) {
  const candidates = listProbeCandidates(state, now);
  if (candidates.length < 1) return null;
  const index = Math.abs(Number(scheduler.cursor || 0)) % candidates.length;
  scheduler.cursor = index + 1;
  return candidates[index];
}

function buildScheduledAccountScope(candidate) {
  const provider = String(candidate && candidate.provider || '').trim();
  const account = candidate && candidate.account;
  const accountRef = provider && account ? listAccountModelCacheRefs(provider, account)[0] || '' : '';
  return { accountRef };
}

function nextDelayAfterRun(scheduler, ok) {
  const active = isUserActive(scheduler);
  const previous = Number(scheduler.nextDelayMs || 0);
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
  try {
    const candidate = pickProbeCandidate(ctx.state, scheduler);
    if (!candidate) {
      ok = true;
      return;
    }
    await refreshWebUiModelsCache(ctx.state, ctx.options || {}, {
      fs: ctx.fs || ctx.deps && ctx.deps.fs,
      aiHomeDir: ctx.aiHomeDir || ctx.deps && ctx.deps.aiHomeDir,
      fetchModelsForAccount: ctx.deps && ctx.deps.fetchModelsForAccount,
      accountScope: {
        ...buildScheduledAccountScope(candidate)
      }
    });
    ok = true;
  } finally {
    scheduler.running = false;
    scheduleNextModelRefresh(ctx, nextDelayAfterRun(scheduler, ok));
  }
}

function ensureWebUiModelRefreshScheduler(ctx) {
  if (!ctx || !ctx.state) return;
  const scheduler = getSchedulerState(ctx.state);
  if (scheduler.timer || scheduler.running) return;
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
  triggerWebUiModelRefreshSoon,
  touchWebUiModelActivity,
  __private: {
    getAccountCacheSnapshot,
    buildScheduledAccountScope,
    nextDelayAfterRun,
    pickProbeCandidate
  }
};
