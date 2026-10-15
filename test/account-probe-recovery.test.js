const test = require('node:test');
const assert = require('node:assert/strict');

const {
  accountProbeSucceeded,
  clearAccountRuntimeBlock,
  isAccountAuthBlocked,
  observeProbedAccounts
} = require('../lib/server/account-probe-recovery');
const { createAccountRuntimeGate } = require('../lib/server/account-runtime-gate');
const { ACCOUNT_RUNTIME_CHANGED } = require('../lib/server/account-runtime-event-types');

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

function createGate(events = []) {
  return createAccountRuntimeGate({
    hub: {
      emit(type, event) {
        if (type === ACCOUNT_RUNTIME_CHANGED) events.push(event);
        return true;
      }
    }
  });
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
  const recovered = observeProbedAccounts(state, discovery, {
    listAccountModelCacheRefs: (_p, a) => [a.accountRef]
  }).recovered;
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

test('probe success clears the auth block and publishes the cleared runtime state', () => {
  const account = blockedAccount();
  const state = { accounts: { opencode: [account] } };
  const discovery = {
    sourcesByAccount: { acct_aaaaaaaaaaaaaaaaaaaa: 'remote' },
    byAccount: { acct_aaaaaaaaaaaaaaaaaaaa: ['opencode-go/glm-5.2'] }
  };
  const events = [];
  const { recovered, failed } = observeProbedAccounts(state, discovery, {
    listAccountModelCacheRefs: (_provider, a) => (a.accountRef ? [a.accountRef] : []),
    gate: createGate(events)
  });
  assert.deepEqual(recovered, [{ provider: 'opencode', accountRef: account.accountRef, kind: 'auth_invalid' }]);
  assert.deepEqual(failed, []);
  assert.equal(isAccountAuthBlocked(account), false);
  // 持久化走统一事件链路：runtimeState 是清空后的运行态，reason 是证据名。
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'models_probe_success');
  assert.equal(events[0].source, 'server.probe.models');
  assert.equal(events[0].runtimeState.authInvalidUntil, 0);
  assert.equal(events[0].runtimeState.lastFailureKind, '');
  assert.equal(events[0].baseState.apiKeyMode, false);
});

test('probe failure is classified for the UI but never recorded as account state', () => {
  const account = blockedAccount({
    accountRef: 'acct_cccccccccccccccccccc',
    cooldownUntil: 0,
    authInvalidUntil: 0,
    lastFailureKind: '',
    lastError: '',
    consecutiveFailures: 0
  });
  const state = { accounts: { opencode: [account] } };
  const discovery = {
    sourcesByAccount: { acct_cccccccccccccccccccc: 'error' },
    byAccount: {},
    failuresByAccount: {
      acct_cccccccccccccccccccc: {
        reason: 'request_failed',
        statusCode: 401,
        detail: 'HTTP 401 {"error":{"code":"invalid_api_key"}}',
        error: Object.assign(new Error('HTTP 401'), { status: 401, code: 'HTTP_401' })
      }
    }
  };
  const events = [];
  const { recovered, failed } = observeProbedAccounts(state, discovery, {
    listAccountModelCacheRefs: (_provider, a) => [a.accountRef],
    gate: createGate(events)
  });
  assert.deepEqual(recovered, []);
  // 提示里能说清是什么错（与推理请求同一分类器），但账号状态一动不动。
  assert.deepEqual(failed, [{
    provider: 'opencode',
    accountRef: account.accountRef,
    kind: 'auth_invalid',
    scope: 'account',
    detail: 'HTTP 401 {"error":{"code":"invalid_api_key"}}'
  }]);
  assert.equal(account.lastFailureKind, '');
  assert.equal(account.authInvalidUntil, 0);
  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.consecutiveFailures, 0);
  assert.equal(events.length, 0, '探测失败不得发布运行态事件');
});

test('healthy accounts and empty catalogs stay untouched', () => {
  const healthy = blockedAccount({ accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', cooldownUntil: 0, authInvalidUntil: 0, lastFailureKind: '' });
  const emptyCatalog = blockedAccount({ accountRef: 'acct_dddddddddddddddddddd', cooldownUntil: 0, authInvalidUntil: 0, lastFailureKind: '' });
  const state = { accounts: { opencode: [healthy, emptyCatalog] } };
  const discovery = {
    sourcesByAccount: { acct_dddddddddddddddddddd: 'error' },
    byAccount: {},
    failuresByAccount: {
      acct_dddddddddddddddddddd: { reason: 'empty_catalog', statusCode: 0, detail: '模型目录为空' }
    }
  };
  const events = [];
  const result = observeProbedAccounts(state, discovery, {
    listAccountModelCacheRefs: (_provider, a) => [a.accountRef],
    gate: createGate(events)
  });
  assert.deepEqual(result, { recovered: [], failed: [] });
  assert.equal(events.length, 0);
  assert.equal(emptyCatalog.lastFailureKind, '');
});
