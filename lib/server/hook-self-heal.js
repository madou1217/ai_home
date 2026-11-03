'use strict';

const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function shouldReportFailure(count) {
  return count === 1 || (count & (count - 1)) === 0;
}

function createHookSelfHealLoop(options = {}) {
  const ensureInstalled = options.ensureInstalled;
  if (typeof ensureInstalled !== 'function') {
    throw new TypeError('hook_self_heal_ensure_installed_required');
  }

  const intervalMs = normalizePositiveNumber(options.intervalMs, 15_000);
  const maxBackoffMs = Math.max(
    intervalMs,
    normalizePositiveNumber(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS)
  );
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setIntervalImpl = options.setInterval || setInterval;
  const clearIntervalImpl = options.clearInterval || clearInterval;
  const onRepaired = typeof options.onRepaired === 'function' ? options.onRepaired : () => {};
  const onFailure = typeof options.onFailure === 'function' ? options.onFailure : () => {};

  let repairing = false;
  let stopped = false;
  let suspended = false;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;

  function getState() {
    return {
      repairing,
      stopped,
      suspended,
      consecutiveFailures,
      nextAttemptAt
    };
  }

  function recordFailure(result, error) {
    consecutiveFailures += 1;
    suspended = Boolean(result && result.retryable === false);
    if (!suspended) {
      const exponent = Math.min(consecutiveFailures - 1, 30);
      const delayMs = Math.min(maxBackoffMs, intervalMs * (2 ** exponent));
      nextAttemptAt = now() + delayMs;
    }
    if (suspended || shouldReportFailure(consecutiveFailures)) {
      onFailure({
        result: result || null,
        error: error || null,
        suspended,
        consecutiveFailures,
        nextAttemptAt
      });
    }
    return result || null;
  }

  function tick() {
    const currentTime = now();
    if (stopped || repairing || suspended || currentTime < nextAttemptAt) return null;
    repairing = true;
    try {
      const result = ensureInstalled();
      if (result && result.ok === false) return recordFailure(result, null);
      consecutiveFailures = 0;
      nextAttemptAt = 0;
      if (result && result.repaired) onRepaired(result);
      return result || null;
    } catch (error) {
      return recordFailure(null, error);
    } finally {
      repairing = false;
    }
  }

  const timer = setIntervalImpl(tick, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalImpl(timer);
    },
    tick,
    getState
  };
}

module.exports = {
  createHookSelfHealLoop
};
