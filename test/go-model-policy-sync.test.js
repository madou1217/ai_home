'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planModelPolicySync } = require('../lib/account/go-bridge/go-model-policy-sync');

test('global model settings map to linked Go accounts by provider scope', () => {
  const plan = planModelPolicySync({
    settings: {
      legacyModels: [{ id: 'gpt-6.1-sol', provider: 'codex', enabled: false }],
      accountModels: []
    },
    nodeAccounts: [
      { accountRef: 'node-codex', provider: 'codex' },
      { accountRef: 'node-claude', provider: 'claude' }
    ],
    goRefByNodeRef: new Map([
      ['node-codex', 'go-codex'],
      ['node-claude', 'go-claude']
    ]),
    goModelPolicies: [],
    pushedKeys: []
  });

  assert.deepEqual(plan.writes, [{
    accountRef: 'go-codex',
    modelId: 'gpt-6.1-sol',
    manualPolicy: 'force_disable'
  }]);
});

test('providerless global disable covers every linked provider and account disable wins', () => {
  const plan = planModelPolicySync({
    settings: {
      legacyModels: [{ id: 'shared-model', enabled: false }],
      accountModels: [{ accountRef: 'node-codex', id: 'shared-model', enabled: true, manual: true }]
    },
    nodeAccounts: [
      { accountRef: 'node-codex', provider: 'codex' },
      { accountRef: 'node-claude', provider: 'claude' }
    ],
    goRefByNodeRef: new Map([
      ['node-codex', 'go-codex'],
      ['node-claude', 'go-claude']
    ]),
    goModelPolicies: [],
    pushedKeys: []
  });

  assert.deepEqual(plan.writes, [
    { accountRef: 'go-codex', modelId: 'shared-model', manualPolicy: 'force_disable' },
    { accountRef: 'go-claude', modelId: 'shared-model', manualPolicy: 'force_disable' }
  ]);
});

test('clearing a previously pushed global policy restores inherit', () => {
  const plan = planModelPolicySync({
    settings: { legacyModels: [], accountModels: [] },
    nodeAccounts: [{ accountRef: 'node-codex', provider: 'codex' }],
    goRefByNodeRef: new Map([['node-codex', 'go-codex']]),
    goModelPolicies: [{ accountRef: 'go-codex', modelId: 'old-model', manualPolicy: 'force_disable' }],
    pushedKeys: ['go-codex\u0000old-model']
  });

  assert.deepEqual(plan.writes, [{
    accountRef: 'go-codex', modelId: 'old-model', manualPolicy: 'inherit'
  }]);
});
