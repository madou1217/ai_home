'use strict';

const { hasRecoverableAgyOAuthCredentials } = require('./agy-auth-metadata');
const { isAuthInvalidRuntimeStatus } = require('./runtime-view');

const AGY_RECOVERABLE_OAUTH_EVIDENCE = 'agy_oauth_credentials_recoverable';
const AGY_NON_RECOVERABLE_AUTH_INVALID_REASONS = new Set([
  'agy_not_signed_in'
]);

function isAgyProvider(provider) {
  return String(provider || '').trim().toLowerCase() === 'agy';
}

function normalizeRuntimeReason(runtimeStatus) {
  return String(
    runtimeStatus && (
      runtimeStatus.reason
      || runtimeStatus.detail
      || runtimeStatus.lastFailureReason
      || runtimeStatus.lastError
    )
    || ''
  ).trim().toLowerCase();
}

function isNonRecoverableAgyAuthInvalidBlock(provider, runtimeStatus) {
  return Boolean(
    isAgyProvider(provider)
    && isAuthInvalidRuntimeStatus(runtimeStatus)
    && AGY_NON_RECOVERABLE_AUTH_INVALID_REASONS.has(normalizeRuntimeReason(runtimeStatus))
  );
}

function canRecoverAgyAuthInvalidBlock(provider, runtimeStatus, authMetadata, nowMs = Date.now()) {
  return Boolean(
    isAgyProvider(provider)
    && isAuthInvalidRuntimeStatus(runtimeStatus)
    // Static credential presence can only repair old, reason-less blocks.
    // A recorded auth failure must remain blocked until active evidence such as
    // login, token refresh, upstream traffic, or a usage probe succeeds.
    && !normalizeRuntimeReason(runtimeStatus)
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
    accountRef,
    runtimeStatus,
    authMetadata,
    accountStateService,
    baseState,
    nowMs
  } = options;
  if (!canRecoverAgyAuthInvalidBlock(provider, runtimeStatus, authMetadata, nowMs)) return false;
  if (!accountStateService || typeof accountStateService.clearRuntimeBlock !== 'function') return false;
  return accountStateService.clearRuntimeBlock(accountRef, provider, {
    ...(baseState && typeof baseState === 'object' ? baseState : {}),
    evidence: AGY_RECOVERABLE_OAUTH_EVIDENCE
  });
}

module.exports = {
  AGY_RECOVERABLE_OAUTH_EVIDENCE,
  canRecoverAgyAuthInvalidBlock,
  clearRecoverableAgyAuthInvalidBlock,
  isNonRecoverableAgyAuthInvalidBlock,
  resolveAgyRuntimeStatus
};
