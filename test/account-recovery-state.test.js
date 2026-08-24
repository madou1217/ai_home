'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACCOUNT_RECOVERY_REASON_PREFIX,
  isSystemRetainedRecoveryState,
  resolveStatusAfterOauthSuccess
} = require('../lib/account/account-recovery-state');

test('explicit reauth re-enables the selected account while ordinary oauth preserves status', () => {
  const retained = {
    status: 'down',
    runtimeState: {
      lastFailureReason: `${ACCOUNT_RECOVERY_REASON_PREFIX}refresh_http_401`
    }
  };
  const legacyMarkerless = {
    status: 'down',
    runtimeState: null
  };

  assert.equal(isSystemRetainedRecoveryState(retained), true);
  assert.equal(resolveStatusAfterOauthSuccess(retained, { reauth: true }), 'up');
  assert.equal(resolveStatusAfterOauthSuccess(retained, { reauth: false }), 'down');
  assert.equal(resolveStatusAfterOauthSuccess(legacyMarkerless, { reauth: true }), 'up');
  assert.equal(resolveStatusAfterOauthSuccess(legacyMarkerless, { reauth: false }), 'down');
});
