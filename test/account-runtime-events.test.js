const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACCOUNT_RUNTIME_CHANGED,
  createAccountRuntimeEventHub,
  createRuntimeStateIndexListener,
  createServerPoolSyncListener
} = require('../lib/server/account-runtime-events');

test('account runtime event hub normalizes events and isolates listener errors', () => {
  const errors = [];
  const hub = createAccountRuntimeEventHub({
    onError(error, event) {
      errors.push({ message: error.message, accountId: event.accountId });
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
    accountId: '10015',
    nextStatus: 'auth_invalid',
    reason: 'auth_invalid_reauth_required'
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].provider, 'codex');
  assert.equal(received[0].accountId, '10015');
  assert.equal(received[0].source, 'unknown');
  assert.deepEqual(errors, [{ message: 'listener_failed', accountId: '10015' }]);
});

test('runtime state listener persists event payload without knowing server pool details', () => {
  const writes = [];
  const listener = createRuntimeStateIndexListener({
    accountStateService: {
      recordRuntimeFailure(provider, accountId, runtimeState, baseState) {
        writes.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    }
  });

  const ok = listener({
    provider: 'gemini',
    accountId: '3',
    runtimeState: { authInvalidUntil: 1000, lastFailureKind: 'auth_invalid' },
    baseState: { configured: true, apiKeyMode: false, displayName: 'g@example.com' }
  });

  assert.equal(ok, true);
  assert.deepEqual(writes, [{
    provider: 'gemini',
    accountId: '3',
    runtimeState: { authInvalidUntil: 1000, lastFailureKind: 'auth_invalid' },
    baseState: { configured: true, apiKeyMode: false, displayName: 'g@example.com' }
  }]);
});

test('server pool listener applies blocking runtime state and clears sticky sessions', () => {
  const now = Date.now();
  const state = {
    accounts: {
      codex: [{ id: '10015', provider: 'codex', email: 'old@example.com' }],
      gemini: [],
      claude: []
    },
    sessionAffinity: {
      codex: new Map([
        ['thread-a', { accountId: '10015', expiresAt: now + 60_000 }],
        ['thread-b', { accountId: '10016', expiresAt: now + 60_000 }]
      ]),
      gemini: new Map(),
      claude: new Map()
    },
    webUiModelsCache: { signature: 'old' }
  };
  const listener = createServerPoolSyncListener({ state });

  const changed = listener({
    provider: 'codex',
    accountId: '10015',
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
  const state = {
    accounts: { codex: [], gemini: [], claude: [] },
    sessionAffinity: { codex: new Map(), gemini: new Map(), claude: new Map() }
  };
  const listener = createServerPoolSyncListener({
    state,
    options: { port: 8317 },
    fs: {},
    accountStateIndex: {},
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({ configured: true }),
    loadServerRuntimeAccounts(args) {
      assert.equal(args.serverPort, 8317);
      return {
        codex: [{ id: '10022', provider: 'codex' }],
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
    accountId: '10022',
    nextStatus: 'healthy',
    runtimeState: null,
    reloadPool: true
  });

  assert.equal(reloaded, true);
  assert.equal(state.accounts.codex[0].id, '10022');
});
