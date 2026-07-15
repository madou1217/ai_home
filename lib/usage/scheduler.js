const ONE_MINUTE_MS = 60 * 1000;
const THREE_MINUTES_MS = 3 * ONE_MINUTE_MS;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

const ACTIVE_INTERVAL_OPTIONS_MS = new Set([ONE_MINUTE_MS, THREE_MINUTES_MS]);

function clampPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeActiveIntervalMs(value) {
  const ms = clampPositiveInt(value, ONE_MINUTE_MS);
  return ACTIVE_INTERVAL_OPTIONS_MS.has(ms) ? ms : ONE_MINUTE_MS;
}

function normalizeBackgroundIntervalMs(value) {
  return clampPositiveInt(value, ONE_HOUR_MS);
}

function normalizeConfig(config = {}) {
  return {
    activeRefreshIntervalMs: normalizeActiveIntervalMs(config.activeRefreshIntervalMs),
    backgroundRefreshIntervalMs: normalizeBackgroundIntervalMs(config.backgroundRefreshIntervalMs)
  };
}

function createUsageScheduler(options = {}) {
  const refreshActiveAccount = typeof options.refreshActiveAccount === 'function'
    ? options.refreshActiveAccount
    : () => {};
  const refreshBackgroundAccounts = typeof options.refreshBackgroundAccounts === 'function'
    ? options.refreshBackgroundAccounts
    : () => {};
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;
  const clearIntervalFn = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : clearInterval;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};

  const state = {
    running: false,
    config: normalizeConfig(options.config),
    timers: {
      active: null,
      background: null
    }
  };

  function runActiveTick() {
    return Promise.resolve(refreshActiveAccount());
  }

  function runBackgroundTick() {
    return Promise.resolve(refreshBackgroundAccounts());
  }

  function clearTimers() {
    if (state.timers.active) {
      clearIntervalFn(state.timers.active);
      state.timers.active = null;
    }
    if (state.timers.background) {
      clearIntervalFn(state.timers.background);
      state.timers.background = null;
    }
  }

  function scheduleTimers() {
    clearTimers();
    state.timers.active = setIntervalFn(() => {
      runActiveTick().catch((err) => {
        logger('[usage-scheduler] active refresh failed', err);
      });
    }, state.config.activeRefreshIntervalMs);
    state.timers.background = setIntervalFn(() => {
      runBackgroundTick().catch((err) => {
        logger('[usage-scheduler] background refresh failed', err);
      });
    }, state.config.backgroundRefreshIntervalMs);
  }

  function updateConfig(nextConfig = {}) {
    const merged = {
      activeRefreshIntervalMs: nextConfig.activeRefreshIntervalMs != null
        ? nextConfig.activeRefreshIntervalMs
        : state.config.activeRefreshIntervalMs,
      backgroundRefreshIntervalMs: nextConfig.backgroundRefreshIntervalMs != null
        ? nextConfig.backgroundRefreshIntervalMs
        : state.config.backgroundRefreshIntervalMs
    };
    state.config = normalizeConfig(merged);
    if (state.running) scheduleTimers();
    return getState();
  }

  function start(config = {}) {
    updateConfig(config);
    if (state.running) return getState();
    state.running = true;
    scheduleTimers();
    return getState();
  }

  function stop() {
    clearTimers();
    state.running = false;
    return getState();
  }

  function getState() {
    return {
      running: state.running,
      activeRefreshIntervalMs: state.config.activeRefreshIntervalMs,
      backgroundRefreshIntervalMs: state.config.backgroundRefreshIntervalMs
    };
  }

  return {
    start,
    stop,
    updateConfig,
    getState,
    runActiveNow: runActiveTick,
    runBackgroundNow: runBackgroundTick
  };
}

module.exports = {
  ONE_MINUTE_MS,
  THREE_MINUTES_MS,
  ONE_HOUR_MS,
  normalizeConfig,
  createUsageScheduler
};
