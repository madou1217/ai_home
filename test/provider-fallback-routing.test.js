'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRequestProvider } = require('../lib/server/provider-routing');

test('resolveRequestProvider falls back to alternative provider with routable accounts when primary family has no available accounts', () => {
  const state = {
    modelAccountIndex: {
      builtAt: Date.now(),
      modelToAccounts: new Map([
        ['claude-sonnet-4-5', ['acct_agy_1']]
      ]),
      accountToModels: new Map([
        ['acct_agy_1', new Set(['claude-sonnet-4-5'])],
        ['acct_kimi_1', new Set(['claude-sonnet-4-5'])]
      ]),
      accountByRef: new Map([
        ['acct_agy_1', { provider: 'agy', accessToken: 'token', schedulableStatus: 'schedulable', runtimeStatus: 'healthy' }],
        ['acct_kimi_1', { provider: 'kimi', accessToken: '', schedulableStatus: 'auth_invalid_reauth_required', runtimeStatus: 'auth_invalid' }]
      ]),
      usagePolicyRegistry: null
    }
  };

  const provider = resolveRequestProvider({}, { model: 'claude-sonnet-4-5' }, {}, state);
  assert.equal(provider, 'agy');
});
