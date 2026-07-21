const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveRequestProvider,
  chooseServerAccount,
  pickWeightedRandomAccount,
  markProxyAccountSuccess,
  markProxyAccountFailure
} = require('../lib/server/router');
const {
  summarizeAccountAvailability,
  buildNoAvailableAccountResponse
} = require('../lib/server/account-availability');

const accountRef = (value) => `acct_${String(value).padStart(20, '0')}`;

test('resolveRequestProvider respects explicit mode and model hint', () => {
  assert.equal(resolveRequestProvider({ provider: 'codex' }, { model: 'gemini-2.5-flash' }), 'codex');
  assert.equal(resolveRequestProvider({ provider: 'gemini' }, { model: 'gpt-4o-mini' }), 'gemini');
  assert.equal(resolveRequestProvider({ provider: 'claude' }, { model: 'gpt-4o-mini' }), 'claude');
  assert.equal(resolveRequestProvider({ provider: 'agy' }, { model: 'gemini-2.5-flash' }), 'agy');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { provider: 'agy', model: 'gemini-2.5-flash' }), 'agy');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'agy-gemini-3-flash' }), 'agy');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'antigravity-gemini-3-flash' }), 'agy');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'Gemini 3.5 Flash (High)' }), 'gemini');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'gemini-3.5-flash-low' }), 'gemini');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'Claude Sonnet 4.6 (Thinking)' }), 'claude');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'claude-4-6-thinking' }), 'claude');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'GPT-OSS 120B (Medium)' }), 'codex');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'gemini-3.1-pro-preview' }), 'gemini');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'gemini-3.1-pro-high' }), 'gemini');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'gemini-2.5-pro' }), 'gemini');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'claude-sonnet-4-5' }), 'claude');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'gpt-dynamic' }), 'codex');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, {}), 'codex');
  assert.equal(
    resolveRequestProvider(
      { provider: 'auto' },
      { model: 'qwen3.6-plus' },
      { 'x-provider': 'claude' }
    ),
    'claude'
  );
});

test('resolveRequestProvider prefers catalog model availability over codex fallback', () => {
  const state = {
    accounts: {
      codex: [{
        accountRef: accountRef('10014'),
        provider: 'codex',
        apiKeyMode: true,
        authType: 'api-key',
        accessToken: 'sk-live',
        openaiBaseUrl: 'https://relay.example.com/v1',
        availableModels: ['qwen3.6-plus']
      }],
      gemini: [],
      claude: [{
        accountRef: accountRef('3'),
        provider: 'claude',
        accessToken: 'anthropic-token',
        availableModels: ['qwen3.6-plus']
      }]
    },
    webUiModelsCache: {
      byProvider: {
        codex: ['gpt-5.4'],
        gemini: ['gemini-2.5-pro'],
        claude: ['qwen3.6-plus']
      }
    }
  };

  assert.equal(
    resolveRequestProvider({ provider: 'auto' }, { model: 'qwen3.6-plus' }, {}, state),
    'claude'
  );
  assert.equal(
    resolveRequestProvider({ provider: 'auto' }, { model: 'shared-public-model' }, {}, {
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: []
      },
      webUiModelsCache: {
        byProvider: {
          agy: ['shared-public-model']
        }
      }
    }),
    'agy'
  );
  assert.equal(
    resolveRequestProvider({ provider: 'auto' }, { model: 'qwen3.6-plus' }, {}, {
      accounts: {
        codex: [{
          accountRef: accountRef('10014'),
          provider: 'codex',
          apiKeyMode: true,
          authType: 'api-key',
          accessToken: 'sk-live',
          openaiBaseUrl: 'https://relay.example.com/v1',
          availableModels: ['qwen3.6-plus']
        }],
        gemini: [],
        claude: []
      }
    }),
    'codex'
  );
});

test('chooseServerAccount does round-robin and skips cooldown', () => {
  const now = Date.now();
  const accounts = [
    { accountRef: accountRef('1'), cooldownUntil: now + 60_000 },
    { accountRef: accountRef('2'), cooldownUntil: 0 },
    { accountRef: accountRef('3'), cooldownUntil: 0 }
  ];
  const state = { strategy: 'round-robin', cursor: 0 };

  const a1 = chooseServerAccount(accounts, state, 'cursor');
  const a2 = chooseServerAccount(accounts, state, 'cursor');
  const a3 = chooseServerAccount(accounts, state, 'cursor');

  assert.equal(a1.accountRef, accountRef('2'));
  assert.equal(a2.accountRef, accountRef('3'));
  assert.equal(a3.accountRef, accountRef('2'));
});

