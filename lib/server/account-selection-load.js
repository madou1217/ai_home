'use strict';

const {
  ACCOUNT_SELECTION_UNKNOWN_WEIGHT,
  ACCOUNT_SELECTION_AFFINITY_LOAD_MARGIN,
  ACCOUNT_SELECTION_LOW_QUOTA_PCT
} = require('../cli/config/constants');

function remainingWeight(account) {
  const value = account?.remainingPct;
  if (value == null || value === '' || !Number.isFinite(Number(value))) {
    return ACCOUNT_SELECTION_UNKNOWN_WEIGHT;
  }
  return Math.max(1, Math.min(100, Number(value)));
}

function requestPressure(account, activity, provider) {
  const load = activity?.selectionLoad?.(provider, account.accountRef);
  if (!load) return 0;
  // In-flight work dominates; recent starts discourage bursts on a just-idle
  // account. Idle sockets and terminal windows are deliberately not counted.
  return load.inFlight + load.rate / Math.max(1, load.windowMs / 1000);
}

function selectionWeight(account, activity, provider) {
  return remainingWeight(account) / (1 + requestPressure(account, activity, provider)) ** 2;
}

function canPreferAccount(account, candidates, activity, provider) {
  const others = candidates.filter(candidate => candidate !== account);
  if (!others.length) return true;
  if (remainingWeight(account) <= ACCOUNT_SELECTION_LOW_QUOTA_PCT
      && others.some(candidate => remainingWeight(candidate) > ACCOUNT_SELECTION_LOW_QUOTA_PCT)) return false;
  const leastPressure = Math.min(...others.map(candidate => requestPressure(candidate, activity, provider)));
  return requestPressure(account, activity, provider) <= leastPressure + ACCOUNT_SELECTION_AFFINITY_LOAD_MARGIN;
}

function preferAlternatives(account, candidates, activity, provider) {
  if (!account || canPreferAccount(account, candidates, activity, provider)) return candidates;
  return candidates.filter(candidate => candidate !== account);
}

module.exports = { selectionWeight, canPreferAccount, preferAlternatives };
