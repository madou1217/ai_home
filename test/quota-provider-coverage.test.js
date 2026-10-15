'use strict';

// 额度抽象的**跨模块不变量**（每条都对应一次真实事故或一次设计约束）：
//   1) 每个 catalog provider 都必须在自己的描述符里**显式回答额度**（有 or 没有 + 原因）
//      —— 取代「中央的无额度清单」：答案跟着 provider 走，新增 provider 不做决定就红；
//   2) 每个已登记的 kind 都能被服务端规范化（CodeBuddy 曾因缺这一支被丢成空 → 显示「已耗尽」）；
//   3) WebUI 的 kind 集合与服务端登记表同步（Cline Pass 曾在 WebUI 侧不存在）；
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

test('WebUI 的 kind 集合与服务端登记表保持同步（跨语言镜像）', () => {
  const file = path.join(__dirname, '..', 'web/src/features/accounts/account-state.ts');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('const ENTRY_WINDOW_SNAPSHOT_KINDS');
  const end = source.indexOf('export function getUsageSnapshotRemainingPct');
  assert.equal(start > 0 && end > start, true, 'account-state.ts 的 kind 集合结构变了，请更新本守卫');
  const webKinds = new Set([...source.slice(start, end).matchAll(/'([a-z][a-z0-9_]*)'/g)].map((match) => match[1]));
  const registered = new Set(Object.values(USAGE_SNAPSHOT_KINDS));
  for (const kind of registered) {
    assert.equal(webKinds.has(kind), true, `WebUI 不认识 ${kind}：账号页读不到该快照的窗口剩余`);
  }
  for (const kind of webKinds) {
    assert.equal(registered.has(kind), true, `WebUI 里的 ${kind} 已不在服务端登记表，属于陈旧名单`);
  }
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
