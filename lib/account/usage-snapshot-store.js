'use strict';

const {
  deleteJsonValue,
  readJsonValue,
  writeJsonValue
} = require('../server/app-state-store');
const {
  isAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');

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
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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
  if (!writeJsonValue(fs, aiHomeDir, key, snapshot)) {
    throw new Error('account_usage_snapshot_write_failed');
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
  readAccountUsageSnapshot,
  writeAccountUsageSnapshot
};
