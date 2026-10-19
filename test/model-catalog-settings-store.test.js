'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/server/model-catalog-settings-store');
const {
  getAppStateDbPath,
  readJsonValue
} = require('../lib/server/app-state-store');

function seedSettings(records) {
  return store.normalizeModelCatalogSettings({ version: 3, accountModels: records });
}

const CLAUDE_ACCOUNT_REF = 'acct_0123456789abcdefabcd';
const OTHER_ACCOUNT_REF = 'acct_abcdefabcdefabcdefab';

test('model catalog settings persist in app state database', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-catalog-settings-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const settings = seedSettings([
    {
      id: 'claude-opus-4-8',
      provider: 'claude',
      accountRef: CLAUDE_ACCOUNT_REF,
      enabled: false
    }
  ]);

  const saved = await store.saveModelCatalogSettings(fs, aiHomeDir, settings);
  const loaded = await store.loadModelCatalogSettings(fs, aiHomeDir);

  assert.equal(fs.existsSync(getAppStateDbPath(aiHomeDir)), true);
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'model-catalog-settings.json')), false);
  assert.equal(loaded.accountModels[0].accountRef, CLAUDE_ACCOUNT_REF);
  assert.equal(loaded.accountModels[0].enabled, false);
  assert.deepEqual(
    readJsonValue(fs, aiHomeDir, store.MODEL_CATALOG_SETTINGS_DB_KEY).accountModels,
    saved.accountModels
  );
});

test('disabled model follows accountRef across accountId changes', () => {
  const settings = store.upsertAccountModelSetting(seedSettings([]), {
    id: 'claude-opus-4-8',
    provider: 'claude',
    accountRef: CLAUDE_ACCOUNT_REF,
    enabled: false
  });

  assert.equal(store.isAccountModelEnabled(settings, {
    id: 'claude-opus-4-8',
    provider: 'claude',
    accountRef: CLAUDE_ACCOUNT_REF
  }), false);

  assert.equal(store.isAccountModelEnabled(settings, {
    id: 'claude-opus-4-8',
    provider: 'claude',
    accountRef: OTHER_ACCOUNT_REF
  }), true);
});

test('account scoped settings require accountRef and ignore legacy account fields', () => {
  const settings = seedSettings([
    { id: 'm1', provider: 'codex', accountId: '2', enabled: false }
  ]);

  assert.deepEqual(settings.accountModels, []);
  assert.equal(store.isAccountModelEnabled(settings, {
    id: 'm1',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF
  }), true);
});

test('upsert account model rejects missing accountRef', () => {
  assert.throws(() => store.upsertAccountModelSetting(seedSettings([]), {
    id: 'm1',
    provider: 'codex',
    enabled: false
  }), /invalid_account_model/);
});

test('account model default is unique per accountRef', () => {
  const first = store.upsertAccountModelSetting(seedSettings([]), {
    id: 'm1',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    enabled: true,
    defaultModel: true
  });
  const second = store.upsertAccountModelSetting(first, {
    id: 'm2',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    enabled: true,
    defaultModel: true
  });
  const otherAccount = store.upsertAccountModelSetting(second, {
    id: 'm3',
    provider: 'codex',
    accountRef: OTHER_ACCOUNT_REF,
    enabled: true,
    defaultModel: true
  });

  const byKey = new Map(otherAccount.accountModels.map((item) => [`${item.accountRef}:${item.id}`, item]));
  assert.equal(byKey.get(`${CLAUDE_ACCOUNT_REF}:m1`).defaultModel, false);
  assert.equal(byKey.get(`${CLAUDE_ACCOUNT_REF}:m2`).defaultModel, true);
  assert.equal(byKey.get(`${OTHER_ACCOUNT_REF}:m3`).defaultModel, true);
  assert.equal(store.findDefaultAccountModelSetting(otherAccount, CLAUDE_ACCOUNT_REF).id, 'm2');
});

test('disabling a default account model clears default marker', () => {
  const defaulted = store.upsertAccountModelSetting(seedSettings([]), {
    id: 'm1',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    enabled: true,
    defaultModel: true
  });
  const disabled = store.upsertAccountModelSetting(defaulted, {
    id: 'm1',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    enabled: false,
    defaultModel: true
  });

  assert.equal(disabled.accountModels[0].enabled, false);
  assert.equal(disabled.accountModels[0].defaultModel, false);
  assert.equal(store.findDefaultAccountModelSetting(disabled, CLAUDE_ACCOUNT_REF), null);
});

test('custom pricing normalizes to four non-negative dimensions and drops empty values', () => {
  const settings = seedSettings([{
    id: 'm1',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    customPricing: { input: 1.5, output: 0, cache_read: 0.2, bogus: 9, cacheWrite: -1 }
  }]);

  assert.deepEqual(settings.accountModels[0].customPricing, {
    input: 1.5,
    output: 0,
    cacheRead: 0.2
  });

  const empty = seedSettings([{
    id: 'm2',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    customPricing: { input: 'nope', output: -3 }
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(empty.accountModels[0], 'customPricing'), false);
});

test('custom pricing survives updates that do not submit it, and explicit null clears it', () => {
  const created = store.upsertAccountModelSetting(seedSettings([]), {
    id: 'm1',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    customPricing: { input: 2, output: 4 }
  });
  assert.deepEqual(created.accountModels[0].customPricing, { input: 2, output: 4 });

  const toggled = store.upsertAccountModelSetting(created, {
    id: 'm1',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    enabled: false
  });
  assert.deepEqual(toggled.accountModels[0].customPricing, { input: 2, output: 4 });

  const cleared = store.upsertAccountModelSetting(toggled, {
    id: 'm1',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    customPricing: null
  });
  assert.equal(Object.prototype.hasOwnProperty.call(cleared.accountModels[0], 'customPricing'), false);
});

test('custom pricing is scoped to one accountRef', () => {
  const created = store.upsertAccountModelSetting(seedSettings([]), {
    id: 'm1',
    provider: 'codex',
    accountRef: CLAUDE_ACCOUNT_REF,
    customPricing: { input: 2 }
  });
  const other = store.upsertAccountModelSetting(created, {
    id: 'm1',
    provider: 'codex',
    accountRef: OTHER_ACCOUNT_REF
  });

  const byRef = new Map(other.accountModels.map((item) => [item.accountRef, item]));
  assert.deepEqual(byRef.get(CLAUDE_ACCOUNT_REF).customPricing, { input: 2 });
  assert.equal(Object.prototype.hasOwnProperty.call(byRef.get(OTHER_ACCOUNT_REF), 'customPricing'), false);
});
