const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountStateService } = require('../lib/account/state-service');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');

const ACCOUNT_REF_1 = getPublicAccountRef('unique:state-1@example.com');
const ACCOUNT_REF_2 = getPublicAccountRef('unique:state-2@example.com');
const ACCOUNT_REF_5 = getPublicAccountRef('unique:state-5@example.com');

test('account state service writes operational status through the accountRef boundary', () => {
  const calls = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState(accountRef) {
        assert.equal(accountRef, ACCOUNT_REF_1);
        return {
          accountRef: ACCOUNT_REF_1,
          status: 'up',
          configured: true,
          apiKeyMode: false,
          displayName: 'user@example.com',
          runtimeState: {
            authInvalidUntil: Date.now() + 60_000,
            lastFailureKind: 'auth_invalid',
            lastFailureReason: 'auth_invalid_reauth_required'
          }
        };
      },
      setStatus(accountRef, status) {
        calls.push({ op: 'setStatus', accountRef, status });
        return true;
      }
    }
  });

  assert.equal(service.setOperationalStatus(ACCOUNT_REF_1, 'Codex', 'down'), true);
  assert.deepEqual(calls.find((call) => call.op === 'setStatus'), {
    op: 'setStatus',
    accountRef: ACCOUNT_REF_1,
    status: 'down'
  });
});

test('account state service requires evidence before clearing runtime block', () => {
  const writes = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState() {
        return {
          accountRef: ACCOUNT_REF_1,
          status: 'up',
          configured: true,
          apiKeyMode: false,
          displayName: 'user@example.com',
          runtimeState: {
            authInvalidUntil: Date.now() + 60_000,
            lastFailureKind: 'auth_invalid',
            lastFailureReason: 'auth_invalid_reauth_required'
          }
        };
      },
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        writes.push({ accountRef, provider, runtimeState, baseState });
        return true;
      }
    }
  });

  assert.equal(service.clearRuntimeBlock(ACCOUNT_REF_1, 'codex', { evidence: 'account_read_metadata' }), false);
  assert.equal(writes.length, 0);
  assert.equal(service.clearRuntimeBlock(ACCOUNT_REF_1, 'codex', { evidence: 'token_refresh_success' }), true);
  assert.deepEqual(writes, [{
    accountRef: ACCOUNT_REF_1,
    provider: 'codex',
    runtimeState: null,
    baseState: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      authMode: '',
      displayName: 'user@example.com'
    }
  }]);
});

test('account state service syncs base state without writing runtime null when no block exists', () => {
  const writes = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState() {
        return {
          accountRef: ACCOUNT_REF_1,
          status: 'up',
          configured: true,
          apiKeyMode: false,
          displayName: 'user@example.com',
          runtimeState: null
        };
      },
      upsertAccountState(accountRef, provider, baseState) {
        writes.push({ op: 'base', accountRef, provider, baseState });
        return true;
      },
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        writes.push({ op: 'runtime', accountRef, provider, runtimeState, baseState });
        return true;
      }
    }
  });

  assert.equal(service.clearRuntimeBlock(ACCOUNT_REF_1, 'codex', {
    evidence: 'token_refresh_success',
    displayName: 'fresh@example.com'
  }), true);
  assert.deepEqual(writes, [{
    op: 'base',
    accountRef: ACCOUNT_REF_1,
    provider: 'codex',
    baseState: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      authMode: '',
      displayName: 'fresh@example.com'
    }
  }]);
});

test('account state service accepts verified api key config as runtime clear evidence', () => {
  const writes = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState() {
        return {
          accountRef: ACCOUNT_REF_1,
          status: 'up',
          configured: true,
          apiKeyMode: false,
          displayName: 'proxy.example.com',
          runtimeState: {
            authInvalidUntil: Date.now() + 60_000,
            lastFailureKind: 'auth_invalid',
            lastFailureReason: 'upstream_401'
          }
        };
      },
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        writes.push({ accountRef, provider, runtimeState, baseState });
        return true;
      }
    }
  });

  assert.equal(service.clearRuntimeBlock(ACCOUNT_REF_1, 'codex', {
    evidence: 'api_key_config_verified',
    configured: true,
    apiKeyMode: true,
    authMode: 'api-key',
    displayName: 'proxy.example.com'
  }), true);
  assert.deepEqual(writes, [{
    accountRef: ACCOUNT_REF_1,
    provider: 'codex',
    runtimeState: null,
    baseState: {
      status: 'up',
      configured: true,
      apiKeyMode: true,
      authMode: 'api-key',
      displayName: 'proxy.example.com'
    }
  }]);
});

