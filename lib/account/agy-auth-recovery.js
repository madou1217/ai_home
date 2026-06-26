'use strict';

const { hasRecoverableAgyOAuthCredentials } = require('./agy-auth-metadata');
const { isAuthInvalidRuntimeStatus } = require('./runtime-view');

const AGY_RECOVERABLE_OAUTH_EVIDENCE = 'agy_oauth_credentials_recoverable';

function isAgyProvider(provider) {
  return String(provider || '').trim().toLowerCase() === 'agy';
}

function canRecoverAgyAuthInvalidBlock(provider, runtimeStatus, authMetadata, nowMs = Date.now()) {
  return Boolean(
    isAgyProvider(provider)
    && isAuthInvalidRuntimeStatus(runtimeStatus)
    && hasRecoverableAgyOAuthCredentials(authMetadata, nowMs)
  );
}

function resolveAgyRuntimeStatus(provider, runtimeStatus, authMetadata, nowMs = Date.now()) {
  if (!canRecoverAgyAuthInvalidBlock(provider, runtimeStatus, authMetadata, nowMs)) {
    return runtimeStatus;
  }
  return {
    status: 'healthy',
    until: 0,
    reason: ''
  };
}

function clearRecoverableAgyAuthInvalidBlock(options = {}) {
  const {
    provider,
    accountId,
    runtimeStatus,
    authMetadata,
    accountStateService,
    baseState,
    nowMs
  } = options;
  if (!canRecoverAgyAuthInvalidBlock(provider, runtimeStatus, authMetadata, nowMs)) return false;
  if (!accountStateService || typeof accountStateService.clearRuntimeBlock !== 'function') return false;
  return accountStateService.clearRuntimeBlock(provider, accountId, {
    ...(baseState && typeof baseState === 'object' ? baseState : {}),
    evidence: AGY_RECOVERABLE_OAUTH_EVIDENCE
  });
}

module.exports = {
  AGY_RECOVERABLE_OAUTH_EVIDENCE,
  canRecoverAgyAuthInvalidBlock,
  clearRecoverableAgyAuthInvalidBlock,
  resolveAgyRuntimeStatus
};
