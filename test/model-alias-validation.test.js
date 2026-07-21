const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAliasRecordForSave
} = require('../lib/server/model-alias-validation');

const AGY_ACCOUNT_REF = 'acct_0123456789abcdefabcd';

test('alias validation accepts a new AGY catalog model before its quota bucket is published', () => {
  const target = 'gemini-3.6-flash-tiered';
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [{
        accountRef: AGY_ACCOUNT_REF,
        provider: 'agy',
        accessToken: 'token-1',
        schedulableStatus: 'schedulable',
        usageSnapshot: {
          schemaVersion: 2,
          kind: 'agy_code_assist_quota',
          source: 'agy_fetch_available_models',
          capturedAt: Date.now(),
          models: [{ model: 'gemini-3.5-flash-low', remainingPct: 50 }]
        }
      }]
    },
    webUiModelsCache: {
      byProvider: { agy: [target] },
      byAccount: { [AGY_ACCOUNT_REF]: [target] }
    }
  };

  const result = validateAliasRecordForSave({
    alias: 'claude-*',
    target,
    provider: 'all',
    targetProvider: 'agy',
    enabled: false
  }, {
    state,
    options: { provider: 'auto' }
  });

  assert.deepEqual(result, {
    ok: true,
    model: target,
    providers: ['agy']
  });
});