test('account state service preserves active model cooldowns when clearing account-wide runtime block', () => {
  const now = Date.now();
  const writes = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState() {
        return {
          accountRef: ACCOUNT_REF_5,
          status: 'up',
          configured: true,
          apiKeyMode: false,
          authMode: 'oauth-personal',
          displayName: 'agy5@example.com',
          runtimeState: {
            cooldownUntil: now + 60_000,
            authInvalidUntil: now + 60_000,
            lastFailureKind: 'auth_invalid',
            lastFailureReason: 'token_expired',
            lastFailureAt: now - 1_000,
            modelCooldowns: {
              'claude-sonnet-4-6': now + 24 * 60 * 60 * 1000,
              'old-model': now - 1_000
            },
            modelFailures: {
              'claude-sonnet-4-6': 2,
              'old-model': 1
            }
          }
        };
      },
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        writes.push({ accountRef, provider, runtimeState, baseState });
        return true;
      }
    }
  });

  assert.equal(service.clearRuntimeBlock(ACCOUNT_REF_5, 'agy', { evidence: 'token_refresh_success' }), true);
  assert.equal(writes[0].runtimeState.cooldownUntil, 0);
  assert.equal(writes[0].runtimeState.authInvalidUntil, 0);
  assert.deepEqual(writes[0].runtimeState.modelCooldowns, {
    'claude-sonnet-4-6': now + 24 * 60 * 60 * 1000
  });
  assert.deepEqual(writes[0].runtimeState.modelFailures, {
    'claude-sonnet-4-6': 2
  });
});

test('account state service refuses token refresh clear for agy cli login-missing block', () => {
  const now = Date.now();
  const writes = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState() {
        return {
          accountRef: ACCOUNT_REF_5,
          status: 'up',
          configured: true,
          apiKeyMode: false,
          authMode: 'oauth',
          displayName: 'agy5@example.com',
          runtimeState: {
            cooldownUntil: now + 60_000,
            authInvalidUntil: now + 60_000,
            lastFailureKind: 'auth_invalid',
            lastFailureReason: 'agy_not_signed_in',
            lastError: 'agy_not_signed_in',
            lastFailureAt: now - 1_000
          }
        };
      },
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        writes.push({ accountRef, provider, runtimeState, baseState });
        return true;
      }
    }
  });

  assert.equal(service.clearRuntimeBlock(ACCOUNT_REF_5, 'agy', { evidence: 'token_refresh_success' }), false);
  assert.equal(service.clearRuntimeBlock(ACCOUNT_REF_5, 'agy', { evidence: 'agy_oauth_credentials_recoverable' }), false);
  assert.equal(service.clearRuntimeBlock(ACCOUNT_REF_5, 'agy', { evidence: 'upstream_success' }), false);
  assert.equal(writes.length, 0);
  assert.equal(service.clearRuntimeBlock(ACCOUNT_REF_5, 'agy', { evidence: 'manual_admin_clear' }), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].runtimeState, null);
});

test('account state service records runtime failures with merged base state', () => {
  const writes = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState() {
        return {
          accountRef: ACCOUNT_REF_2,
          status: 'down',
          configured: false,
          apiKeyMode: false,
          authMode: 'oauth-browser',
          displayName: 'old@example.com'
        };
      },
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        writes.push({ accountRef, provider, runtimeState, baseState });
        return true;
      }
    }
  });

  assert.equal(service.recordRuntimeFailure(ACCOUNT_REF_2, 'codex', {
    authInvalidUntil: 123,
    lastFailureKind: 'auth_invalid'
  }, {
    configured: true,
    displayName: 'new@example.com'
  }), true);

  assert.deepEqual(writes[0], {
    accountRef: ACCOUNT_REF_2,
    provider: 'codex',
    runtimeState: {
      authInvalidUntil: 123,
      lastFailureKind: 'auth_invalid'
    },
    baseState: {
      status: 'down',
      configured: true,
      apiKeyMode: false,
      authMode: 'oauth-browser',
      displayName: 'new@example.com'
    }
  });
});
