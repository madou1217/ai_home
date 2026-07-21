'use strict';

const { getMinRemainingPctFromUsageSnapshot } = require('../account/derived-state');
const { writeAccountUsageSnapshot } = require('../account/usage-snapshot-store');
const { fetchAgyCodeAssistQuotaSnapshot } = require('./code-assist-quota');

const DEFAULT_AGY_USAGE_REFRESH_TTL_MS = 60_000;
const DEFAULT_AGY_USAGE_REFRESH_TIMEOUT_MS = 8_000;
const AGY_USAGE_SOURCE = 'agy_fetch_available_models';
const refreshInFlight = new WeakMap();

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizePositiveInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function isTrustedAgyUsageSnapshot(snapshot) {
  return Boolean(
    snapshot
    && typeof snapshot === 'object'
    && snapshot.schemaVersion === 2
    && snapshot.kind === 'agy_code_assist_quota'
    && snapshot.source === AGY_USAGE_SOURCE
    && Array.isArray(snapshot.models)
  );
}

function listAgyQuotaAvailableModels(snapshot) {
  if (!isTrustedAgyUsageSnapshot(snapshot)) return [];
  return snapshot.models
    .filter((model) => Number(model && model.remainingPct) > 0)
    .map((model) => normalizeText(model && model.model))
    .filter(Boolean);
}

function applyAgyUsageSnapshotToAccount(account, snapshot) {
  if (!account || !isTrustedAgyUsageSnapshot(snapshot)) return account;
  const project = normalizeText(snapshot.account && snapshot.account.project);
  account.usageSnapshot = snapshot;
  account.codeAssistQuotaCapturedAt = Number(snapshot.capturedAt) || 0;
  account.codeAssistQuotaModels = snapshot.models.slice();
  account.availableModels = listAgyQuotaAvailableModels(snapshot);
  if (project) account.codeAssistProject = project;
  // AGY quota is model-scoped. Do not copy the snapshot minimum to
  // account.remainingPct, otherwise one exhausted model would block all models.
  account.codeAssistQuotaMinRemainingPct = getMinRemainingPctFromUsageSnapshot(snapshot);
  return account;
}

function getAgyUsageRefreshTtlMs(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  return normalizePositiveInteger(
    options.agyUsageRefreshTtlMs || env.AIH_AGY_USAGE_REFRESH_TTL_MS,
    DEFAULT_AGY_USAGE_REFRESH_TTL_MS,
    5_000,
    30 * 60_000
  );
}

function getAgyUsageRefreshTimeoutMs(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  return normalizePositiveInteger(
    options.agyUsageRefreshTimeoutMs || env.AIH_AGY_USAGE_HTTP_TIMEOUT_MS,
    DEFAULT_AGY_USAGE_REFRESH_TIMEOUT_MS,
    1_000,
    30_000
  );
}

function isAgyUsageSnapshotStale(snapshot, ttlMs = DEFAULT_AGY_USAGE_REFRESH_TTL_MS, now = Date.now()) {
  if (!isTrustedAgyUsageSnapshot(snapshot)) return true;
  const capturedAt = Number(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return true;
  return now - capturedAt >= Math.max(0, Number(ttlMs) || 0);
}

function writeAgyUsageSnapshot(fs, aiHomeDir, accountRef, snapshot) {
  if (!fs || !aiHomeDir || !accountRef || !isTrustedAgyUsageSnapshot(snapshot)) return false;
  return writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, snapshot);
}

function createQuotaFetchImpl(fetchWithTimeout, options, timeoutMs) {
  if (typeof fetchWithTimeout !== 'function') return undefined;
  return (url, init) => fetchWithTimeout(url, init, timeoutMs, {
    proxyUrl: options.proxyUrl,
    noProxy: options.noProxy
  });
}

async function refreshAgyUsageSnapshotForAccount(input = {}) {
  const account = input.account;
  if (!account || String(account.provider || '').trim() !== 'agy') return null;
  if (!normalizeText(account.accessToken)) return null;
  if (!input.force && !isAgyUsageSnapshotStale(account.usageSnapshot, input.ttlMs)) {
    return account.usageSnapshot;
  }

  const existing = refreshInFlight.get(account);
  if (existing) return existing;

  const options = input.options || {};
  const fs = input.fs || require('node:fs');
  const timeoutMs = getAgyUsageRefreshTimeoutMs(options);
  const fetchImpl = input.fetchImpl || createQuotaFetchImpl(input.fetchWithTimeout, options, timeoutMs);
  const work = fetchAgyCodeAssistQuotaSnapshot({
    fetchImpl,
    schemaVersion: 2,
    source: AGY_USAGE_SOURCE,
    agyQuotaBaseUrls: options.agyQuotaBaseUrls,
    agyQuotaBaseUrl: options.agyQuotaBaseUrl,
    agyBaseUrl: options.agyBaseUrl,
    env: options.env || process.env
  }, account, timeoutMs)
    .then((snapshot) => {
      if (!isTrustedAgyUsageSnapshot(snapshot)) return null;
      writeAgyUsageSnapshot(fs, input.aiHomeDir, account.accountRef, snapshot);
      applyAgyUsageSnapshotToAccount(account, snapshot);
      return snapshot;
    })
    .finally(() => {
      refreshInFlight.delete(account);
    });

  refreshInFlight.set(account, work);
  return work;
}

async function refreshStaleAgyUsageSnapshotsForPool(input = {}) {
  const pool = Array.isArray(input.pool) ? input.pool : [];
  const options = input.options || {};
  const ttlMs = input.ttlMs || getAgyUsageRefreshTtlMs(options);
  const staleAccounts = pool.filter((account) => (
    account
    && String(account.provider || '').trim() === 'agy'
    && normalizeText(account.accessToken)
    && isTrustedAgyUsageSnapshot(account.usageSnapshot)
    && isAgyUsageSnapshotStale(account.usageSnapshot, ttlMs)
  ));
  if (staleAccounts.length < 1) return { refreshed: 0, failed: 0 };

  const settled = await Promise.allSettled(staleAccounts.map((account) => refreshAgyUsageSnapshotForAccount({
    ...input,
    account,
    ttlMs,
    force: false
  })));
  return settled.reduce((summary, item) => {
    if (item.status === 'fulfilled' && item.value) summary.refreshed += 1;
    else summary.failed += 1;
    return summary;
  }, { refreshed: 0, failed: 0 });
}

function scheduleAgyUsageRefreshAfterFailure(input = {}) {
  const policy = input.policy || {};
  if (input.provider !== 'agy') return;
  if (
    policy.kind !== 'rate_limited'
    && policy.kind !== 'model_quota_exhausted'
    && policy.kind !== 'model_capacity_unavailable'
    && policy.kind !== 'location_unsupported'
  ) return;
  refreshAgyUsageSnapshotForAccount({
    ...input,
    force: true
  }).catch(() => {});
}

module.exports = {
  applyAgyUsageSnapshotToAccount,
  getAgyUsageRefreshTtlMs,
  isAgyUsageSnapshotStale,
  isTrustedAgyUsageSnapshot,
  listAgyQuotaAvailableModels,
  refreshAgyUsageSnapshotForAccount,
  refreshStaleAgyUsageSnapshotsForPool,
  scheduleAgyUsageRefreshAfterFailure,
  __private: {
    writeAgyUsageSnapshot
  }
};
