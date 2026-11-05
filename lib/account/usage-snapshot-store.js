'use strict';

const {
  deleteJsonValue,
  readJsonValue,
  readJsonValuesByPrefix,
  writeJsonValue
} = require('../server/app-state-store');
const {
  isAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');
const { detectAndRecordQuotaResets } = require('./quota-reset-detector');
const { readGoUsageDocuments } = require('./go-bridge/go-account-store-reader');
const { buildPlanConfirmationKey, recordPlanConfirmation, withPlanConfirmation } = require('./plan-confirmation-store');
const { USAGE_REFRESH_STALE_MS } = require('../cli/config/constants');
const { buildQuotaSnapshotProvenance } = require('../usage/quota/probe-result');

/**
 * 额度快照的读写边界是 `provenance` 的唯一补齐点：
 * 原生 handler（codex/claude/agy/gemini）与探针链写出的快照形状不同，但都要让
 * WebUI 看到来源、年龄与 stale。这里只增加展示元数据，不改 `source`/`capturedAt`
 * 等既有事实字段，也不改变快照是否可信的判定。
 */
function withQuotaProvenance(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const provenance = buildQuotaSnapshotProvenance(snapshot, { maxAgeMs: USAGE_REFRESH_STALE_MS });
  return provenance ? { ...snapshot, provenance } : snapshot;
}

// Go 是额度快照的存储真相；app_kv 只是采集暂存与本地缓存。这里做一次 1 秒的
// 只读缓存，避免 10 秒轮询里按账号反复打开 aih.db。
const goDocumentCache = new Map();

function readGoDocumentsCached(aiHomeDir) {
  const now = Date.now();
  const cached = goDocumentCache.get(aiHomeDir);
  if (cached && now - cached.at < 1000) return cached.documents;
  let documents = new Map();
  try {
    documents = readGoUsageDocuments(aiHomeDir);
  } catch (_error) {
    documents = new Map();
  }
  goDocumentCache.set(aiHomeDir, { at: now, documents });
  return documents;
}

function snapshotCapturedAt(snapshot) {
  const value = Number(snapshot && snapshot.capturedAt);
  return Number.isFinite(value) ? value : 0;
}

/** 两边都可能有：采集刚写本地、同步还没推 Go；Go 有更新的就以 Go 为准。 */
function newerSnapshot(local, remote) {
  if (!remote) return local;
  if (!local) return remote;
  return snapshotCapturedAt(remote) > snapshotCapturedAt(local) ? remote : local;
}

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return isAccountRef(value) ? value : '';
}

function buildUsageSnapshotKey(accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  return normalizedRef ? `account:usage:${normalizedRef}` : '';
}

function readAccountUsageSnapshot(fs, aiHomeDir, accountRef) {
  const key = buildUsageSnapshotKey(accountRef);
  if (!key) return null;
  const local = readJsonValue(fs, aiHomeDir, key);
  const remote = readGoDocumentsCached(aiHomeDir).get(normalizeAccountRef(accountRef));
  const value = newerSnapshot(
    local && typeof local === 'object' && !Array.isArray(local) ? local : null,
    remote && typeof remote === 'object' && !Array.isArray(remote) ? remote : null
  );
  if (!value) return null;
  return withQuotaProvenance(
    withPlanConfirmation(fs, aiHomeDir, normalizeAccountRef(accountRef), value)
  );
}

/**
 * Batched form of readAccountUsageSnapshot for callers that read every account at once
 * (management live poller, 1.5s). Two prefix reads instead of two SQLite opens per
 * account; per-account results are identical to readAccountUsageSnapshot.
 *
 * @returns {(accountRef: string) => object|null}
 */
function loadAccountUsageSnapshotReader(fs, aiHomeDir) {
  const snapshots = readJsonValuesByPrefix(fs, aiHomeDir, 'account:usage:');
  const confirmations = readJsonValuesByPrefix(fs, aiHomeDir, buildPlanConfirmationKey(''));
  const goDocuments = readGoDocumentsCached(aiHomeDir);
  return (accountRef) => {
    const normalizedRef = normalizeAccountRef(accountRef);
    const key = buildUsageSnapshotKey(normalizedRef);
    if (!key) return null;
    const local = snapshots.get(key);
    const remote = goDocuments.get(normalizedRef);
    const value = newerSnapshot(
      local && typeof local === 'object' && !Array.isArray(local) ? local : null,
      remote && typeof remote === 'object' && !Array.isArray(remote) ? remote : null
    );
    if (!value) return null;
    const stored = confirmations.get(buildPlanConfirmationKey(normalizedRef));
    return withQuotaProvenance(
      withPlanConfirmation(fs, aiHomeDir, normalizedRef, value, { stored: stored === undefined ? null : stored })
    );
  };
}

function writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, snapshot) {
  const normalizedRef = normalizeAccountRef(accountRef);
  const account = normalizedRef
    ? resolveAccountRef(fs, aiHomeDir, normalizedRef, { bestEffort: true })
    : null;
  if (!account) throw new Error('invalid_account_usage_snapshot');
  const key = buildUsageSnapshotKey(normalizedRef);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    deleteJsonValue(fs, aiHomeDir, key);
    return true;
  }
  const storedSnapshot = withQuotaProvenance(snapshot);
  if (!writeJsonValue(fs, aiHomeDir, key, storedSnapshot)) {
    throw new Error('account_usage_snapshot_write_failed');
  }
  try {
    recordPlanConfirmation(fs, aiHomeDir, normalizedRef, storedSnapshot);
  } catch (_error) {
    // Best effort: the snapshot itself is already persisted.
  }
  try {
    const provider = String(account.provider || storedSnapshot.provider || '').trim().toLowerCase();
    detectAndRecordQuotaResets(fs, aiHomeDir, normalizedRef, { ...storedSnapshot, provider });
  } catch (_error) {
    // Best effort quota reset detection, do not block main snapshot persistence
  }
  return true;
}

function deleteAccountUsageSnapshot(fs, aiHomeDir, accountRef) {
  const key = buildUsageSnapshotKey(accountRef);
  return key ? deleteJsonValue(fs, aiHomeDir, key) : false;
}

module.exports = {
  buildUsageSnapshotKey,
  deleteAccountUsageSnapshot,
  loadAccountUsageSnapshotReader,
  readAccountUsageSnapshot,
  writeAccountUsageSnapshot
};
