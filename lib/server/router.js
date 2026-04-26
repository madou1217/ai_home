'use strict';

const { inferProviderFromModel, SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { chooseServerAccount, pickWeightedRandomAccount } = require('./account-selector');
const { normalizeAccountRuntime, touchAccountSuccessState } = require('./account-runtime-state');

function normalizeExplicitProvider(providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  return SUPPORTED_SERVER_PROVIDERS.includes(provider) ? provider : '';
}

function resolveRequestProvider(options, requestJson, reqHeaders) {
  const explicitHeaderProvider = normalizeExplicitProvider(
    reqHeaders && (reqHeaders['x-provider'] || reqHeaders['X-Provider'])
  );
  if (explicitHeaderProvider) return explicitHeaderProvider;

  const explicitRequestProvider = normalizeExplicitProvider(requestJson && requestJson.provider);
  if (explicitRequestProvider) return explicitRequestProvider;

  const requested = String(requestJson && requestJson.model || '');
  if (SUPPORTED_SERVER_PROVIDERS.includes(options.provider)) return options.provider;
  return inferProviderFromModel(requested);
}

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
