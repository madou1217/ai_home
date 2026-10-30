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
  const value = readJsonValue(fs, aiHomeDir, key);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
  return (accountRef) => {
    const normalizedRef = normalizeAccountRef(accountRef);
    const key = buildUsageSnapshotKey(normalizedRef);
    if (!key) return null;
    const value = snapshots.get(key);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
