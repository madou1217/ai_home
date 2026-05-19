'use strict';

const { readCacheJson, writeCacheJson } = require('./webui-cache-store');
const ACCOUNTS_SNAPSHOT_FILE = 'webui-accounts-snapshot.json';

function cloneAccountsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      revision: 0,
      updatedAt: 0,
      hydrating: false,
      accounts: []
    };
  }
  return {
    revision: Number(snapshot.revision) || 0,
    updatedAt: Number(snapshot.updatedAt) || 0,
    hydrating: Boolean(snapshot.hydrating),
    accounts: Array.isArray(snapshot.accounts)
      ? snapshot.accounts.map((account) => ({ ...account }))
      : []
  };
}

function readPersistedAccountsSnapshot(ctx) {
  const raw = readCacheJson(ctx, ACCOUNTS_SNAPSHOT_FILE);
  if (!raw) return null;
  return cloneAccountsSnapshot(raw);
}

function writePersistedAccountsSnapshot(ctx, snapshot) {
  writeCacheJson(ctx, ACCOUNTS_SNAPSHOT_FILE, cloneAccountsSnapshot(snapshot));
}

function hydrateLiveStateFromSnapshot(liveState, snapshot) {
  const cloned = cloneAccountsSnapshot(snapshot);
  liveState.records = new Map(
    cloned.accounts.map((account) => [`${account.provider}:${account.accountId}`, { ...account }])
  );
  // Cold-start disk snapshot is only a seed for cached metadata. The first
  // live response should still be rebuilt from current account_state/runtime.
  liveState.fastSnapshot = null;
  liveState.fastSnapshotAt = 0;
  liveState.revision = Math.max(Number(liveState.revision) || 0, cloned.revision);
  liveState.loadedFromDisk = true;
  return cloned;
}

function ensureAccountsSnapshotLoaded(ctx, liveState) {
  if (liveState.loadedFromDisk) return liveState.fastSnapshot;
  const persisted = readPersistedAccountsSnapshot(ctx);
  if (!persisted) {
    liveState.loadedFromDisk = true;
    return null;
  }
  hydrateLiveStateFromSnapshot(liveState, persisted);
  return liveState.fastSnapshot;
}

function persistAccountsSnapshot(ctx, liveState, snapshot) {
  const normalized = cloneAccountsSnapshot({
    revision: Number(liveState.revision) || 0,
    updatedAt: Date.now(),
    hydrating: Boolean(snapshot && snapshot.hydrating),
    accounts: Array.isArray(snapshot && snapshot.accounts) ? snapshot.accounts : []
  });
  writePersistedAccountsSnapshot(ctx, normalized);
  liveState.fastSnapshot = {
    accounts: normalized.accounts.map((account) => ({ ...account })),
    hydrating: normalized.hydrating
  };
  liveState.fastSnapshotAt = normalized.updatedAt;
  liveState.loadedFromDisk = true;
  return normalized;
}

module.exports = {
  cloneAccountsSnapshot,
  ensureAccountsSnapshotLoaded,
  persistAccountsSnapshot
};