test('chooseServerAccount reads strategy from selection state and cursor from cursor state', () => {
  const accounts = [
    { accountRef: accountRef('1'), cooldownUntil: 0 },
    { accountRef: accountRef('2'), cooldownUntil: 0 },
    { accountRef: accountRef('3'), cooldownUntil: 0 },
    { accountRef: accountRef('4'), cooldownUntil: 0 }
  ];
  const state = { strategy: 'random', cursors: { agy: 1 } };
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.9999;
    const picked = chooseServerAccount(accounts, state, 'agy', {
      provider: 'agy',
      cursorState: state.cursors
    });

    assert.equal(picked.accountRef, accountRef('4'));
    assert.equal(state.cursors.agy, 1);
  } finally {
    Math.random = originalRandom;
  }
});

test('chooseServerAccount writes round-robin cursor into state.cursors when present', () => {
  const accounts = [
    { accountRef: accountRef('1'), cooldownUntil: 0 },
    { accountRef: accountRef('2'), cooldownUntil: 0 },
    { accountRef: accountRef('3'), cooldownUntil: 0 }
  ];
  const state = { strategy: 'round-robin', cursors: { agy: 1 } };

  const picked = chooseServerAccount(accounts, state, 'agy', { provider: 'agy' });

  assert.equal(picked.accountRef, accountRef('2'));
  assert.equal(state.cursors.agy, 2);
});

test('pickWeightedRandomAccount favors higher remainingPct weights', () => {
  const accounts = [
    { accountRef: accountRef('1'), remainingPct: 1 },
    { accountRef: accountRef('2'), remainingPct: 100 }
  ];
  const originalRandom = Math.random;
  Math.random = () => 0.9999;
  try {
    const picked = pickWeightedRandomAccount(accounts);
    assert.equal(picked.accountRef, accountRef('2'));
  } finally {
    Math.random = originalRandom;
  }
});

test('chooseServerAccount keeps sticky session when session key is provided', () => {
  const now = Date.now();
  const accounts = [
    { accountRef: accountRef('1'), cooldownUntil: now + 60_000, remainingPct: 10 },
    { accountRef: accountRef('2'), cooldownUntil: 0, remainingPct: 90 },
    { accountRef: accountRef('3'), cooldownUntil: 0, remainingPct: 30 }
  ];
  const state = { strategy: 'random' };
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.1;
    const first = chooseServerAccount(accounts, state, 'codex', { provider: 'codex', sessionKey: 'sess-1' });
    assert.equal(first.accountRef, accountRef('2'));

    Math.random = () => 0.99;
    const second = chooseServerAccount(accounts, state, 'codex', { provider: 'codex', sessionKey: 'sess-1' });
    assert.equal(second.accountRef, accountRef('2'));
  } finally {
    Math.random = originalRandom;
  }
});

test('chooseServerAccount prefers the configured default for a new session', () => {
  const accounts = [
    { accountRef: 'acct_first', remainingPct: 50 },
    { accountRef: 'acct_default', remainingPct: 50 }
  ];
  const picked = chooseServerAccount(accounts, { cursor: 0 }, 'cursor', {
    provider: 'codex',
    preferredAccountRef: 'acct_default',
    sessionKey: 'new-session'
  });

  assert.equal(picked.accountRef, 'acct_default');
});

test('chooseServerAccount preserves existing affinity when the default changes', () => {
  const accounts = [
    { accountRef: 'acct_first', remainingPct: 50 },
    { accountRef: 'acct_default', remainingPct: 50 }
  ];
  const state = {};
  const first = chooseServerAccount(accounts, state, 'codex', {
    provider: 'codex',
    preferredAccountRef: 'acct_first',
    sessionKey: 'existing-session'
  });
  const second = chooseServerAccount(accounts, state, 'codex', {
    provider: 'codex',
    preferredAccountRef: 'acct_default',
    sessionKey: 'existing-session'
  });

  assert.equal(first.accountRef, 'acct_first');
  assert.equal(second.accountRef, 'acct_first');
});

