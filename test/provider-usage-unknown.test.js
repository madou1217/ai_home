'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateProviderModelUsage, createUsageDecisionForRemaining, isUsageDecisionSchedulable
} = require('../lib/server/provider-usage-policy');
const {
  buildModelCapabilityIndex, listAccountRefsForModelProvider, listAvailableAccountRefsForModelProvider
} = require('../lib/server/model-capability-index');
const {
  buildModelAccountIndex, findAccountsForModel, findRoutableAccountsForModel
} = require('../lib/server/model-account-index');

const REF = 'acct_abcdef0123456789abcd';
const MODEL = 'fixture-model';
const POLICIES = [
  ['codex', 'codex_oauth_status', 'entries'],
  ['claude', 'claude_oauth_usage', 'entries'],
  ['gemini', 'gemini_oauth_stats', 'models'],
  ['agy', 'agy_code_assist_quota', 'models'],
  ['kimi', 'kimi_oauth_usage', 'entries']
];

function accountFor([provider, kind, collection], entries) {
  return {
    accountRef: REF, provider, accessToken: 'fixture-not-a-real-token',
    schedulableStatus: 'schedulable', availableModels: [MODEL],
    usageSnapshot: { schemaVersion: 2, kind, [collection]: entries }
  };
}

const UNKNOWN = [null, undefined, '', '  ', false, true, [], {}, NaN, Infinity];

for (const policy of POLICIES) {
  const [provider] = policy;
  test(`${provider}: an unknown or invalid numeric bucket is not zero and cannot prove exhaustion`, () => {
    for (const remainingPct of UNKNOWN) {
      const account = accountFor(policy, [{ model: MODEL, remainingPct }]);
      const decision = evaluateProviderModelUsage(provider, account, MODEL);
      assert.equal(decision.status, 'unknown', `unexpected status for ${String(remainingPct)}`);
      assert.equal(decision.remainingPct, null);
      assert.equal(isUsageDecisionSchedulable(decision), true);
    }
  });

  test(`${provider}: known numeric zero still blocks and numeric strings retain compatibility`, () => {
    for (const value of [0, '0', -1]) {
      const decision = evaluateProviderModelUsage(provider, accountFor(policy, [{ model: MODEL, remainingPct: value }]), MODEL);
      assert.equal(decision.status, 'exhausted');
      assert.equal(decision.remainingPct, 0);
      assert.equal(isUsageDecisionSchedulable(decision), false);
    }
    const available = evaluateProviderModelUsage(provider, accountFor(policy, [{ model: MODEL, remainingPct: '37.5' }]), MODEL);
    assert.equal(available.status, 'available');
    assert.equal(available.remainingPct, 37.5);
  });

  test(`${provider}: an unknown bucket does not drag a known healthy bucket to zero`, () => {
    const account = accountFor(policy, [{ model: MODEL, remainingPct: null }, { model: MODEL, remainingPct: 65 }]);
    assert.equal(evaluateProviderModelUsage(provider, account, MODEL).remainingPct, 65);
    account.usageSnapshot[policy[2]].push({ model: MODEL, remainingPct: 0 });
    assert.equal(evaluateProviderModelUsage(provider, account, MODEL).status, 'exhausted');
  });
}

for (const provider of ['codex', 'kimi']) test(`${provider}: absent account-summary quota stays unknown rather than becoming a fallback zero`, () => {
  for (const value of UNKNOWN) {
    const decision = evaluateProviderModelUsage(provider, { provider, accountRef: REF, remainingPct: value }, MODEL);
    assert.equal(decision.status, 'unknown');
    assert.equal(decision.remainingPct, null);
  }
  assert.equal(evaluateProviderModelUsage(provider, { provider, accountRef: REF, remainingPct: 0 }, MODEL).status, 'exhausted');
  assert.equal(evaluateProviderModelUsage(provider, { provider, accountRef: REF, remainingPct: '15' }, MODEL).remainingPct, 15);
});

test('the canonical decision factory rejects booleans and containers before JavaScript coercion', () => {
  for (const remainingPct of UNKNOWN) {
    const decision = createUsageDecisionForRemaining({ remainingPct, scope: 'account', scopeKey: REF });
    assert.equal(decision.status, 'unknown');
    assert.equal(decision.remainingPct, null);
  }
});

test('both model indexes retain an unknown-quota candidate but filter an actually exhausted model', () => {
  const account = accountFor(POLICIES.find(row => row[0] === 'agy'), [
    { model: 'fixture-unknown', remainingPct: null }, { model: 'fixture-zero', remainingPct: 0 }
  ]);
  account.availableModels = ['fixture-unknown', 'fixture-zero'];
  const state = {
    accounts: { codex: [], gemini: [], claude: [], agy: [account] },
    webUiModelsCache: { byAccount: { [REF]: account.availableModels }, byProvider: { agy: account.availableModels } }
  };
  const capabilities = buildModelCapabilityIndex(state, { provider: 'auto' });
  assert.deepEqual(listAccountRefsForModelProvider(capabilities, 'fixture-unknown', 'agy'), [REF]);
  assert.deepEqual(listAvailableAccountRefsForModelProvider(capabilities, 'fixture-unknown', 'agy'), [REF]);
  assert.deepEqual(listAvailableAccountRefsForModelProvider(capabilities, 'fixture-zero', 'agy'), []);
  const accounts = buildModelAccountIndex(state, {});
  assert.deepEqual(findAccountsForModel(accounts, 'fixture-unknown'), [REF]);
  assert.deepEqual(findRoutableAccountsForModel(accounts, 'fixture-unknown', 'agy'), [REF]);
  assert.deepEqual(findRoutableAccountsForModel(accounts, 'fixture-zero', 'agy'), []);
});
