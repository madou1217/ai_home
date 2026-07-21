const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDER_DEFAULT_MODELS,
  collectProviderDefaultCandidates,
  resolveProviderDefaultModel
} = require('../lib/server/provider-default-models');

test('provider default models come from dynamic catalog caches', () => {
  const state = {
    accounts: {
      agy: [{
        id: 'a1',
        availableModels: ['account-model']
      }]
    },
    webUiModelsCache: {
      byProvider: {
        agy: ['cached-model']
      }
    },
    modelRegistry: {
      providers: {
        agy: new Set(['registry-model'])
      }
    }
  };

  assert.deepEqual(collectProviderDefaultCandidates('agy', {
    state,
    accountId: 'a1'
  }), ['cached-model', 'registry-model']);
  assert.equal(resolveProviderDefaultModel('agy', '', {
    state,
    accountId: 'a1'
  }), 'cached-model');
  assert.deepEqual(PROVIDER_DEFAULT_MODELS, {});
  assert.equal(Object.isFrozen(PROVIDER_DEFAULT_MODELS), true);
});

test('provider default models ignore internal enum ids', () => {
  const state = {
    webUiModelsCache: {
      byProvider: {
        agy: ['MODEL_INTERNAL_ALPHA', 'cached-model']
      }
    },
    modelRegistry: {
      providers: {
        agy: new Set(['MODEL_INTERNAL_BETA', 'registry-model'])
      }
    }
  };

  assert.deepEqual(collectProviderDefaultCandidates('agy', { state }), ['cached-model', 'registry-model']);
});

test('provider default models use the explicit fallback when discovery is empty', () => {
  assert.equal(resolveProviderDefaultModel('unknown'), '');
  assert.equal(resolveProviderDefaultModel('unknown', 'custom-default'), 'custom-default');
});
