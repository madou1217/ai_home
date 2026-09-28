'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { planModelPolicySync, policyKey } = require('../lib/account/go-bridge/go-model-policy-sync');

const NODE_OAUTH = 'acct_4a833dc13a62526ef5ab';
const GO_OAUTH = 'acct_4a833dc13a62526ef5ab';
const NODE_RELAY = 'acct_d62c5c4961277f9403c8';
const GO_RELAY = 'acct_b4516b78f926f059bb8b';

const NODE_RELAY_TWIN = 'acct_6576e98b2b025cc545cb';

function links() {
  return new Map([
    [NODE_OAUTH, GO_OAUTH],
    [NODE_RELAY, GO_RELAY],
    [NODE_RELAY_TWIN, GO_RELAY]
  ]);
}

function settings(accountModels) {
  return { accountModels };
}

test('Node 关闭的账号模型映射为 Go force_disable，即使 Go 尚未发现该模型', () => {
  const plan = planModelPolicySync({
    settings: settings([
      { id: 'gpt-6-astra', provider: 'codex', accountRef: NODE_OAUTH, enabled: false, manual: false },
      { id: 'gpt-5.5', provider: 'codex', accountRef: NODE_OAUTH, enabled: true, manual: false }
    ]),
    goRefByNodeRef: links(),
    goModelPolicies: [],
    pushedKeys: []
  });
  assert.deepEqual(plan.writes, [{ accountRef: GO_OAUTH, modelId: 'gpt-6-astra', manualPolicy: 'force_disable' }]);
  assert.deepEqual(plan.desiredKeys, [policyKey(GO_OAUTH, 'gpt-6-astra')]);
});

test('手动添加并启用的模型映射为 force_enable；Node 账号经 link 翻译为 Go 账号', () => {
  const plan = planModelPolicySync({
    settings: settings([{ id: 'gpt-6-sol', provider: 'codex', accountRef: NODE_RELAY, enabled: true, manual: true }]),
    goRefByNodeRef: links(),
    goModelPolicies: [],
    pushedKeys: []
  });
  assert.deepEqual(plan.writes, [{ accountRef: GO_RELAY, modelId: 'gpt-6-sol', manualPolicy: 'force_enable' }]);
});

test('Go 已一致时稳态零写入', () => {
  const plan = planModelPolicySync({
    settings: settings([{ id: 'gpt-6-astra', provider: 'codex', accountRef: NODE_OAUTH, enabled: false }]),
    goRefByNodeRef: links(),
    goModelPolicies: [{ accountRef: GO_OAUTH, modelId: 'gpt-6-astra', manualPolicy: 'force_disable' }],
    pushedKeys: [policyKey(GO_OAUTH, 'gpt-6-astra')]
  });
  assert.deepEqual(plan.writes, []);
});

test('Node 重新启用后只还原本同步写过的覆盖，不碰 Go 侧自行设置的策略', () => {
  const plan = planModelPolicySync({
    settings: settings([{ id: 'gpt-6-astra', provider: 'codex', accountRef: NODE_OAUTH, enabled: true, manual: false }]),
    goRefByNodeRef: links(),
    goModelPolicies: [
      { accountRef: GO_OAUTH, modelId: 'gpt-6-astra', manualPolicy: 'force_disable' },
      { accountRef: GO_OAUTH, modelId: 'gpt-5.6-luna', manualPolicy: 'force_disable' }
    ],
    pushedKeys: [policyKey(GO_OAUTH, 'gpt-6-astra')]
  });
  assert.deepEqual(plan.writes, [{ accountRef: GO_OAUTH, modelId: 'gpt-6-astra', manualPolicy: 'inherit' }]);
  assert.deepEqual(plan.desiredKeys, []);
});

test('未建立 link 的 Node 账号不产生写入', () => {
  const plan = planModelPolicySync({
    settings: settings([{ id: 'gpt-6-astra', provider: 'codex', accountRef: 'acct_000000000000000000aa', enabled: false }]),
    goRefByNodeRef: links(),
    goModelPolicies: [],
    pushedKeys: []
  });
  assert.deepEqual(plan.writes, []);
});

test('归并到同一 Go 账号的多个 Node 账号全部参与，冲突时关闭优先', () => {
  const plan = planModelPolicySync({
    settings: settings([
      { id: 'gpt-6-sol', provider: 'codex', accountRef: NODE_RELAY, enabled: true, manual: true },
      { id: 'gpt-6-sol', provider: 'codex', accountRef: NODE_RELAY_TWIN, enabled: false, manual: false },
      { id: 'gpt-6-luna', provider: 'codex', accountRef: NODE_RELAY_TWIN, enabled: false, manual: false }
    ]),
    goRefByNodeRef: links(),
    goModelPolicies: [],
    pushedKeys: []
  });
  assert.deepEqual(plan.writes, [
    { accountRef: GO_RELAY, modelId: 'gpt-6-sol', manualPolicy: 'force_disable' },
    { accountRef: GO_RELAY, modelId: 'gpt-6-luna', manualPolicy: 'force_disable' }
  ]);
});
