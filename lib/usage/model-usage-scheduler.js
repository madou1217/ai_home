'use strict';

const DEFAULT_MODEL_USAGE_SCAN_START_DELAY_MS = 5_000;
const DEFAULT_MODEL_USAGE_SCAN_INTERVAL_MS = 10 * 60 * 1000;
const MIN_MODEL_USAGE_SCAN_INTERVAL_MS = 60 * 1000;

function normalizePositiveMs(value, fallback, min = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) return fallback;
  return Math.floor(number);
}

function normalizeModelUsageScanConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    startDelayMs: normalizePositiveMs(
      config.startDelayMs,
      DEFAULT_MODEL_USAGE_SCAN_START_DELAY_MS,
      0
    ),
    intervalMs: normalizePositiveMs(
      config.intervalMs,
      DEFAULT_MODEL_USAGE_SCAN_INTERVAL_MS,
      MIN_MODEL_USAGE_SCAN_INTERVAL_MS
    )
  };
}

function formatError(error) {
  return String((error && error.code) || (error && error.message) || error || 'unknown_error');
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function createModelUsageScanScheduler(options = {}) {
  const modelUsageService = options.modelUsageService || null;
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout;
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;
  const clearIntervalFn = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : clearInterval;
  const logInfo = typeof options.logInfo === 'function' ? options.logInfo : () => {};
  const logWarn = typeof options.logWarn === 'function' ? options.logWarn : () => {};

  const state = {
    running: false,
    scanning: false,
    config: normalizeModelUsageScanConfig(options.config),
    timers: {
      initial: null,
      interval: null
    },
    lastResult: null,
    lastError: '',
    scanCount: 0
  };

  function clearTimers() {
    if (state.timers.initial) {
      clearTimeoutFn(state.timers.initial);
      state.timers.initial = null;
    }
    if (state.timers.interval) {
      clearIntervalFn(state.timers.interval);
      state.timers.interval = null;
    }
  }

  async function runScanNow(reason = 'manual') {
    if (!state.config.enabled) {
      return { ok: false, skipped: true, reason: 'disabled' };
    }
    if (!modelUsageService || typeof modelUsageService.scan !== 'function') {
      return { ok: false, skipped: true, reason: 'service_unavailable' };
    }
    if (state.scanning) {
      return { ok: false, skipped: true, reason: 'already_running' };
    }

    state.scanning = true;
    try {
      const result = await Promise.resolve(modelUsageService.scan());
      let pricing = null;
      if (typeof modelUsageService.syncPricingIfStale === 'function') {
        try {
          pricing = await modelUsageService.syncPricingIfStale();
        } catch (error) {
          pricing = { ok: false, error: formatError(error) };
        }
      }
      state.scanCount += 1;
      state.lastResult = {
        at: Date.now(),
        reason,
        result,
        pricing
      };
      state.lastError = '';
      logInfo(`model usage scan completed (${reason})`);
      return { ok: true, result };
    } catch (error) {
      const message = formatError(error);
      if (state.lastError !== message) {
        logWarn(`model usage scan failed (${reason}): ${message}`);
      }
      state.lastError = message;
      return { ok: false, error: message };
    } finally {
      state.scanning = false;
    }
  }

  function scheduleTimers() {
    clearTimers();
    if (!state.config.enabled) return;

    state.timers.initial = setTimeoutFn(() => (
      runScanNow('startup').catch((error) => {
        logWarn(`model usage scan failed (startup): ${formatError(error)}`);
      })
    ), state.config.startDelayMs);
    unrefTimer(state.timers.initial);

    state.timers.interval = setIntervalFn(() => (
      runScanNow('interval').catch((error) => {
        logWarn(`model usage scan failed (interval): ${formatError(error)}`);
      })
    ), state.config.intervalMs);
    unrefTimer(state.timers.interval);
  }

  function start(config = {}) {
    state.config = normalizeModelUsageScanConfig({
      ...state.config,
      ...config
    });
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
      scanning: state.scanning,
      enabled: state.config.enabled,
      startDelayMs: state.config.startDelayMs,
      intervalMs: state.config.intervalMs,
      scanCount: state.scanCount,
      lastResult: state.lastResult,
      lastError: state.lastError
    };
  }

  return {
    start,
    stop,
    runScanNow,
    getState
  };
}

module.exports = {
  DEFAULT_MODEL_USAGE_SCAN_START_DELAY_MS,
  DEFAULT_MODEL_USAGE_SCAN_INTERVAL_MS,
  MIN_MODEL_USAGE_SCAN_INTERVAL_MS,
  normalizeModelUsageScanConfig,
  createModelUsageScanScheduler
};
