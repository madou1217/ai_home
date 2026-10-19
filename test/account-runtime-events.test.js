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

test('server pool listener keeps the model catalog when an account is only rate limited', () => {
  // 429 只说明「现在别打这个账号」，不说明它有哪些模型；清空目录会让别名预检
  // 无据可依，把正常的别名目标判成 alias_target_model_not_in_catalog。
  const now = Date.now();
  const limitedRef = 'acct_10017000000000000000';
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [{ accountRef: limitedRef, provider: 'claude', email: 'rate@example.com' }]
    },
    sessionAffinity: {
      codex: new Map(),
      gemini: new Map(),
      claude: new Map([['thread-a', { accountRef: limitedRef, expiresAt: now + 60_000 }]])
    },
    webUiModelsCache: {
      signature: 'warm',
      updatedAt: now,
      byProvider: { claude: ['claude-opus-5'] }
    }
  };
  const listener = createServerPoolSyncListener({ state });

  const changed = listener({
    provider: 'claude',
    accountRef: limitedRef,
    nextStatus: 'rate_limited',
    runtimeState: {
      rateLimitUntil: now + 60_000,
      lastFailureKind: 'rate_limited',
      lastFailureReason: 'upstream_429'
    }
  });

  assert.equal(changed, true);
  // 会话粘性照旧要解绑：账号确实暂时不能用。
  assert.equal(state.sessionAffinity.claude.has('thread-a'), false);
  // 模型目录必须原封不动。
  assert.equal(state.webUiModelsCache.signature, 'warm');
  assert.equal(state.webUiModelsCache.updatedAt, now);
  assert.deepEqual(state.webUiModelsCache.byProvider, { claude: ['claude-opus-5'] });
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

// 2026-10-19 事故：重建池时对 codex 账号做「已验证恢复」，恢复事件（runtimeState:null）又触发重建，
// 同步无限递归 → 栈溢出被 hub 吞掉、进程 100% CPU、网关拒绝所有连接。重建必须不可重入。
test('a pool reload that emits recovery events does not re-enter itself', () => {
  const accountRef = 'acct_10015000000000000099';
  const errors = [];
  const hub = createAccountRuntimeEventHub({ onError: (error) => errors.push(error.message) });
  const state = { accounts: { codex: [] } };
  let loads = 0;
  const deps = {
    state,
    applyReloadState: (target, accounts) => { target.accounts = accounts; },
    loadServerRuntimeAccounts: () => {
      loads += 1;
      if (loads > 50) throw new Error('reload recursion');
      // 与 mergePersistedRuntimeFields → observeRecovery 同形：加载过程中发出恢复事件。
      hub.emit(ACCOUNT_RUNTIME_CHANGED, { provider: 'codex', accountRef, runtimeState: null, nextStatus: 'up', reason: 'verified_usage_success' });
      return { codex: [{ accountRef, provider: 'codex' }] };
    }
  };
  hub.on(ACCOUNT_RUNTIME_CHANGED, createServerPoolSyncListener(deps));

  hub.emit(ACCOUNT_RUNTIME_CHANGED, { provider: 'codex', accountRef, runtimeState: null, nextStatus: 'up', reason: 'manual_admin_clear' });
  assert.equal(loads, 1, 'the nested recovery event must not reload again');
  assert.deepEqual(errors, []);
  assert.equal(state.accounts.codex[0].accountRef, accountRef);

  // 标记在异常时也必须复位，否则之后的重建永远被跳过。
  let failNext = true;
  deps.loadServerRuntimeAccounts = () => {
    loads += 1;
    if (failNext) { failNext = false; throw new Error('load failed'); }
    return { codex: [] };
  };
  hub.emit(ACCOUNT_RUNTIME_CHANGED, { provider: 'codex', accountRef, runtimeState: null, reason: 'x' });
  hub.emit(ACCOUNT_RUNTIME_CHANGED, { provider: 'codex', accountRef, runtimeState: null, reason: 'y' });
  assert.equal(loads, 3);
  assert.deepEqual(state.accounts.codex, []);
});
