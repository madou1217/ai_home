'use strict';

function scheduleUnrefTimeout(callback, delayMs) {
  const timer = setTimeout(callback, delayMs);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

async function runSingleFlightRefresh(cacheState, refreshWork) {
  if (cacheState.refreshing) {
    cacheState.queued = true;
    return cacheState;
  }

  cacheState.refreshing = true;
  cacheState.dirty = false;

  try {
    return await refreshWork();
  } finally {
    cacheState.refreshing = false;
    if (cacheState.queued) {
      cacheState.queued = false;
      scheduleUnrefTimeout(() => {
        runSingleFlightRefresh(cacheState, refreshWork).catch(() => {});
      }, 0);
    }
  }
}

function getSnapshotWithRefresh(cacheState, options, handlers) {
  const {
    shouldRefresh,
    refresh
  } = handlers;
  const needsRefresh = shouldRefresh(cacheState, options);

  if (needsRefresh && (options.waitForRefresh || !cacheState.updatedAt)) {
    return refresh();
  }
  if (needsRefresh && !cacheState.refreshing) {
    refresh().catch(() => {});
  }
  return Promise.resolve(cacheState);
}

function scheduleDirtyRefresh(cacheState, refresh, options = {}) {
  cacheState.dirty = true;
  if (cacheState.refreshing) {
    cacheState.queued = true;
    return;
  }
  if (options.immediate) {
    refresh().catch(() => {});
    return;
  }
  scheduleUnrefTimeout(() => {
    refresh().catch(() => {});
  }, 0);
}

function ensurePeriodicRefresh(cacheState, options) {
  const {
    shouldRefresh,
    refresh,
    intervalMs,
    warmupMs = 1000
  } = options;

  if (cacheState.refreshTimer) return;
  cacheState.refreshTimer = setInterval(() => {
    if (!shouldRefresh(cacheState)) return;
    refresh().catch(() => {});
  }, intervalMs);
  if (typeof cacheState.refreshTimer.unref === 'function') {
    cacheState.refreshTimer.unref();
  }
  cacheState.warmupTimer = scheduleUnrefTimeout(() => {
    cacheState.warmupTimer = null;
    refresh().catch(() => {});
  }, warmupMs);
}

module.exports = {
  runSingleFlightRefresh,
  getSnapshotWithRefresh,
  scheduleDirtyRefresh,
  ensurePeriodicRefresh
};
