'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { credential } = require('./helpers/codebuddy-credential');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const {
  accountScopeNeverProbed,
  buildAccountsSignature,
  getWebUiModelsCache
} = require('../lib/server/webui-model-cache');

const FIRST_REF = 'acct_11111111111111111111';
const PEER_REF = 'acct_22222222222222222222';

function createCachedState() {
  return {
    accounts: {
      workbuddycn: [FIRST_REF, PEER_REF].map((accountRef) => ({
        accountRef, provider: 'workbuddycn', configured: true
      }))
    },
    webUiModelsCache: {
      updatedAt: Date.now(),
      byProvider: { workbuddycn: ['retired-model', 'peer-model'], claude: ['claude-kept'] },
      byAccount: { [FIRST_REF]: ['retired-model'], [PEER_REF]: ['peer-model'] },
      source: 'remote'
    }
  };
}

test('scoped refresh replaces retired models while preserving current peer and unrelated provider catalogs', async () => {
  const state = createCachedState();
  const result = await getWebUiModelsCache(state, {}, {
    forceRefresh: true,
    accountScope: { accountRef: FIRST_REF },
    fetchModelsForAccount: async () => ['current-model']
  });

  assert.deepEqual(result.models.workbuddycn, ['current-model', 'peer-model']);
  assert.deepEqual(result.models.claude, ['claude-kept']);
  assert.deepEqual(result.byAccount[FIRST_REF], ['current-model']);
  assert.deepEqual(result.byAccount[PEER_REF], ['peer-model']);
});

test('a failed scoped refresh keeps the last successful account directory', async () => {
  const state = createCachedState();
  const result = await getWebUiModelsCache(state, {}, {
    forceRefresh: true,
    accountScope: { accountRef: FIRST_REF },
    fetchModelsForAccount: async () => { throw new Error('upstream unavailable'); }
  });

  assert.deepEqual(result.models.workbuddycn, ['peer-model', 'retired-model']);
  assert.deepEqual(result.byAccount[FIRST_REF], ['retired-model']);
  assert.equal(result.errorsByAccount[FIRST_REF], 'upstream unavailable');
});

test('scoped provider union excludes catalogs from accounts no longer present', async () => {
  const state = createCachedState();
  state.accounts.workbuddycn.pop();
  const result = await getWebUiModelsCache(state, {}, {
    forceRefresh: true,
    accountScope: { accountRef: FIRST_REF },
    fetchModelsForAccount: async () => ['current-model']
  });
  assert.deepEqual(result.models.workbuddycn, ['current-model']);
});

test('discovery-only WorkBuddy accounts keep their cached probe metadata and participate in cold probes and signatures', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-scoped-model-cache-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const state = { accounts: { workbuddy: [] } };
  const originalSignature = buildAccountsSignature(state, 1, null, deps);
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'workbuddy', cliAccountId: '1', identitySeed: 'workbuddy:scoped-probe'
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential('workbuddy') });
  const accountScope = { accountRef };

  assert.notEqual(buildAccountsSignature(state, 1, null, deps), originalSignature);
  assert.equal(accountScopeNeverProbed(state, deps, accountScope), true);
  await getWebUiModelsCache(state, {}, {
    ...deps, accountScope, forceRefresh: true,
    fetchModelsForAccount: async () => ['fast-model']
  });
  assert.equal(accountScopeNeverProbed(state, deps, accountScope), false);
  const cached = await getWebUiModelsCache(state, {}, { ...deps, accountScope });
  assert.equal(cached.source, 'remote');
  assert.equal(cached.sourceCount, 1);
  assert.equal(cached.scannedAccounts, 1);
  assert.deepEqual(cached.byAccount[accountRef], ['fast-model']);
});
