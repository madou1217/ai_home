'use strict';

const {
  deriveRuntimeStatus,
  isBlockingRuntimeStatus
} = require('./runtime-view');

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeAccountRef(accountRef) {
  const ref = String(accountRef || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(ref) ? ref : '';
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

  function getNextSchedulableAccountRef(provider, excludedRef = '') {
    const p = normalizeProvider(provider);
    if (!p) return null;
    const excluded = normalizeAccountRef(excludedRef);
    const candidates = listStates(p)
      .filter((row) => row && row.configured)
      .filter((row) => String(row.status || 'up') === 'up')
      .filter((row) => !row.apiKeyMode)
      .filter((row) => normalizeAccountRef(row.accountRef) !== excluded)
      .filter((row) => !isBlockingRuntimeStatus(deriveRuntimeStatus(row)));
    candidates.sort((left, right) => {
      const leftRemaining = Number.isFinite(Number(left.remainingPct))
        ? Number(left.remainingPct)
        : -1;
      const rightRemaining = Number.isFinite(Number(right.remainingPct))
        ? Number(right.remainingPct)
        : -1;
      if (rightRemaining !== leftRemaining) return rightRemaining - leftRemaining;
      return String(left.accountRef).localeCompare(String(right.accountRef));
    });
    return candidates.length > 0
      ? normalizeAccountRef(candidates[0].accountRef)
      : null;
  }

  function listStaleAccountRefs(provider, staleBeforeTs, limit) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    if (!index || typeof index.listStaleRefs !== 'function' || !p) return [];
    return index.listStaleRefs(p, staleBeforeTs, limit) || [];
  }

  function listConfiguredAccountRefs(provider) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    if (!index || typeof index.listConfiguredRefs !== 'function' || !p) return [];
    return index.listConfiguredRefs(p) || [];
  }

  function listUsageCandidateAccountRefs(provider) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    if (!index || typeof index.listUsageCandidateRefs !== 'function' || !p) return [];
    return index.listUsageCandidateRefs(p) || [];
  }

  return {
    listStates,
    getNextSchedulableAccountRef,
    listStaleAccountRefs,
    listConfiguredAccountRefs,
    listUsageCandidateAccountRefs
  };
}

module.exports = {
  createAccountQueryService
};
