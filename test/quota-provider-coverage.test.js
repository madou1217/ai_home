'use strict';

// 额度抽象的**跨模块不变量**（三条，各自对应一次真实事故）：
//   1) 注册表覆盖 = 合同 quota_usage 能力 ∪ 额度插件 —— 家族曾被写死名单漏掉，额度从未采集；
//   2) 每个已登记的 kind 都能被服务端规范化 —— CodeBuddy 快照曾被规范化丢成空、显示「已耗尽」；
//   3) WebUI 的 kind 集合与服务端登记表同步 —— Cline Pass 的 kind 曾在 WebUI 侧不存在，
//      账号页只能拿到标量而不是快照窗口。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listProviderIds, listProvidersByCapability } = require('../lib/provider-catalog');
const {
  createQuotaRegistry,
  describeQuotaSources,
  formatQuotaSourceLines,
  getQuotaRegistry,
  listQuotaProviders
} = require('../lib/usage/quota');
const { USAGE_SNAPSHOT_KINDS } = require('../lib/account/usage-remaining');
const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');

function sortedLower(values) {
  return values.map((value) => String(value).toLowerCase()).sort();
}

test('额度源覆盖 = 合同 quota_usage 能力 ∪ 额度插件（不再有第三方名单）', () => {
  const registry = getQuotaRegistry();
  const nativeProviders = sortedLower(listProvidersByCapability('quotaUsage'));
  const pluginProviders = sortedLower(
    registry.listSources().filter((source) => source.plugin).flatMap((source) => source.providers)
  );
  assert.deepEqual(listQuotaProviders(), [...new Set([...nativeProviders, ...pluginProviders])].sort());
  // native 源声明必须与合同能力一一对应：多了说明某 provider 在合同里没声明能力。
  const declaredNative = sortedLower(
    registry.listSources().filter((source) => !source.plugin).flatMap((source) => source.providers)
  );
  assert.deepEqual(declaredNative, nativeProviders);
});

test('额度插件只能认领已知 provider', () => {
  const known = new Set(sortedLower(listProviderIds()));
  for (const source of getQuotaRegistry().listSources().filter((entry) => entry.plugin)) {
    for (const provider of source.providers) {
      assert.equal(known.has(String(provider).toLowerCase()), true, `${source.id} 认领了未知 provider ${provider}`);
    }
  }
});

test('每个已登记的额度 kind 都能被服务端规范化（否则账号页会把快照丢成空）', () => {
  const registry = getQuotaRegistry();
  const entryKinds = [...registry.listSnapshotKinds('window'), ...registry.listSnapshotKinds('bucket')];
  const modelKinds = registry.listSnapshotKinds('models');
  assert.equal(entryKinds.length + modelKinds.length > 0, true);
  for (const kind of entryKinds) {
    const view = normalizeAccountUsageSnapshot({
      kind,
      capturedAt: 1,
      account: {},
      entries: [{ bucket: 'x', window: '1h', windowMinutes: 60, remainingPct: 50 }]
    });
    assert.equal(view && view.kind, kind, `${kind} 没有被 normalizeAccountUsageSnapshot 接受`);
    assert.equal(Array.isArray(view.entries), true);
  }
  for (const kind of modelKinds) {
    const view = normalizeAccountUsageSnapshot({
      kind,
      capturedAt: 1,
      account: {},
      models: [{ model: 'm', remainingPct: 50 }]
    });
    assert.equal(view && view.kind, kind, `${kind} 没有被 normalizeAccountUsageSnapshot 接受`);
    assert.equal(Array.isArray(view.models), true);
  }
});

test('登记表里的每个 kind 都有额度源产出（没有孤儿 kind）', () => {
  const registry = getQuotaRegistry();
  const covered = new Set([
    ...registry.listSnapshotKinds('window'),
    ...registry.listSnapshotKinds('bucket'),
    ...registry.listSnapshotKinds('models')
  ]);
  for (const kind of Object.values(USAGE_SNAPSHOT_KINDS)) {
    assert.equal(covered.has(kind), true, `${kind} 没有任何额度源产出`);
  }
});

test('WebUI 的 kind 集合与服务端登记表保持同步（跨语言镜像）', () => {
  const file = path.join(__dirname, '..', 'web/src/features/accounts/account-state.ts');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('const ENTRY_WINDOW_SNAPSHOT_KINDS');
  const end = source.indexOf('export function getUsageSnapshotRemainingPct');
  assert.equal(start > 0 && end > start, true, 'account-state.ts 的 kind 集合结构变了，请更新本守卫');
  const block = source.slice(start, end);
  const webKinds = new Set([...block.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((match) => match[1]));
  const registered = new Set(Object.values(USAGE_SNAPSHOT_KINDS));
  for (const kind of registered) {
    assert.equal(webKinds.has(kind), true, `WebUI 不认识 ${kind}：账号页读不到该快照的窗口剩余`);
  }
  for (const kind of webKinds) {
    assert.equal(registered.has(kind), true, `WebUI 里的 ${kind} 已不在服务端登记表，属于陈旧名单`);
  }
});

// 刻意没有额度来源的 provider（每次新增 provider 都必须显式做这个决定）：
//   opencode —— 官方无额度接口（Go/Zen 用量只能从会话统计侧算，属于 usage_scan，不是额度）；
//   qoder / qodercn —— 凭据是 WASM + machineId 加密的本地 blob、请求过 sgsdk 签名，
//     客户端侧没有可复用的额度查询面；上游配额墙只在推理失败时以 error_code 118 暴露
//     （见 lib/server/qoder-cli-transport.js），拿不到「剩余百分比」。
// 将来接上额度时：写插件 + 从本清单移除 + 走第 6 节的四步。
const PROVIDERS_WITHOUT_QUOTA_SOURCE = Object.freeze(['opencode', 'qoder', 'qodercn']);

test('没有额度来源的 provider 必须是显式清单：新增 provider 不能静默无额度', () => {
  const withoutQuota = sortedLower(listProviderIds()).filter((provider) => !listQuotaProviders().includes(provider));
  assert.deepEqual(withoutQuota, [...PROVIDERS_WITHOUT_QUOTA_SOURCE].sort());
});

test('describeQuotaSources 汇总原生/插件来源，并把加载失败暴露出来', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aih-quota-coverage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginsDir = path.join(root, 'quota-plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'broken.js'), 'module.exports = { id: "broken" };');

  const summary = describeQuotaSources({ registry: createQuotaRegistry({ aiHomeDir: root }).registry });
  assert.equal(summary.total, summary.native + summary.plugins.length);
  assert.deepEqual(summary.plugins.map((plugin) => plugin.id), ['cline-pass']);
  assert.deepEqual(summary.plugins[0].providers, ['cline']);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].code, 'quota_plugin_contract_version_unsupported');
  assert.match(summary.errors[0].target, /broken\.js$/);

  const lines = formatQuotaSourceLines({ registry: createQuotaRegistry({ aiHomeDir: root }).registry });
  assert.match(lines[0], /^quota sources: \d+ \(native=\d+, plugin=1: cline-pass→cline\)$/);
  assert.match(lines[1], /^quota plugin errors: 1$/);
  assert.match(lines[2], /broken\.js$/);
});
