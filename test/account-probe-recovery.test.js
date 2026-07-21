const test = require('node:test');
const assert = require('node:assert/strict');

const {
  accountProbeSucceeded,
  clearAccountRuntimeBlock,
  isAccountAuthBlocked,
  recoverProbedAccounts
} = require('../lib/server/account-probe-recovery');

function blockedAccount(overrides = {}) {
  return {
    provider: 'opencode',
    accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa',
    apiKeyMode: false,
    displayName: 'OpenCode Go API',
    cooldownUntil: Date.now() + 365 * 24 * 3600 * 1000,
    authInvalidUntil: Date.now() + 365 * 24 * 3600 * 1000,
    lastFailureKind: 'auth_invalid',
    lastError: 'upstream_401',
    consecutiveFailures: 1,
    ...overrides
  };
}

test('isAccountAuthBlocked flags auth circuits and clear resets them', () => {
  const account = blockedAccount();
  assert.equal(isAccountAuthBlocked(account), true);
  clearAccountRuntimeBlock(account);
  assert.equal(isAccountAuthBlocked(account), false);
  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.authInvalidUntil, 0);
  assert.equal(account.lastFailureKind, '');
});

test('rate-limit cooldowns are NOT treated as auth blocks — probe success must not clear them', () => {
  const rateLimited = blockedAccount({
    authInvalidUntil: 0,
    lastFailureKind: 'rate_limited',
    lastError: 'HTTP 429 GoUsageLimitError',
    rateLimitUntil: Date.now() + 5 * 60 * 1000
  });
  assert.equal(isAccountAuthBlocked(rateLimited), false);
  const state = { accounts: { opencode: [rateLimited] } };
  const discovery = {
    sourcesByAccount: { acct_aaaaaaaaaaaaaaaaaaaa: 'remote' },
    byAccount: { acct_aaaaaaaaaaaaaaaaaaaa: ['opencode-go/glm-5.2'] }
  };
  const recovered = recoverProbedAccounts(state, discovery, {
    listAccountModelCacheRefs: (_p, a) => [a.accountRef],
    accountStateService: { clearRuntimeBlock: () => { throw new Error('must not clear rate limits'); } }
  });
  assert.deepEqual(recovered, []);
  assert.equal(rateLimited.rateLimitUntil > Date.now(), true);
  assert.equal(rateLimited.cooldownUntil > Date.now(), true);
});

test('accountProbeSucceeded requires remote source AND non-empty models', () => {
  const discovery = {
    sourcesByAccount: { a: 'remote', b: 'remote', c: 'local' },
    byAccount: { a: ['m1'], b: [], c: ['m2'] }
  };
  assert.equal(accountProbeSucceeded(discovery, ['a']), true);
  assert.equal(accountProbeSucceeded(discovery, ['b']), false, 'empty remote result is not evidence');
  assert.equal(accountProbeSucceeded(discovery, ['c']), false, 'local cache is not evidence');
  assert.equal(accountProbeSucceeded(discovery, []), false);
});

test('recoverProbedAccounts clears memory block and persists via accountStateService', () => {
  const account = blockedAccount();
  const state = { accounts: { opencode: [account] } };
  const discovery = {
    sourcesByAccount: { acct_aaaaaaaaaaaaaaaaaaaa: 'remote' },
    byAccount: { acct_aaaaaaaaaaaaaaaaaaaa: ['opencode-go/glm-5.2'] }
  };
  const cleared = [];
  const recovered = recoverProbedAccounts(state, discovery, {
    listAccountModelCacheRefs: (_provider, a) => (a.accountRef ? [a.accountRef] : []),
    accountStateService: {
      clearRuntimeBlock: (accountRef, provider, baseState) => {
        cleared.push({ provider, accountRef, evidence: baseState.evidence });
        return true;
      }
    }
  });
  assert.deepEqual(recovered, [{ provider: 'opencode', accountRef: account.accountRef }]);
  assert.equal(isAccountAuthBlocked(account), false);
  assert.deepEqual(cleared, [{
    provider: 'opencode',
    accountRef: account.accountRef,
    evidence: 'models_probe_success'
  }]);
});

test('recoverProbedAccounts leaves healthy and probe-failed accounts untouched', () => {
  const healthy = blockedAccount({ accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', cooldownUntil: 0, authInvalidUntil: 0, lastFailureKind: '' });
  const probeFailed = blockedAccount({ accountRef: 'acct_cccccccccccccccccccc' });
  const state = { accounts: { opencode: [healthy, probeFailed] } };
  const discovery = {
    sourcesByAccount: { acct_cccccccccccccccccccc: 'error' },
    byAccount: {}
  };
  const recovered = recoverProbedAccounts(state, discovery, {
    listAccountModelCacheRefs: (_provider, a) => [a.accountRef],
    accountStateService: { clearRuntimeBlock: () => { throw new Error('must not persist'); } }
  });
  assert.deepEqual(recovered, []);
  assert.equal(isAccountAuthBlocked(probeFailed), true);
});
