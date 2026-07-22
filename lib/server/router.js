'use strict';

const { chooseServerAccount, pickWeightedRandomAccount } = require('./account-selector');
const {
  normalizeAccountRuntime,
  touchAccountSuccessState,
  touchAccountModelFailureState,
  clearAccountModelState
} = require('./account-runtime-state');
const { resolveRequestProvider, normalizeExplicitProvider } = require('./provider-routing');

function markProxyAccountSuccess(account, options = {}) {
  if (!account) return;
  normalizeAccountRuntime(account);
  account.consecutiveFailures = 0;
  account.successCount = Number(account.successCount || 0) + 1;
  account.lastError = '';
  // A success on a specific model clears that model's cooldown/failure streak,
  // independent of the account-wide success bookkeeping.
  if (options && options.model) clearAccountModelState(account, options.model);
  touchAccountSuccessState(account);
}

function markProxyAccountFailure(account, reason, cooldownMs, failureThreshold = 2, options = {}) {
  if (!account) return;
  normalizeAccountRuntime(account);
  account.failCount = Number(account.failCount || 0) + 1;
  account.lastError = String(reason || '');
  account.lastFailureReason = String(reason || '');
  if (options && options.kind) account.lastFailureKind = String(options.kind || '');
  account.lastFailureAt = Date.now();

  const model = options && options.model ? String(options.model).trim() : '';
  if (options && options.scope === 'model' && model) {
    touchAccountModelFailureState(account, {
      kind: options.kind,
      failureReason: reason,
      failureThreshold,
      cooldownMs,
      failureWindowMs: options.failureWindowMs
    }, model);
    return;
  }

  account.consecutiveFailures = Number(account.consecutiveFailures || 0) + 1;
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
