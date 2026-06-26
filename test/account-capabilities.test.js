const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAccountCapabilityRegistry,
  collectProviderModelIds,
  modelMatchesProvider
} = require('../lib/server/account-capabilities');

const AGY_ACCOUNT_REF = 'acct_0123456789abcdefabcd';

test('account capabilities do not synthesize AGY models from static registry data', () => {
  const models = collectProviderModelIds({ accounts: { agy: [] } }, { provider: 'agy' }, 'agy');

  assert.deepEqual(models, []);
});

test('account capabilities expose account model availability and provider catalog cache sources', () => {
  const registry = buildAccountCapabilityRegistry({
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [{
        id: 'a1',
        accountRef: AGY_ACCOUNT_REF,
        provider: 'agy',
        accessToken: 'token',
        availableModels: ['dynamic-public-model']
      }]
    },
    webUiModelsCache: {
      byProvider: {
        agy: ['cached-public-model']
      }
    }
  });

  assert.equal(registry.providers.agy.modelSet.has('dynamic-public-model'), true);
  assert.deepEqual(registry.providers.agy.availableAccountRefsByModel['dynamic-public-model'], [AGY_ACCOUNT_REF]);
  assert.equal(registry.providers.agy.modelSet.has('cached-public-model'), true);
  assert.equal(registry.providers.agy.modelSet.has('static-public-model'), false);
});

test('account capabilities never expose internal enum ids as public models', () => {
  const registry = buildAccountCapabilityRegistry({
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: []
    },
    webUiModelsCache: {
      byProvider: {
        agy: ['MODEL_INTERNAL_ALPHA', 'catalog-public-model']
      }
    }
  });

  assert.deepEqual(registry.providers.agy.modelIds, ['catalog-public-model']);
  assert.equal(modelMatchesProvider(registry.providers.agy, 'MODEL_INTERNAL_ALPHA'), false);
});

test('account capabilities match version separator variants without adding synthetic model ids', () => {
  const registry = buildAccountCapabilityRegistry({
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [{
        id: 'a1',
        accountRef: AGY_ACCOUNT_REF,
        provider: 'agy',
        accessToken: 'token',
        availableModels: ['claude-opus-4-6-thinking']
      }]
    },
    webUiModelsCache: {
      byProvider: {
        agy: ['claude-opus-4-6-thinking']
      }
    }
  });

  assert.deepEqual(registry.providers.agy.modelIds, ['claude-opus-4-6-thinking']);
  assert.equal(modelMatchesProvider(registry.providers.agy, 'claude-opus-4.6-thinking'), true);
});
