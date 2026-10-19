'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __private
} = require('../lib/server/webui-openai-model-routes');
const {
  normalizeModelCatalogSettings
} = require('../lib/server/model-catalog-settings-store');

const ACCOUNT_REF = 'acct_0123456789abcdefabcd';

test('managed model items expose account custom pricing to the WebUI payload', () => {
  const settings = normalizeModelCatalogSettings({
    version: 5,
    accountModels: [{
      id: 'gpt-x',
      provider: 'codex',
      accountRef: ACCOUNT_REF,
      customPricing: { input: 1.25, output: 2.5, cacheRead: 0.1, cacheWrite: 0.2 }
    }]
  });

  const items = __private.buildManagedModelItems(
    {},
    [{ id: 'gpt-x', provider: 'codex', accountRef: ACCOUNT_REF }],
    settings
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].customPricing, {
    input: 1.25,
    output: 2.5,
    cacheRead: 0.1,
    cacheWrite: 0.2
  });
});

test('managed model items omit custom pricing when the account has none', () => {
  const settings = normalizeModelCatalogSettings({ version: 5, accountModels: [] });
  const items = __private.buildManagedModelItems(
    {},
    [{ id: 'gpt-x', provider: 'codex', accountRef: ACCOUNT_REF }],
    settings
  );
  assert.equal(items[0].customPricing, undefined);
});
