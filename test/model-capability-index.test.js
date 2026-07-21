const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildModelCapabilityIndex,
  listAvailableAccountRefsForModelProvider,
  listProviderModelIds,
  modelHasAvailableProvider,
  modelHasRoutableProvider,
  summarizeModelProviderCooldown,
  resolveRealModelId
} = require('../lib/server/model-capability-index');
const { markProxyAccountFailure } = require('../lib/server/router');
const { applyAccountFailurePolicy } = require('../lib/server/account-runtime-state');

const TRANSIENT_NETWORK_POLICY = Object.freeze({
  kind: 'network_error',
  shouldMarkFailure: true,
  failureThreshold: 2,
  cooldownMs: 30000,
  scope: 'account',
  failureReason: 'fetch failed [UND_ERR_SOCKET]'
});

const AGY_ACCOUNT_REF = 'acct_0123456789abcdefabcd';
const AGY_SECOND_ACCOUNT_REF = 'acct_abcdefabcdefabcdefab';
const CODEX_ACCOUNT_REF = 'acct_11111111111111111111';

test('model capability index builds provider and account reverse lookup from real account models', () => {
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [
        {
          id: 'a1',
          accountRef: AGY_ACCOUNT_REF,
          provider: 'agy',
          accessToken: 'token-1',
          availableModels: [
            'gemini-3.1-pro-preview',
            'chat_20706',
            'models/proactive-observer'
          ]
        },
        {
          id: 'a2',
          accountRef: AGY_SECOND_ACCOUNT_REF,
          provider: 'agy',
          accessToken: 'token-2',
          availableModels: ['gemini-3.1-pro-preview'],
          cooldownUntil: Date.now() + 60_000
        }
      ]
    },
    webUiModelsCache: {
      byProvider: {
        agy: ['MODEL_INTERNAL_ALPHA', 'gpt-oss-120b-medium']
      }
    }
  };

  const index = buildModelCapabilityIndex(state, { provider: 'auto' });

  assert.deepEqual(listProviderModelIds(index, 'agy'), [
    'gemini-3.1-pro-preview',
    'gpt-oss-120b-medium'
  ]);
  assert.deepEqual(
    listAvailableAccountRefsForModelProvider(index, 'gemini-3.1-pro-preview', 'agy'),
    [AGY_ACCOUNT_REF]
  );
  assert.equal(modelHasAvailableProvider(index, 'gemini-3-1-pro-preview', 'agy'), true);
  assert.equal(resolveRealModelId(index, 'gemini-3-1-pro-preview'), 'gemini-3.1-pro-preview');
  assert.equal(modelHasAvailableProvider(index, 'gpt-oss-120b-medium', 'agy'), false);
});

test('model capability index reads stable account model cache keys without provider catalog fallback', () => {
  const account = {
    id: 'o1',
    accountRef: AGY_ACCOUNT_REF,
    provider: 'opencode',
    accessToken: 'token-1'
  };
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [],
      opencode: [account]
    },
    webUiModelsCache: {
      byAccount: {
        [account.accountRef]: ['opencode-go/glm-5.2']
      },
      byProvider: {
        opencode: ['opencode-go/glm-5.2', 'opencode-go/kimi-k2.7-code']
      }
    },
    modelCatalogSettings: {
      version: 3,
      accountModels: [{
        id: 'opencode-go/manual-model',
        provider: 'opencode',
        accountRef: account.accountRef,
        enabled: true,
        manual: true
      }]
    }
  };

  const index = buildModelCapabilityIndex(state, { provider: 'auto' });

  assert.deepEqual(
    listAvailableAccountRefsForModelProvider(index, 'opencode-go/glm-5-2', 'opencode'),
    [account.accountRef]
  );
  assert.deepEqual(
    listAvailableAccountRefsForModelProvider(index, 'opencode-go/manual-model', 'opencode'),
    [account.accountRef]
  );
  assert.deepEqual(
    listAvailableAccountRefsForModelProvider(index, 'opencode-go/kimi-k2.7-code', 'opencode'),
    []
  );
  assert.equal(modelHasRoutableProvider(index, 'opencode-go/glm-5.2', 'opencode'), true);
  assert.equal(modelHasAvailableProvider(index, 'opencode-go/kimi-k2.7-code', 'opencode'), false);
});

