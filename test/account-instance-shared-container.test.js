'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildModelAccountIndex } = require('../lib/server/model-account-index');
const { buildModelCapabilityIndex } = require('../lib/server/model-capability-index');

const REF_A = 'acct_0123456789abcdef0123';
const REF_B = 'acct_aaaaaaaaaaaaaaaaaaaa';

function createState() {
  return {
    accounts: {
      codex: [{ accountRef: REF_A, provider: 'codex', accessToken: 't', schedulableStatus: 'schedulable' }],
      claude: [{ accountRef: REF_B, provider: 'claude', accessToken: 't', schedulableStatus: 'schedulable' }]
    },
    webUiModelsCache: {
      updatedAt: 1,
      byAccount: { [REF_A]: ['gpt-5.6-sol'], [REF_B]: ['claude-opus-5-5'] }
    },
    modelCatalogSettings: { version: 1, models: [], updatedAt: 0 }
  };
}

test('both indexes share one account-instance container instead of copying it', () => {
  const state = createState();
  const accountIndex = buildModelAccountIndex(state, {});
  const capabilityIndex = buildModelCapabilityIndex(state, {});

  // 收敛的核心断言：两张索引的 accountByRef 是**同一个 Map 对象**，不是各存一份副本。
  assert.equal(accountIndex.accountByRef, capabilityIndex.accountByRef);
  assert.equal(accountIndex.accountByRef, state.accountInstances.byRef);
});

test('a write through one index is visible through the other without any proxy', () => {
  const state = createState();
  const accountIndex = buildModelAccountIndex(state, {});
  const capabilityIndex = buildModelCapabilityIndex(state, {});

  // 通过索引 A 写入冷却，索引 B 立刻看到——这是「一个实例一份状态」的实际收益。
  accountIndex.accountByRef.get(REF_A).cooldownUntil = 99999;
  assert.equal(capabilityIndex.accountByRef.get(REF_A).cooldownUntil, 99999);
});

test('the instance in the index is the very object held by the runtime pool', () => {
  const state = createState();
  const index = buildModelAccountIndex(state, {});

  // 不是副本、不是 Proxy、不是 Object.create 包装：就是 state.accounts 里那一个。
  assert.equal(index.accountByRef.get(REF_A), state.accounts.codex[0]);
  assert.equal(index.accountByRef.get(REF_B), state.accounts.claude[0]);
});

test('indexes carry provider onto the shared instance for consumers that read account.provider', () => {
  const state = createState();
  // 模拟既有测试夹具：账号对象本身没写 provider 字段。
  delete state.accounts.codex[0].provider;
  const index = buildModelAccountIndex(state, {});

  // provider-routing 的绑定分、model-catalog-knowledge 的 providerHasAccounts、
  // go-core-route-deferral 的承载者判定都读这个字段。
  assert.equal(index.accountByRef.get(REF_A).provider, 'codex');
});

test('a full rebuild drops accounts that left the pool and keeps those still present', () => {
  const state = createState();
  buildModelAccountIndex(state, {});

  // REF_B 离开运行池后重建：陈旧条目必须清掉，否则按 accountByRef 遍历的判定会算错。
  state.accounts.claude = [];
  const rebuilt = buildModelAccountIndex(state, {});

  assert.equal(rebuilt.accountByRef.has(REF_B), false);
  assert.equal(rebuilt.accountByRef.has(REF_A), true);
});

test('an account with no discovered models still survives a rebuild', () => {
  const state = createState();
  // REF_B 的目录为空：它不进 accountToModels，但仍是真实账号 —— v1-router 的
  // accountCatalogIsUnknown 正是靠这类账号判定「目录未知」。
  state.webUiModelsCache.byAccount = { [REF_A]: ['gpt-5.6-sol'] };
  buildModelAccountIndex(state, {});
  const rebuilt = buildModelAccountIndex(state, {});

  assert.equal(rebuilt.accountByRef.has(REF_B), true, '无目录账号不得被 retain 误删');
});
