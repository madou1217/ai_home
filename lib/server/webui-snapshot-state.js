'use strict';

function createSnapshotCacheState() {
  return {
    loadedFromDisk: false,
    refreshTimer: null,
    refreshing: false,
    queued: false,
    dirty: false,
    revision: 0,
    snapshot: [],
    updatedAt: 0,
    lastRefreshAt: 0
  };
}

function ensureSnapshotLoaded(cacheState, readPersistedSnapshot) {
  if (cacheState.loadedFromDisk) return cacheState;
  const persisted = typeof readPersistedSnapshot === 'function'
    ? readPersistedSnapshot()
    : null;
  if (persisted) {
    cacheState.revision = Number(persisted.revision) || 0;
    cacheState.updatedAt = Number(persisted.updatedAt) || 0;
    cacheState.lastRefreshAt = cacheState.updatedAt;
    cacheState.snapshot = persisted.snapshot;
  }
  cacheState.loadedFromDisk = true;
  return cacheState;
}

function commitSnapshot(cacheState, nextSnapshot, persistSnapshot) {
  cacheState.snapshot = nextSnapshot;
  cacheState.updatedAt = Date.now();
  cacheState.lastRefreshAt = cacheState.updatedAt;
  cacheState.revision += 1;
  cacheState.dirty = false;
  if (typeof persistSnapshot === 'function') {
    persistSnapshot(cacheState);
  }
  return {
    revision: cacheState.revision,
    updatedAt: cacheState.updatedAt
  };
}

module.exports = {
  createSnapshotCacheState,
  ensureSnapshotLoaded,
  commitSnapshot
};
