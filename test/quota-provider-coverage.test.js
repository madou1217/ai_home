'use strict';

// 额度抽象的**跨模块不变量**（每条都对应一次真实事故或一次设计约束）：
//   1) 每个 catalog provider 都必须在自己的描述符里**显式回答额度**（有 or 没有 + 原因）
//      —— 取代「中央的无额度清单」：答案跟着 provider 走，新增 provider 不做决定就红；
//   2) 每个已登记的 kind 都能被服务端规范化（CodeBuddy 曾因缺这一支被丢成空 → 显示「已耗尽」）；
//   3) WebUI 不维护 kind 名单，按服务端下发的 entryShape 渲染（形态覆盖在 quota-view-provider-coverage 里守卫）；
//   4) 描述符声明的原生 handler 必须在组合根里真的存在（防止声明漂移）；
//   5) 策略链默认最稳、失败切换且过程可观察。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PROVIDER_IDS } = require('../lib/provider-catalog');
const { getProviderRegistry, listProviders } = require('../lib/providers');
const {
  describeQuotaSources,
  formatQuotaSourceLines,
  listQuotaEntryShapes,
  listQuotaProviders,
  listQuotaSnapshotKinds,
  runQuotaStrategies
} = require('../lib/usage/quota');
const { USAGE_SNAPSHOT_KINDS } = require('../lib/account/usage-remaining');
const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');

function sortedLower(values) {
  return values.map((value) => String(value).toLowerCase()).sort();
}

test('每个 catalog provider 都在自己的描述符里显式回答额度（没有中央清单）', () => {
  const registry = getProviderRegistry();
  const answers = new Map();
  for (const provider of sortedLower(PROVIDER_IDS)) {
    const quota = registry.getCapability(provider, 'quota');
    assert.ok(quota, `${provider} 没有描述符回答额度问题（新增 provider 必须写 lib/providers/defs/<id>.js）`);
    if (quota.supported === true) {
      assert.ok(quota.kind && quota.source, `${provider} 声明有额度但没有 kind/source`);
      assert.ok(quota.strategies.length > 0, `${provider} 声明有额度但没有策略`);
    } else {
      assert.equal(quota.supported, false);
      assert.ok(String(quota.reason || '').trim().length > 0, `${provider} 声明没有额度但没写原因`);
    }
    answers.set(provider, quota);
  }
  // 倒排索引与描述符一致：quota 索引覆盖全部 catalog provider。
  assert.deepEqual(listProviders('quota'), sortedLower(PROVIDER_IDS));
  // 有额度的集合 = 声明 supported:true 的那批（这里不写死名单）。
  const expectedCapable = sortedLower(PROVIDER_IDS).filter((provider) => answers.get(provider).supported === true);
  assert.deepEqual(listQuotaProviders(), expectedCapable);
});

test('每个已登记的额度 kind 都能被服务端规范化（否则账号页会把快照丢成空）', () => {
  const registry = getProviderRegistry();
  const entryKinds = [...listQuotaSnapshotKinds('window'), ...listQuotaSnapshotKinds('bucket')];
  const modelKinds = listQuotaSnapshotKinds('models');
  assert.ok(entryKinds.length + modelKinds.length > 0);
  for (const kind of entryKinds) {
    const view = normalizeAccountUsageSnapshot({
      kind, capturedAt: 1, account: {},
      entries: [{ bucket: 'x', window: '1h', windowMinutes: 60, remainingPct: 50 }]
    });
    assert.equal(view && view.kind, kind, `${kind} 没有被 normalizeAccountUsageSnapshot 接受`);
    assert.equal(Array.isArray(view.entries), true);
  }
  for (const kind of modelKinds) {
    const view = normalizeAccountUsageSnapshot({ kind, capturedAt: 1, account: {}, models: [{ model: 'm', remainingPct: 50 }] });
    assert.equal(view && view.kind, kind, `${kind} 没有被 normalizeAccountUsageSnapshot 接受`);
    assert.equal(Array.isArray(view.models), true);
  }
  // 没有孤儿 kind：登记表里的每个 kind 都有 provider 产出。
  const covered = new Set([...entryKinds, ...modelKinds]);
  for (const kind of Object.values(USAGE_SNAPSHOT_KINDS)) {
    assert.equal(covered.has(kind), true, `${kind} 没有任何 provider 产出`);
  }
  assert.equal(registry.listIds().length, PROVIDER_IDS.length);
});

