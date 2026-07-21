'use strict';

function scheduleUnrefTimeout(callback, delayMs) {
  const timer = setTimeout(callback, delayMs);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

function clearPendingRefreshTimer(cacheState) {
  if (!cacheState || !cacheState.pendingRefreshTimer) return;
  clearTimeout(cacheState.pendingRefreshTimer);
  cacheState.pendingRefreshTimer = null;
}

function clearCacheRefreshTimers(cacheState) {
  if (!cacheState) return;
  clearPendingRefreshTimer(cacheState);
  if (cacheState.refreshTimer) {
    clearInterval(cacheState.refreshTimer);
    cacheState.refreshTimer = null;
  }
  if (cacheState.warmupTimer) {
    clearTimeout(cacheState.warmupTimer);
    cacheState.warmupTimer = null;
  }
}

async function runSingleFlightRefresh(cacheState, refreshWork) {
  if (cacheState.refreshing) {
    cacheState.queued = true;
    return cacheState;
  }

  clearPendingRefreshTimer(cacheState);
  cacheState.refreshing = true;
  cacheState.dirty = false;

  try {
    return await refreshWork();
  } finally {
    cacheState.refreshing = false;
    if (cacheState.queued) {
      cacheState.queued = false;
      cacheState.pendingRefreshTimer = scheduleUnrefTimeout(() => {
        cacheState.pendingRefreshTimer = null;
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
    // stale-while-revalidate：后台刷新必须**真异步**。此前直接 refresh() 会在当前 tick
    // 同步跑完重建(如 buildProjectsSnapshot 处理上千会话,~1.7s),把「后台」刷新压回读请求
    // 的关键路径、阻塞事件循环。defer 到下一 tick，本次读立即拿旧快照返回。
    scheduleUnrefTimeout(() => { refresh().catch(() => {}); }, 0);
  }
  return Promise.resolve(cacheState);
}

function scheduleDirtyRefresh(cacheState, refresh, options = {}) {
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  cacheState.dirty = true;
  if (cacheState.refreshing) {
    cacheState.queued = true;
    return;
  }
  clearPendingRefreshTimer(cacheState);
  if (options.immediate) {
    refresh().catch(() => {});
    return;
  }
  cacheState.pendingRefreshTimer = scheduleUnrefTimeout(() => {
    cacheState.pendingRefreshTimer = null;
    refresh().catch(() => {});
  }, delayMs);
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
  ensurePeriodicRefresh,
  clearCacheRefreshTimers
};
