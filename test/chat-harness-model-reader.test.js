'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createChatHarnessModelReader } = require('../lib/server/chat-runtime/chat-harness-model-reader');
const { getWebUiModelsCache } = require('../lib/server/webui-model-cache');

const FIRST = 'acct_11111111111111111111';
const SECOND = 'acct_22222222222222222222';
const firstModel = 'gemini-2.5-flash';
const secondModel = 'gemini-2.5-pro';

function createState() {
  return {
    accounts: { agy: [FIRST, SECOND].map((accountRef) => ({
      accountRef, provider: 'agy', accessToken: 'test-token'
    })) },
    modelRegistry: { providers: { agy: new Set(['provider-only-model']) } }
  };
}

test('Chat loads persisted account models on first read without an upstream probe', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-model-reader-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  await getWebUiModelsCache(createState(), {}, {
    fs, aiHomeDir, forceRefresh: true, accountLimit: 0,
    fetchModelsForAccount: async (_options, account) => [account.accountRef === FIRST ? firstModel : secondModel]
  });
  let probes = 0;
  const state = createState();
  const readModels = createChatHarnessModelReader({
    getState: () => state, options: {}, fs, aiHomeDir,
    fetchModelsForAccount: async () => { probes += 1; return []; }
  });

  assert.deepEqual(await readModels('agy', SECOND), [secondModel]);
  assert.deepEqual(await readModels('agy', FIRST), [firstModel]);
  assert.equal(probes, 0);
});

test('cold Chat catalogs probe only the chosen account and reuse the result', async () => {
  const probed = [];
  const state = createState();
  const readModels = createChatHarnessModelReader({
    getState: () => state, options: { modelsProbeAccounts: 1 },
    fetchModelsForAccount: async (_options, account, timeoutMs) => {
      probed.push(account.accountRef);
      assert.equal(timeoutMs, 8000);
      return [account.accountRef === FIRST ? firstModel : secondModel];
    }
  });

  assert.deepEqual(await readModels('agy', SECOND), [secondModel]);
  assert.deepEqual(await readModels('agy', SECOND), [secondModel]);
  assert.deepEqual(probed, [SECOND]);
  assert.deepEqual(await readModels('agy', FIRST), [firstModel]);
  assert.deepEqual(probed, [SECOND, FIRST]);
});

test('failed Chat probes stay scoped, observe existing backoff and recover on a later read', async () => {
  const state = createState();
  let probes = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state, options: {},
    fetchModelsForAccount: async (_options, account) => {
      probes += 1;
      if (account.accountRef === SECOND && probes === 2) throw new Error('account-two-unavailable');
      return [account.accountRef === FIRST ? firstModel : secondModel];
    }
  });

  assert.deepEqual(await readModels('agy', FIRST), [firstModel]);
  assert.deepEqual(await readModels('agy', SECOND), []);
  assert.deepEqual(await readModels('agy', SECOND), []);
  assert.equal(probes, 2);
  assert.deepEqual(await readModels('agy', FIRST), [firstModel]);
  state.webUiModelsCache.accountUpdatedAt[SECOND] = Date.now() - 61_000;
  assert.deepEqual(await readModels('agy', SECOND), [secondModel]);
  assert.equal(probes, 3);
});

test('invalid account or provider scope cannot trigger a global Chat catalog probe', async () => {
  let probes = 0;
  const state = createState();
  const readModels = createChatHarnessModelReader({
    getState: () => state, options: {},
    fetchModelsForAccount: async () => { probes += 1; return [firstModel]; }
  });
  for (const [provider, accountRef] of [['agy', ''], ['claude', FIRST], ['auto', FIRST]]) {
    await assert.rejects(readModels(provider, accountRef), /chat_session_account_mismatch/);
  }
  assert.equal(probes, 0);
});
