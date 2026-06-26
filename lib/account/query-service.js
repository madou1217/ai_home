'use strict';

const {
  deriveRuntimeStatus,
  isBlockingRuntimeStatus
} = require('./runtime-view');

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeAccountId(accountId) {
  const id = String(accountId || '').trim();
  return /^\d+$/.test(id) ? id : '';
}

function createAccountQueryService(options = {}) {
  function getIndex() {
    if (options.accountStateIndex) return options.accountStateIndex;
    if (typeof options.getAccountStateIndex !== 'function') return null;
    try {
      return options.getAccountStateIndex();
    } catch (_error) {
      return null;
    }
  }

  function listStates(provider) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    if (!index || typeof index.listStates !== 'function' || !p) return [];
    return index.listStates(p) || [];
  }

  function getNextSchedulableAccountId(provider, excludedId = '') {
    const p = normalizeProvider(provider);
    if (!p) return null;
    const excluded = normalizeAccountId(excludedId);
    const candidates = listStates(p)
      .filter((row) => row && row.configured)
      .filter((row) => String(row.status || 'up') === 'up')
      .filter((row) => !row.apiKeyMode && !row.api_key_mode)
      .filter((row) => normalizeAccountId(row.accountId || row.account_id) !== excluded)
      .filter((row) => !isBlockingRuntimeStatus(deriveRuntimeStatus(row)));
    candidates.sort((left, right) => {
      const leftRemaining = Number.isFinite(Number(left.remainingPct ?? left.remaining_pct))
        ? Number(left.remainingPct ?? left.remaining_pct)
        : -1;
      const rightRemaining = Number.isFinite(Number(right.remainingPct ?? right.remaining_pct))
        ? Number(right.remainingPct ?? right.remaining_pct)
        : -1;
      if (rightRemaining !== leftRemaining) return rightRemaining - leftRemaining;
      return Number(left.accountId || left.account_id) - Number(right.accountId || right.account_id);
    });
    return candidates.length > 0
      ? normalizeAccountId(candidates[0].accountId || candidates[0].account_id)
      : null;
  }

  function listStaleAccountIds(provider, staleBeforeTs, limit) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    if (!index || typeof index.listStaleIds !== 'function' || !p) return [];
    return index.listStaleIds(p, staleBeforeTs, limit) || [];
  }

  function listConfiguredAccountIds(provider) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    if (!index || typeof index.listConfiguredIds !== 'function' || !p) return [];
    return index.listConfiguredIds(p) || [];
  }

  function listUsageCandidateAccountIds(provider) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    if (!index || typeof index.listUsageCandidateIds !== 'function' || !p) return [];
    return index.listUsageCandidateIds(p) || [];
  }

  return {
    listStates,
    getNextSchedulableAccountId,
    listStaleAccountIds,
    listConfiguredAccountIds,
    listUsageCandidateAccountIds
  };
}

module.exports = {
  createAccountQueryService
};