test('model capability index applies model catalog settings per account', () => {
  const state = {
    accounts: {
      codex: [
        { id: '1', accountRef: AGY_ACCOUNT_REF, provider: 'codex', accessToken: 'token-1' },
        { id: '2', accountRef: AGY_SECOND_ACCOUNT_REF, provider: 'codex', accessToken: 'token-2' },
        { id: '3', accountRef: CODEX_ACCOUNT_REF, provider: 'codex', accessToken: 'token-3' }
      ],
      gemini: [],
      claude: [],
      agy: []
    },
    webUiModelsCache: {
      byAccount: {
        [AGY_ACCOUNT_REF]: ['a', 'c', 'b', 'd'],
        [AGY_SECOND_ACCOUNT_REF]: ['a', 'c', 'e', 'f'],
        [CODEX_ACCOUNT_REF]: []
      }
    },
    modelCatalogSettings: {
      version: 2,
      accountModels: [
        { id: 'c', provider: 'codex', accountRef: AGY_ACCOUNT_REF, enabled: false },
        { id: 'd', provider: 'codex', accountRef: AGY_ACCOUNT_REF, enabled: false },
        { id: 'c', provider: 'codex', accountRef: AGY_SECOND_ACCOUNT_REF, enabled: false },
        { id: 'f', provider: 'codex', accountRef: AGY_SECOND_ACCOUNT_REF, enabled: false },
        { id: 'g', provider: 'codex', accountRef: CODEX_ACCOUNT_REF, enabled: true, manual: true }
      ]
    }
  };

  const index = buildModelCapabilityIndex(state, { provider: 'auto' });

  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'a', 'codex'), [AGY_ACCOUNT_REF, AGY_SECOND_ACCOUNT_REF]);
  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'b', 'codex'), [AGY_ACCOUNT_REF]);
  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'e', 'codex'), [AGY_SECOND_ACCOUNT_REF]);
  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'g', 'codex'), [CODEX_ACCOUNT_REF]);
  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'c', 'codex'), []);
  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'd', 'codex'), []);
  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'f', 'codex'), []);
  assert.equal(modelHasAvailableProvider(index, 'c', 'codex'), false);
  assert.equal(modelHasAvailableProvider(index, 'g', 'codex'), true);
});

test('modelHasRoutableProvider excludes per-model-cooled accounts (drives alias fallback)', () => {
  // One agy account that serves BOTH the claude alias target and a gemini model.
  const account = { id: 'a1', accountRef: AGY_ACCOUNT_REF, provider: 'agy', accessToken: 'token-1', apiKeyMode: false, schedulableStatus: 'schedulable', availableModels: ['claude-opus-4-6-thinking', 'gemini-3.5-flash-low'] };
  const state = { accounts: { codex: [], gemini: [], claude: [], agy: [account] } };
  const index = buildModelCapabilityIndex(state, { provider: 'auto' });

  // Initially both models routable.
  assert.equal(modelHasRoutableProvider(index, 'claude-opus-4-6-thinking', 'agy'), true);
  assert.equal(modelHasRoutableProvider(index, 'gemini-3.5-flash-low', 'agy'), true);

  // A 429 on the claude model cools ONLY that (account, model) tuple.
  markProxyAccountFailure(account, '429', 5 * 60_000, 1, { scope: 'model', model: 'claude-opus-4-6-thinking' });

  // claude target now has no routable account -> alias preflight falls through.
  assert.equal(modelHasRoutableProvider(index, 'claude-opus-4-6-thinking', 'agy'), false);
  // ...but the gemini fallback target on the SAME account is still routable.
  assert.equal(modelHasRoutableProvider(index, 'gemini-3.5-flash-low', 'agy'), true);
  // Catalog availability (used for save/visibility) ignores cooldown.
  assert.equal(modelHasAvailableProvider(index, 'claude-opus-4-6-thinking', 'agy'), true);
});

