const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACCOUNT_RUNTIME_CHANGED,
  createAccountRuntimeEventHub,
  createRuntimeStateIndexListener,
  createServerPoolSyncListener
} = require('../lib/server/account-runtime-events');

test('account runtime event hub normalizes events and isolates listener errors', () => {
  const accountRef = 'acct_10015000000000000000';
  const errors = [];
  const hub = createAccountRuntimeEventHub({
    onError(error, event) {
      errors.push({ message: error.message, accountRef: event.accountRef });
    }
  });
  const received = [];
  hub.on(ACCOUNT_RUNTIME_CHANGED, () => {
    throw new Error('listener_failed');
  });
  hub.on(ACCOUNT_RUNTIME_CHANGED, (event) => {
    received.push(event);
  });

  hub.emit(ACCOUNT_RUNTIME_CHANGED, {
    provider: 'Codex',
    accountRef,
    nextStatus: 'auth_invalid',
    reason: 'auth_invalid_reauth_required'
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].provider, 'codex');
  assert.equal(received[0].accountRef, accountRef);
  assert.equal(received[0].source, 'unknown');
  assert.deepEqual(errors, [{ message: 'listener_failed', accountRef }]);
});

test('runtime state listener persists event payload without knowing server pool details', () => {
  const accountRef = 'acct_30000000000000000000';
  const writes = [];
  const listener = createRuntimeStateIndexListener({
    accountStateService: {
      recordRuntimeFailure(capturedAccountRef, provider, runtimeState, baseState) {
        writes.push({ provider, accountRef: capturedAccountRef, runtimeState, baseState });
        return true;
      }
    }
  });

  const ok = listener({
    provider: 'gemini',
    accountRef,
    runtimeState: { authInvalidUntil: 1000, lastFailureKind: 'auth_invalid' },
    baseState: { configured: true, apiKeyMode: false, displayName: 'g@example.com' }
  });

  assert.equal(ok, true);
  assert.deepEqual(writes, [{
    provider: 'gemini',
    accountRef,
    runtimeState: { authInvalidUntil: 1000, lastFailureKind: 'auth_invalid' },
    baseState: { configured: true, apiKeyMode: false, displayName: 'g@example.com' }
  }]);
});

test('server pool listener applies blocking runtime state and clears sticky sessions', () => {
  const now = Date.now();
  const blockedRef = 'acct_10015000000000000000';
  const healthyRef = 'acct_10016000000000000000';
  const state = {
    accounts: {
      codex: [{ accountRef: blockedRef, provider: 'codex', email: 'old@example.com' }],
      gemini: [],
      claude: []
    },
    sessionAffinity: {
      codex: new Map([
        ['thread-a', { accountRef: blockedRef, expiresAt: now + 60_000 }],
        ['thread-b', { accountRef: healthyRef, expiresAt: now + 60_000 }]
      ]),
      gemini: new Map(),
      claude: new Map()
    },
    webUiModelsCache: { signature: 'old' }
  };
  const listener = createServerPoolSyncListener({ state });

  const changed = listener({
    provider: 'codex',
    accountRef: blockedRef,
    nextStatus: 'auth_invalid',
    runtimeState: {
      authInvalidUntil: now + 60_000,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: 'auth_invalid_reauth_required'
    }
  });

  assert.equal(changed, true);
  assert.equal(state.accounts.codex[0].lastFailureKind, 'auth_invalid');
  assert.equal(state.sessionAffinity.codex.has('thread-a'), false);
  assert.equal(state.sessionAffinity.codex.has('thread-b'), true);
  assert.equal(state.webUiModelsCache.signature, '');
  assert.equal(state.webUiModelsCache.updatedAt, 0);
});

test('server pool listener reloads runtime pool when event requests recovery reload', () => {
  const accountRef = 'acct_10022000000000000000';
  const state = {
    accounts: { codex: [], gemini: [], claude: [] },
    sessionAffinity: { codex: new Map(), gemini: new Map(), claude: new Map() }
  };
  const listener = createServerPoolSyncListener({
    state,
    options: { port: 8317 },
    aiHomeDir: '/tmp/aih-home',
    fs: {},
    accountStateIndex: {},
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({ configured: true }),
    loadServerRuntimeAccounts(args) {
      assert.equal(args.serverPort, 8317);
      assert.equal(args.aiHomeDir, '/tmp/aih-home');
      return {
        codex: [{ accountRef, provider: 'codex' }],
        gemini: [],
        claude: []
      };
    },
    applyReloadState(targetState, runtimeAccounts) {
      targetState.accounts = runtimeAccounts;
    }
  });

  const reloaded = listener({
    provider: 'codex',
    accountRef,
    nextStatus: 'healthy',
    runtimeState: null,
    reloadPool: true
  });

  assert.equal(reloaded, true);
  assert.equal(state.accounts.codex[0].accountRef, accountRef);
});
