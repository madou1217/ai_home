'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatHarnessModelReader } = require('../lib/server/chat-runtime/chat-harness-model-reader');

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