test('summarizeModelProviderCooldown surfaces the real per-account reason behind a cooled target', () => {
  const account = { id: 'a1', accountRef: AGY_ACCOUNT_REF, provider: 'agy', accessToken: 'token-1', apiKeyMode: false, schedulableStatus: 'schedulable', availableModels: ['claude-opus-4-6-thinking'] };
  const state = { accounts: { codex: [], gemini: [], claude: [], agy: [account] } };
  const index = buildModelCapabilityIndex(state, { provider: 'auto' });

  // Healthy -> nothing to explain.
  assert.equal(summarizeModelProviderCooldown(index, 'claude-opus-4-6-thinking', 'agy'), '');

  // Two consecutive network blips put the account into transient_network.
  applyAccountFailurePolicy(account, TRANSIENT_NETWORK_POLICY, { markProxyAccountFailure });
  applyAccountFailurePolicy(account, TRANSIENT_NETWORK_POLICY, { markProxyAccountFailure });

  const summary = summarizeModelProviderCooldown(index, 'claude-opus-4-6-thinking', 'agy');
  assert.match(summary, /transient_network/);
  assert.match(summary, /fetch failed/);
  assert.match(summary, /1 unavailable/);
});

test('model capability index keeps AGY catalog models whose quota bucket is not published yet', () => {
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [{
        id: 'a1',
        accountRef: AGY_ACCOUNT_REF,
        provider: 'agy',
        accessToken: 'token-1',
        apiKeyMode: false,
        schedulableStatus: 'schedulable',
        availableModels: ['claude-sonnet-4-6', 'gemini-3-flash-agent'],
        usageSnapshot: {
          schemaVersion: 2,
          kind: 'agy_code_assist_quota',
          source: 'agy_fetch_available_models',
          capturedAt: Date.now(),
          models: [{
            model: 'gemini-3-flash-agent',
            remainingPct: 88
          }]
        }
      }]
    },
    webUiModelsCache: {
      byAccount: {
        [AGY_ACCOUNT_REF]: ['claude-sonnet-4-6', 'gemini-3-flash-agent']
      },
      byProvider: {
        agy: ['claude-sonnet-4-6', 'gemini-3-flash-agent']
      }
    }
  };

  const index = buildModelCapabilityIndex(state, { provider: 'auto' });

  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'gemini-3-flash-agent', 'agy'), [AGY_ACCOUNT_REF]);
  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'claude-sonnet-4-6', 'agy'), [AGY_ACCOUNT_REF]);
  assert.equal(modelHasRoutableProvider(index, 'gemini-3-flash-agent', 'agy'), true);
  assert.equal(modelHasRoutableProvider(index, 'claude-sonnet-4-6', 'agy'), true);
});

test('model capability index blocks exhausted AGY quota model only', () => {
  const account = {
    id: 'a1',
    accountRef: AGY_ACCOUNT_REF,
    provider: 'agy',
    accessToken: 'token-1',
    apiKeyMode: false,
    schedulableStatus: 'schedulable',
    availableModels: ['claude-sonnet-4-6', 'gemini-3-flash-agent'],
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'agy_code_assist_quota',
      source: 'agy_fetch_available_models',
      capturedAt: Date.now(),
      models: [
        { model: 'claude-sonnet-4-6', remainingPct: 0 },
        { model: 'gemini-3-flash-agent', remainingPct: 42 }
      ]
    }
  };
  const state = { accounts: { codex: [], gemini: [], claude: [], agy: [account] } };
  const index = buildModelCapabilityIndex(state, { provider: 'auto' });

  assert.equal(modelHasAvailableProvider(index, 'claude-sonnet-4-6', 'agy'), false);
  assert.equal(modelHasAvailableProvider(index, 'gemini-3-flash-agent', 'agy'), true);
});

test('model capability index ignores account models without accountRef', () => {
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [{
        id: 'a1',
        provider: 'agy',
        accessToken: 'token-1',
        availableModels: ['gemini-3-flash-agent']
      }]
    },
    webUiModelsCache: {
      byAccount: {
        legacy_untrusted_cache_key: ['gemini-3-flash-agent']
      }
    }
  };
  const index = buildModelCapabilityIndex(state, { provider: 'auto' });

  assert.deepEqual(listAvailableAccountRefsForModelProvider(index, 'gemini-3-flash-agent', 'agy'), []);
  assert.equal(modelHasAvailableProvider(index, 'gemini-3-flash-agent', 'agy'), false);
});