test('chooseServerAccount falls back when the default is unavailable, already attempted, or outside the model pool', () => {
  const accounts = [
    { accountRef: 'acct_default', remainingPct: 0 },
    { accountRef: 'acct_fallback', remainingPct: 50 }
  ];
  const unavailable = chooseServerAccount(accounts, { cursor: 0 }, 'cursor', {
    provider: 'codex',
    preferredAccountRef: 'acct_default'
  });
  const attempted = chooseServerAccount([
    { accountRef: 'acct_default', remainingPct: 50 },
    { accountRef: 'acct_fallback', remainingPct: 50 }
  ], { cursor: 0 }, 'cursor', {
    provider: 'codex',
    preferredAccountRef: 'acct_default',
    excludeAccountRefs: new Set(['acct_default'])
  });
  const modelFiltered = chooseServerAccount([
    { accountRef: 'acct_fallback', remainingPct: 50 }
  ], { cursor: 0 }, 'cursor', {
    provider: 'codex',
    preferredAccountRef: 'acct_default'
  });

  assert.equal(unavailable.accountRef, 'acct_fallback');
  assert.equal(attempted.accountRef, 'acct_fallback');
  assert.equal(modelFiltered.accountRef, 'acct_fallback');
});

test('chooseServerAccount honors excludeAccountRefs to avoid duplicate picks in one request', () => {
  const now = Date.now();
  const accounts = [
    { accountRef: accountRef('1'), cooldownUntil: 0, remainingPct: 90 },
    { accountRef: accountRef('2'), cooldownUntil: 0, remainingPct: 10 },
    { accountRef: accountRef('3'), cooldownUntil: now + 60_000, remainingPct: 100 }
  ];
  const state = { strategy: 'random' };
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.01;
    const first = chooseServerAccount(accounts, state, 'codex', { provider: 'codex' });
    assert.equal(first.accountRef, accountRef('1'));

    const second = chooseServerAccount(accounts, state, 'codex', {
      provider: 'codex',
      excludeAccountRefs: new Set([accountRef('1')])
    });
    assert.equal(second.accountRef, accountRef('2'));
  } finally {
    Math.random = originalRandom;
  }
});

test('chooseServerAccount skips policy-blocked accounts and exhausted remainingPct=0 accounts', () => {
  const accounts = [
    { accountRef: accountRef('1'), cooldownUntil: 0, schedulableStatus: 'blocked_by_policy', schedulableReason: 'codex_team_plan_missing_rate_limits', remainingPct: 80 },
    { accountRef: accountRef('2'), cooldownUntil: 0, remainingPct: 0 },
    { accountRef: accountRef('3'), cooldownUntil: 0, remainingPct: 45 }
  ];
  const state = { strategy: 'round-robin', cursor: 0 };

  const picked = chooseServerAccount(accounts, state, 'cursor');
  assert.equal(picked.accountRef, accountRef('3'));
});

test('chooseServerAccount applies persisted runtime state before selecting an account', () => {
  const now = Date.now();
  const accounts = [
    { accountRef: accountRef('1'), cooldownUntil: 0, remainingPct: 90 },
    { accountRef: accountRef('2'), cooldownUntil: 0, remainingPct: 80 }
  ];
  const state = { strategy: 'round-robin', cursor: 0 };
  const accountStateIndex = {
    getAccountState(ref) {
      if (ref === accountRef('1')) {
        return {
          runtimeState: {
            cooldownUntil: now + 60_000,
            authInvalidUntil: now + 60_000,
            lastFailureKind: 'auth_invalid',
            lastFailureReason: 'token_expired'
          }
        };
      }
      return null;
    }
  };

  const picked = chooseServerAccount(accounts, state, 'gemini', {
    provider: 'gemini',
    accountStateIndex
  });

  assert.equal(picked.accountRef, accountRef('2'));
  assert.equal(accounts[0].lastFailureReason, 'token_expired');
});

