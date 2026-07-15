'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildModelAccountIndex,
  findAccountsForModel,
  findModelsForAccount,
  findRoutableAccountsForModel,
  hasModelInIndex,
  patchModelAccountIndex,
  refreshOnCacheUpdate
} = require('../lib/server/model-account-index');

const GLM_REF = 'acct_1368da428a9f8842b7d4';
const DEEPSEEK_REF = 'acct_d349db0c08a3297c03e5';

function createState() {
  return {
    accounts: {
      claude: [
        {
          accountRef: GLM_REF,
          accessToken: 'token-5',
          schedulableStatus: 'schedulable'
        },
        {
          accountRef: DEEPSEEK_REF,
          accessToken: 'token-8',
          schedulableStatus: 'schedulable'
        }
      ]
    },
    webUiModelsCache: {
      updatedAt: 1234567,
      byAccount: {
        [GLM_REF]: ['glm-5.2', 'glm-4.5'],
        [DEEPSEEK_REF]: ['deepseek-v4-pro', 'deepseek-v4-flash']
      }
    }
  };
}

test('model account index builds both lookup directions without exposing mutable internals', () => {
  const index = buildModelAccountIndex(createState(), {});

  assert.equal(index.builtAt > 0, true);
  assert.equal(hasModelInIndex(index, 'glm-4.5'), true);
  assert.deepEqual(findAccountsForModel(index, 'deepseek-v4-pro'), [DEEPSEEK_REF]);
  assert.deepEqual(findAccountsForModel(index, 'unknown-model'), []);
  assert.deepEqual(Array.from(findModelsForAccount(index, DEEPSEEK_REF)).sort(), [
    'deepseek-v4-flash',
    'deepseek-v4-pro'
  ]);

  findAccountsForModel(index, 'deepseek-v4-pro').length = 0;
  findModelsForAccount(index, DEEPSEEK_REF).clear();
  assert.deepEqual(findAccountsForModel(index, 'deepseek-v4-pro'), [DEEPSEEK_REF]);
  assert.equal(findModelsForAccount(index, DEEPSEEK_REF).size, 2);
});

test('routable model lookup filters missing tokens, cooldowns and disabled accounts', () => {
  const state = createState();
  state.accounts.claude.push({
    accountRef: 'acct_99999999999999999999',
    accessToken: '',
    schedulableStatus: 'schedulable'
  });
  state.webUiModelsCache.byAccount.acct_99999999999999999999 = ['deepseek-v4-pro'];
  const index = buildModelAccountIndex(state, {});

  assert.deepEqual(findRoutableAccountsForModel(index, 'deepseek-v4-pro'), [DEEPSEEK_REF]);
  index.accountByRef.get(DEEPSEEK_REF).schedulableStatus = 'disabled';
  assert.deepEqual(findRoutableAccountsForModel(index, 'deepseek-v4-pro'), []);
});

test('incremental patch replaces models and refreshes account routing metadata', () => {
  const state = createState();
  const index = buildModelAccountIndex(state, {});
  state.webUiModelsCache.byAccount[DEEPSEEK_REF] = ['deepseek-v4-pro', 'deepseek-v4-new'];
  state.accounts.claude[1].accessToken = 'token-8-refreshed';
  state.accounts.claude[1].availableModels = ['deepseek-runtime-only'];

  patchModelAccountIndex(index, state, [DEEPSEEK_REF]);

  assert.deepEqual(findAccountsForModel(index, 'deepseek-v4-flash'), []);
  assert.deepEqual(findAccountsForModel(index, 'deepseek-v4-new'), [DEEPSEEK_REF]);
  assert.deepEqual(findAccountsForModel(index, 'deepseek-runtime-only'), [DEEPSEEK_REF]);
  assert.equal(index.accountByRef.get(DEEPSEEK_REF).accessToken, 'token-8-refreshed');
});

test('incremental patch removes stale mappings when an account leaves the runtime pool', () => {
  const state = createState();
  const index = buildModelAccountIndex(state, {});
  state.accounts.claude = state.accounts.claude.filter((account) => account.accountRef !== DEEPSEEK_REF);

  patchModelAccountIndex(index, state, [DEEPSEEK_REF]);

  assert.deepEqual(findAccountsForModel(index, 'deepseek-v4-pro'), []);
  assert.equal(index.accountByRef.has(DEEPSEEK_REF), false);
});

test('cache refresh patches only discovered account refs', () => {
  const state = createState();
  state.modelAccountIndex = buildModelAccountIndex(state, {});
  state.webUiModelsCache.byAccount[GLM_REF] = ['glm-5.2', 'glm-5.2-new'];

  refreshOnCacheUpdate(state, {}, {
    byAccount: { [GLM_REF]: ['glm-5.2', 'glm-5.2-new'] }
  });

  assert.deepEqual(findAccountsForModel(state.modelAccountIndex, 'glm-5.2-new'), [GLM_REF]);
  assert.deepEqual(findAccountsForModel(state.modelAccountIndex, 'deepseek-v4-pro'), [DEEPSEEK_REF]);
});
