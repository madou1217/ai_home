const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ProviderUsagePolicyRegistry,
  evaluateProviderModelUsage,
  isUsageDecisionSchedulable,
  listProviderUsageModels
} = require('../lib/server/provider-usage-policy');
const {
  buildModelCapabilityIndex,
  listAccountRefsForModelProvider,
  listAvailableAccountRefsForModelProvider,
  modelHasCatalogProvider,
  modelHasRoutableProvider
} = require('../lib/server/model-capability-index');
const {
  buildModelAccountIndex,
  findAccountsForModel,
  findRoutableAccountsForModel
} = require('../lib/server/model-account-index');

const AGY_REF = 'acct_0123456789abcdefabcd';

function agySnapshot(models) {
  return {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: Date.now(),
    models
  };
}

function createAgyAccount(models) {
  return {
    accountRef: AGY_REF,
    provider: 'agy',
    accessToken: 'agy-token',
    schedulableStatus: 'schedulable',
    availableModels: ['claude-opus-4-6-thinking', 'gemini-3-flash-agent'],
    usageSnapshot: agySnapshot(models)
  };
}

test('AGY owns exact model quota decisions without blocking another model on the same account', () => {
  const account = createAgyAccount([
    { model: 'claude-opus-4-6-thinking', remainingPct: 0, resetAtMs: 1_700_000_000_000 },
    { model: 'gemini-3-flash-agent', remainingPct: 60, resetAtMs: 1_700_000_100_000 }
  ]);

  const claudeDecision = evaluateProviderModelUsage('agy', account, 'claude-opus-4-6-thinking');
  const geminiDecision = evaluateProviderModelUsage('agy', account, 'gemini-3-flash-agent');

  assert.equal(claudeDecision.status, 'exhausted');
  assert.equal(claudeDecision.scope, 'model');
  assert.equal(claudeDecision.scopeKey, 'claude-opus-4-6-thinking'); // gitleaks:allow model identifier, not a credential
  assert.equal(claudeDecision.remainingPct, 0);
  assert.equal(claudeDecision.resetAtMs, 1_700_000_000_000);
  assert.equal(isUsageDecisionSchedulable(claudeDecision), false);

  assert.equal(geminiDecision.status, 'available');
  assert.equal(geminiDecision.scope, 'model');
  assert.equal(geminiDecision.scopeKey, 'gemini-3-flash-agent');
  assert.equal(geminiDecision.remainingPct, 60);
  assert.equal(isUsageDecisionSchedulable(geminiDecision), true);
});

test('a missing provider quota bucket is unknown and does not erase the model catalog', () => {
  const account = createAgyAccount([
    { model: 'gemini-3-flash-agent', remainingPct: 60 }
  ]);

  const decision = evaluateProviderModelUsage('agy', account, 'claude-opus-4-6-thinking');

  assert.equal(decision.status, 'unknown');
  assert.equal(decision.scope, 'model');
  assert.equal(decision.scopeKey, 'claude-opus-4-6-thinking'); // gitleaks:allow model identifier, not a credential
  assert.equal(decision.remainingPct, null);
  assert.equal(isUsageDecisionSchedulable(decision), true);
  assert.deepEqual(
    listProviderUsageModels('agy', account).sort(),
    ['gemini-3-flash-agent']
  );
});

test('the registry lets a new provider register its own usage strategy', () => {
  const registry = new ProviderUsagePolicyRegistry();
  registry.register('example', {
    listCatalogModels: () => ['example-model'],
    evaluate: (_account, modelId) => ({
      status: modelId === 'example-model' ? 'exhausted' : 'unknown',
      scope: 'model',
      scopeKey: modelId,
      remainingPct: modelId === 'example-model' ? 0 : null,
      resetAtMs: null,
      reason: 'example_policy'
    })
  });

  const decision = registry.evaluate('example', {}, 'example-model');

  assert.equal(decision.status, 'exhausted');
  assert.deepEqual(registry.listCatalogModels('example', {}), ['example-model']);
});

