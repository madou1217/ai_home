'use strict';

const { chooseServerAccount, pickWeightedRandomAccount } = require('./account-selector');
const { normalizeAccountRuntime, touchAccountSuccessState } = require('./account-runtime-state');
const { resolveRequestProvider, normalizeExplicitProvider } = require('./provider-routing');

function markProxyAccountSuccess(account) {
  if (!account) return;
  normalizeAccountRuntime(account);
  account.consecutiveFailures = 0;
  account.successCount = Number(account.successCount || 0) + 1;
  account.lastError = '';
  touchAccountSuccessState(account);
}

function markProxyAccountFailure(account, reason, cooldownMs, failureThreshold = 2) {
  if (!account) return;
  normalizeAccountRuntime(account);
  account.failCount = Number(account.failCount || 0) + 1;
  account.consecutiveFailures = Number(account.consecutiveFailures || 0) + 1;
  account.lastError = String(reason || '');
  account.lastFailureReason = String(reason || '');
  account.lastFailureAt = Date.now();
  if (account.consecutiveFailures >= failureThreshold) {
    account.cooldownUntil = Date.now() + Math.max(1000, Number(cooldownMs) || 0);
  }
}

module.exports = {
  resolveRequestProvider,
  normalizeExplicitProvider,
  chooseServerAccount,
  pickWeightedRandomAccount,
  markProxyAccountSuccess,
  markProxyAccountFailure
};
