'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatHarnessModelReader } = require('../lib/server/chat-runtime/chat-harness-model-reader');

test('account-scoped composer uses the cached catalog instead of re-probing', async () => {
  const accountRef = 'acct_12345678901234567890';
  const state = {
    accounts: { zcode: [{ accountRef, provider: 'zcode', authMode: 'oauth' }] },
    webUiModelsCache: {
      updatedAt: Date.now(),
      signature: 'fresh',
      byAccount: { [accountRef]: ['glm-5.3', 'glm-5.3-flash'] },
      accountUpdatedAt: { [accountRef]: Date.now() }
    }
  };
  let probed = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    fetchModelsForAccount: () => { probed += 1; return []; }
  });
  const models = await readModels('zcode', accountRef);
  assert.deepEqual(models, ['glm-5.3', 'glm-5.3-flash']);
  assert.equal(probed, 0);
});

test('gateway composer returns a stale usable catalog without waiting for refresh', async () => {
  const accountRef = 'acct_12345678901234567890';
  const state = {
    accounts: { openai: [{ accountRef, apiKey: 'test' }] },
    webUiModelsCache: {
      updatedAt: 1,
      signature: 'stale',
      byAccount: { [accountRef]: ['known-model'], acct_deleted: ['removed-model'] }
    }
  };
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    fetchModelsForAccount: () => new Promise(() => {})
  });
  let timer;
  try {
    const models = await Promise.race([
      readModels('openai', 'gateway'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('catalog blocked on refresh')), 500); })
    ]);
    assert.deepEqual(models, ['known-model']);
  } finally {
    clearTimeout(timer);
  }
});