test('WebUI 不再维护 kind 名单：账号页额度按服务端下发的 entryShape 渲染（跨语言镜像改为形态契约）', () => {
  const accountState = fs.readFileSync(path.join(__dirname, '..', 'web/src/features/accounts/account-state.ts'), 'utf8');
  // 历史形态是 WebUI 自己抄一份 kind 集合，漏一个 provider 就少一行额度且没人发现。
  // 现在账号级剩余由额度展示行派生，形态来自服务端 payload 的 entryShape。
  assert.equal(/ENTRY_WINDOW_SNAPSHOT_KINDS|MODEL_LIST_SNAPSHOT_KINDS/.test(accountState), false,
    'account-state.ts 又出现了 kind 名单，请改回按 entryShape 渲染');
  assert.match(accountState, /getMinRemainingPct/, '账号级剩余必须由 quota-scopes 的展示行派生');

  // 形态类型（跨语言契约）：服务端在用的每种形态都必须在 WebUI 的 QuotaEntryShape 里。
  const types = fs.readFileSync(path.join(__dirname, '..', 'web/src/types/index.ts'), 'utf8');
  const shapeUnion = /export type QuotaEntryShape =([^;]+);/.exec(types);
  assert.ok(shapeUnion, 'web/src/types/index.ts 必须声明 QuotaEntryShape');
  for (const shape of listQuotaEntryShapes()) {
    assert.match(shapeUnion[1], new RegExp(`'${shape}'`), `WebUI 的 QuotaEntryShape 缺少形态 ${shape}`);
  }
  // 展示层不得再出现 kind 字面量（那正是「漏一个 provider 就少一行」的来源）。
  const scopes = fs.readFileSync(path.join(__dirname, '..', 'web/src/components/account/quota-scopes.ts'), 'utf8');
  assert.equal(/_(?:oauth|credit|pass|assist|plan)[a-z_]*['"]/.test(scopes), false,
    'quota-scopes.ts 出现了 kind 字面量，展示层必须只按形态渲染');

  // 服务端 payload 必须真的带上形态与标签，否则 WebUI 只能再次按 kind 猜。
  const view = fs.readFileSync(path.join(__dirname, '..', 'lib/server/account-usage-view.js'), 'utf8');
  assert.match(view, /entryShape/, '账号 payload 必须下发 entryShape');
  assert.match(view, /label: scope\.label/, '账号 payload 的条目必须带上服务端算好的 label');
});

test('描述符声明的原生 handler 必须在组合根里存在（声明不得漂移）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib/cli/services/usage/snapshot.js'), 'utf8');
  const declared = new Set();
  for (const provider of listProviders('quota')) {
    for (const strategy of getProviderRegistry().listQuotaStrategies(provider)) {
      if (strategy.handler) declared.add(strategy.handler);
    }
  }
  assert.ok(declared.size > 0, '没有任何 handler 型策略？原生 provider 应该声明 handler');
  for (const handler of declared) {
    // 组合根以 `['<handler>', ...]`（Map 表）或 `<handler>: ...`（对象表）登记 handler。
    assert.match(source, new RegExp(`(?:\\['${handler}'\\s*,|\\b${handler}:\\s)`), `组合根没有实现 handler '${handler}'`);
  }
});

test('策略链：默认最稳策略；第一条不可用时自动切换，且每次尝试都可观察', async () => {
  const attemptsSeen = [];
  const strategies = [
    { id: 'stable', clientDependent: false, probe: () => ({ probe: async () => ({ error: 'upstream_down' }) }) },
    { id: 'fallback', clientDependent: true, probe: () => ({ probe: async () => ({ snapshot: { ok: true } }) }) }
  ];
  // 通过注册表注入两条策略，验证「最稳优先 + 失败切换 + attempts 记录」。
  const registry = getProviderRegistry();
  const original = registry.listQuotaStrategies;
  registry.listQuotaStrategies = () => strategies;
  try {
    const result = await runQuotaStrategies('cline', 'acct_test', { deps: {}, options: { registry } });
    assert.deepEqual(result.snapshot, { ok: true });
    assert.equal(result.strategyId, 'fallback');
    attemptsSeen.push(...result.attempts);
  } finally {
    registry.listQuotaStrategies = original;
  }
  assert.deepEqual(attemptsSeen, [{ strategyId: 'stable', error: 'upstream_down', auth: false }]);
});

test('诊断输出：没有额度的 provider 带原因、依赖客户端的 provider 被点名', () => {
  const summary = describeQuotaSources();
  assert.equal(summary.total, PROVIDER_IDS.length);
  assert.equal(summary.supported + summary.unsupported.length, summary.total);
  for (const entry of summary.unsupported) {
    assert.ok(entry.reason.trim().length > 0, `${entry.provider} 的不可得原因不能为空`);
  }
  const lines = formatQuotaSourceLines();
  assert.match(lines[0], /^quota sources: \d+ provider\(s\), with quota=\d+, no quota=\d+$/);
  assert.equal(lines.length > 1, true);
});