test('built-in provider policies keep Gemini model quota and Claude family quota separate from AGY details', () => {
  const geminiAccount = {
    accountRef: 'acct_gemini',
    provider: 'gemini',
    accessToken: 'gemini-token',
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'gemini_oauth_stats',
      capturedAt: Date.now(),
      models: [
        { model: 'gemini-2.5-pro', remainingPct: 0 },
        { model: 'gemini-2.5-flash', remainingPct: 75 }
      ]
    }
  };
  const claudeAccount = {
    accountRef: 'acct_claude',
    provider: 'claude',
    accessToken: 'claude-token',
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'claude_oauth_usage',
      capturedAt: Date.now(),
      entries: [{ window: '5h', remainingPct: 0, resetAtMs: 1_700_000_200_000 }]
    }
  };
  const codexAccount = {
    accountRef: 'acct_codex',
    provider: 'codex',
    accessToken: 'codex-token',
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      capturedAt: Date.now(),
      entries: [{ window: '5h', remainingPct: 0 }]
    }
  };

  assert.equal(
    evaluateProviderModelUsage('gemini', geminiAccount, 'gemini-2.5-pro').status,
    'exhausted'
  );
  assert.equal(
    evaluateProviderModelUsage('gemini', geminiAccount, 'gemini-2.5-flash').status,
    'available'
  );
  const claudeDecision = evaluateProviderModelUsage('claude', claudeAccount, 'claude-opus-4-6');
  assert.equal(claudeDecision.scope, 'model_family');
  assert.equal(claudeDecision.scopeKey, 'claude');
  assert.equal(claudeDecision.status, 'exhausted');
  assert.equal(evaluateProviderModelUsage('codex', codexAccount, 'gpt-5.6').status, 'exhausted');
});

test('model indexes preserve exhausted AGY models as catalog facts but exclude them at query time', () => {
  const account = createAgyAccount([
    { model: 'claude-opus-4-6-thinking', remainingPct: 0 },
    { model: 'gemini-3-flash-agent', remainingPct: 60 }
  ]);
  const state = {
    accounts: { codex: [], gemini: [], claude: [], agy: [account] },
    webUiModelsCache: {
      byAccount: {
        [AGY_REF]: ['claude-opus-4-6-thinking', 'gemini-3-flash-agent']
      },
      byProvider: {
        agy: ['claude-opus-4-6-thinking', 'gemini-3-flash-agent']
      }
    }
  };

  const capabilityIndex = buildModelCapabilityIndex(state, { provider: 'auto' });
  assert.deepEqual(
    listAccountRefsForModelProvider(capabilityIndex, 'claude-opus-4-6-thinking', 'agy'),
    [AGY_REF]
  );
  assert.equal(modelHasCatalogProvider(capabilityIndex, 'claude-opus-4-6-thinking', 'agy'), true);
  assert.deepEqual(
    listAvailableAccountRefsForModelProvider(capabilityIndex, 'claude-opus-4-6-thinking', 'agy'),
    []
  );
  assert.equal(modelHasRoutableProvider(capabilityIndex, 'claude-opus-4-6-thinking', 'agy'), false);
  assert.deepEqual(
    listAvailableAccountRefsForModelProvider(capabilityIndex, 'gemini-3-flash-agent', 'agy'),
    [AGY_REF]
  );

  const accountIndex = buildModelAccountIndex(state, {});
  assert.deepEqual(findAccountsForModel(accountIndex, 'claude-opus-4-6-thinking'), [AGY_REF]);
  assert.deepEqual(findRoutableAccountsForModel(accountIndex, 'claude-opus-4-6-thinking', 'agy'), []);
  assert.deepEqual(findRoutableAccountsForModel(accountIndex, 'gemini-3-flash-agent', 'agy'), [AGY_REF]);
});
