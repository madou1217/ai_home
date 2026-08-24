'use strict';

const { resolveEffectiveAccountStatus } = require('./status-file');

const ACCOUNT_RECOVERY_REASON_PREFIX = 'account_recovery_required:';

function getRuntimeFailureReason(runtimeState) {
  if (!runtimeState || typeof runtimeState !== 'object') return '';
  return String(runtimeState.lastFailureReason || runtimeState.lastError || '').trim();
}

function isSystemRetainedRecoveryState(state) {
  return getRuntimeFailureReason(state && state.runtimeState)
    .startsWith(ACCOUNT_RECOVERY_REASON_PREFIX);
}

function resolveStatusAfterOauthSuccess(state, options = {}) {
  if (options.reauth) return 'up';
  return resolveEffectiveAccountStatus(state && state.status);
}

module.exports = {
  ACCOUNT_RECOVERY_REASON_PREFIX,
  getRuntimeFailureReason,
  isSystemRetainedRecoveryState,
  resolveStatusAfterOauthSuccess
};