test('chooseServerAccount lets cleared persisted runtime state recover stale in-memory account', () => {
  const now = Date.now();
  const accounts = [
    {
      accountRef: accountRef('3'),
      cooldownUntil: now + 60_000,
      rateLimitUntil: now + 60_000,
      lastFailureKind: 'rate_limited',
      lastFailureReason: 'usage_limit_reached',
      remainingPct: 90
    }
  ];
  const state = { strategy: 'round-robin', cursor: 0 };
  const accountStateIndex = {
    getAccountState(ref) {
      if (ref === accountRef('3')) {
        return {
          runtimeState: null
        };
      }
      return null;
    }
  };

  const picked = chooseServerAccount(accounts, state, 'claude', {
    provider: 'claude',
    accountStateIndex
  });

  assert.equal(picked.accountRef, accountRef('3'));
  assert.equal(accounts[0].cooldownUntil, 0);
  assert.equal(accounts[0].rateLimitUntil, 0);
  assert.equal(accounts[0].lastFailureKind, '');
});

test('summarizeAccountAvailability explains why no account can be selected', () => {
  const now = Date.now();
  const summary = summarizeAccountAvailability([
    {
      accountRef: accountRef('1'),
      schedulableStatus: 'blocked_by_runtime_status',
      schedulableReason: 'auth_invalid',
      runtimeReason: 'auth_invalid_reauth_required',
      cooldownUntil: now + 60_000
    },
    {
      accountRef: accountRef('2'),
      schedulableStatus: 'blocked_by_policy',
      schedulableReason: 'codex_free_plan_below_server_min_remaining',
      cooldownUntil: 0
    },
    {
      accountRef: accountRef('3'),
      schedulableStatus: 'schedulable',
      cooldownUntil: now + 30_000,
      lastError: 'upstream_502'
    }
  ], {
    provider: 'codex',
    now
  });

  assert.equal(summary.total, 3);
  assert.equal(summary.available, 0);
  assert.match(summary.detail, /blocked_by_runtime_status:auth_invalid_reauth_required=1/);
  assert.match(summary.detail, /blocked_by_policy:codex_free_plan_below_server_min_remaining=1/);
  assert.match(summary.detail, /cooldown:upstream_502=1/);
});

test('summarizeAccountAvailability treats model cooldown as unavailable only for that model', () => {
  const now = Date.now();
  const account = {
    accountRef: accountRef('1'),
    schedulableStatus: 'schedulable',
    cooldownUntil: 0,
    modelCooldowns: {
      'gpt-5.5': now + 60_000
    },
    lastError: 'model quota exhausted'
  };

  const cooled = summarizeAccountAvailability([account], {
    provider: 'codex',
    model: 'gpt-5.5',
    now
  });
  const otherModel = summarizeAccountAvailability([account], {
    provider: 'codex',
    model: 'gpt-5.3-codex',
    now
  });

  assert.equal(cooled.available, 0);
  assert.match(cooled.detail, /model_cooldown:gpt-5\.5:model quota exhausted=1/);
  assert.equal(otherModel.available, 1);
});

test('no available account response uses 401 when every account is auth invalid', () => {
  const now = Date.now();
  const response = buildNoAvailableAccountResponse('gemini', [
    {
      accountRef: accountRef('1'),
      cooldownUntil: now + 60_000,
      lastFailureReason: 'auth_invalid_reauth_required',
      authInvalidUntil: now + 60_000
    },
    {
      accountRef: accountRef('2'),
      schedulableStatus: 'blocked_by_runtime_status',
      schedulableReason: 'auth_invalid',
      runtimeReason: 'token_expired'
    }
  ], {
    now
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.payload.error, 'auth_invalid_reauth_required');
  assert.equal(response.payload.availability.available, 0);
});

test('mark success/failure updates account runtime fields', () => {
  const acc = { consecutiveFailures: 1, successCount: 0, failCount: 0, lastError: 'x', cooldownUntil: 0 };
  markProxyAccountSuccess(acc);
  assert.equal(acc.consecutiveFailures, 0);
  assert.equal(acc.successCount, 1);
  assert.equal(acc.lastError, '');

  markProxyAccountFailure(acc, 'boom', 5000, 2);
  assert.equal(acc.failCount, 1);
  assert.equal(acc.consecutiveFailures, 1);
  assert.equal(acc.lastError, 'boom');
  assert.equal(acc.cooldownUntil, 0);

  markProxyAccountFailure(acc, 'boom2', 5000, 2);
  assert.equal(acc.consecutiveFailures, 2);
  assert.ok(acc.cooldownUntil > Date.now());
});
