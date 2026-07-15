'use strict';

const { chooseServerAccount, pickWeightedRandomAccount } = require('./account-selector');
const {
  normalizeAccountRuntime,
  touchAccountSuccessState,
  clearAccountModelState,
  modelCooldownKey
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

  const model = options && options.model ? modelCooldownKey(options.model) : '';
  if (options && options.scope === 'model' && model) {
    // Model-scoped: cool only this (account, model) tuple, never the whole account.
    account.modelFailures = account.modelFailures && typeof account.modelFailures === 'object' ? account.modelFailures : {};
    account.modelFailures[model] = Number(account.modelFailures[model] || 0) + 1;
    if (account.modelFailures[model] >= Math.max(1, Number(failureThreshold) || 1)) {
      account.modelCooldowns = account.modelCooldowns && typeof account.modelCooldowns === 'object' ? account.modelCooldowns : {};
      const until = Date.now() + Math.max(1000, Number(cooldownMs) || 0);
      account.modelCooldowns[model] = Math.max(Number(account.modelCooldowns[model] || 0), until);
    }
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
