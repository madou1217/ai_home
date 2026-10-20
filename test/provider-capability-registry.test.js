'use strict';

// Provider 能力注册表（lib/providers/*）：描述符契约、动态加载、**倒排索引**、
// 额度策略链（默认最稳 + 失败切换）与诊断可见性。
//
// 设计意图：provider 自己声明能力（lib/providers/defs/<id>.js），注册表只做索引，
// 因此新增 provider 不需要在消费侧或中央清单里加行 —— 本文件守卫这一点。

const test = require('node:test');
const { EXTENSION_DIRS_ENV, serializeProviderExtensionDirs } = require('../lib/providers/extension-dirs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProviderRegistry, orderQuotaStrategies } = require('../lib/providers/registry');
const { loadProviderDefinitions, legacyPluginToDescriptors } = require('../lib/providers/loader');
const {
  createProvidersRegistry,
  formatProviderCapabilityLines,
  getProviderCapability,
  getProviderRegistry,
  listProviders
} = require('../lib/providers');
const {
  describeQuotaProvider,
  describeQuotaSources,
  formatQuotaSourceLines,
  listQuotaProviders,
  listQuotaSnapshotKinds,
  listQuotaStrategies,
  runQuotaStrategies
} = require('../lib/usage/quota');

function quotaDescriptor(id, overrides = {}) {
  return {
    contractVersion: 1,
    id,
    capabilities: {
      quota: {
        supported: true,
        kind: 'cline_pass_usage',
        source: 'demo_api',
        shape: 'entries',
        entryShape: 'window',
        strategies: [{
          id: `${id}-http`, transport: 'http', clientDependent: false,
          probe: () => ({ probe: async () => ({ snapshot: { kind: 'cline_pass_usage', source: 'demo_api', capturedAt: 1, entries: [] } }) })
        }]
      },
      ...overrides
    }
  };
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('注册表建立 provider → 能力 与 能力 → providers 两张索引（倒排）', () => {
  const registry = createProviderRegistry({ descriptors: [quotaDescriptor('demo', { relay: { transport: 'http', clientDependent: false } })] });
  assert.deepEqual(registry.listIds(), ['demo']);
  assert.deepEqual(registry.listCapabilities('demo'), ['quota', 'relay']);
  assert.deepEqual(registry.listProviders('quota'), ['demo']);
  assert.deepEqual(registry.listProviders('relay'), ['demo']);
  assert.deepEqual(registry.listProviders('nope'), []);
  assert.deepEqual(registry.listCapabilityIndex(), { quota: ['demo'], relay: ['demo'] });
  assert.equal(registry.supports('demo', 'quota'), true);
  assert.equal(registry.getCapability('demo', 'quota').kind, 'cline_pass_usage');
});

test('额度必须显式回答：不支持也要给 reason，缺了就报错（不允许静默无额度）', () => {
  const registry = createProviderRegistry();
  assert.throws(
    () => registry.register({ contractVersion: 1, id: 'demo', capabilities: { relay: { transport: 'http' } } }),
    /provider_descriptor_quota_missing/
  );
  assert.throws(
    () => registry.register({ contractVersion: 1, id: 'demo', capabilities: { quota: { supported: false } } }),
    /provider_descriptor_quota_reason_missing/
  );
  const ok = registry.register({ contractVersion: 1, id: 'demo', capabilities: { quota: { supported: false, reason: 'no upstream api' } } });
  assert.equal(ok.capabilities.quota.supported, false);
  assert.deepEqual(registry.listProviders('quota'), ['demo']);
});

test('策略声明必须自洽：transport 与 clientDependent 不能互相矛盾，实现二选一', () => {
  const registry = createProviderRegistry();
  const base = (strategy) => ({ contractVersion: 1, id: 'demo', capabilities: { quota: {
    supported: true, kind: 'cline_pass_usage', source: 'demo', shape: 'entries', entryShape: 'window', strategies: [strategy]
  } } });
  assert.throws(() => registry.register(base({ id: 'a', transport: 'http', clientDependent: true, handler: 'x' })), /transport_conflict/);
  assert.throws(() => registry.register(base({ id: 'a', transport: 'client-cli', clientDependent: false, handler: 'x' })), /transport_conflict/);
  assert.throws(() => registry.register(base({ id: 'a', transport: 'http', clientDependent: false })), /strategy_impl_missing/);
  assert.throws(() => registry.register(base({ id: 'a', transport: 'http', clientDependent: false, handler: 'x', probe: () => ({}) })), /strategy_impl_ambiguous/);
  // clientOptional 与 clientDependent=false 合法（例如 codex：HTTP 为主，必要时读一下客户端版本）。
  assert.equal(registry.register(base({ id: 'a', transport: 'http', clientDependent: false, handler: 'x', clientOptional: true })).capabilities.quota.strategies[0].clientOptional, true);
});

test('策略链默认把不依赖客户端的排前面，组内保持声明顺序', () => {
  const ordered = orderQuotaStrategies([
    { id: 'client', clientDependent: true },
    { id: 'http-a', clientDependent: false },
    { id: 'http-b', clientDependent: false }
  ]);
  assert.deepEqual(ordered.map((strategy) => strategy.id), ['http-a', 'http-b', 'client']);
});

test('activity 能力：声明式动作 + 倒排，不写 provider 名单；坏声明当场拒绝', () => {
  const registry = createProviderRegistry({
    descriptors: [
      quotaDescriptor('demo', {
        activity: {
          supported: true,
          actions: [
            { id: 'daily_checkin', label: '每日签到', handler: 'demo-daily' },
            { id: 'trial_plan', label: '领取试用套餐', handler: 'demo-plan', description: '窗口开放时可领' }
          ]
        }
      })
    ]
  });

  assert.deepEqual(registry.listProviders('activity'), ['demo']);
  assert.deepEqual(
    registry.getCapability('demo', 'activity').actions.map((action) => action.id),
    ['daily_checkin', 'trial_plan']
  );
  assert.equal(registry.getCapability('demo', 'activity').actions[1].description, '窗口开放时可领');

  const bad = (activity) => () => registry.register({
    contractVersion: 1,
    id: 'broken',
    capabilities: { quota: { supported: false, reason: 'none' }, activity }
  });
  // 不支持必须写原因
  assert.throws(bad({ supported: false }), /provider_descriptor_activity_reason_missing/);
  // 支持必须有动作
  assert.throws(bad({ supported: true, actions: [] }), /provider_descriptor_activity_actions_empty/);
  // 动作必须可执行：label 给 UI，handler 给宿主
  assert.throws(bad({ supported: true, actions: [{ id: 'a', handler: 'h' }] }), /provider_descriptor_activity_action_label_missing/);
  assert.throws(bad({ supported: true, actions: [{ id: 'a', label: 'A' }] }), /provider_descriptor_activity_action_handler_invalid/);
  // 同一 provider 内动作 id 唯一
  assert.throws(
    bad({ supported: true, actions: [
      { id: 'a', label: 'A', handler: 'h' },
      { id: 'a', label: 'B', handler: 'h' }
    ] }),
    /provider_descriptor_activity_action_duplicate/
  );
});

test('内置额度 provider 的 activity 声明可被倒排索引到', () => {
  const registry = getProviderRegistry();
  const providers = registry.listProviders('activity');
  for (const provider of ['qoder', 'qodercn', 'zcode']) {
    assert.ok(providers.includes(provider), `${provider} should declare activity`);
    const capability = registry.getCapability(provider, 'activity');
    assert.equal(capability.supported, true);
    assert.ok(capability.actions.length > 0);
    for (const action of capability.actions) {
      assert.ok(action.label);
      assert.ok(action.handler);
    }
  }
  // 动作名是产品文案，不允许被泛化成“领福利”：Qoder 叫签到，ZCode 叫领臭鸡蛋。
  assert.equal(registry.getCapability('qoder', 'activity').actions[0].label, '签到');
  assert.equal(registry.getCapability('qodercn', 'activity').actions[0].label, '签到');
  assert.equal(registry.getCapability('zcode', 'activity').actions[0].label, '领臭鸡蛋');
});

test('冲突策略：同一 provider 重复注册以内置优先，外部覆盖被记为可观察错误', () => {
  const registry = createProviderRegistry();
  registry.register(quotaDescriptor('demo'));
  assert.throws(() => registry.register(quotaDescriptor('demo'), { origin: 'external' }), /provider_descriptor_conflict/);
  assert.equal(registry.get('demo').capabilities.quota.source, 'demo_api');
});

test('描述符目录动态扫描：内置目录 + 外部目录 + 兼容旧额度插件形状', (t) => {
  const root = tempDir(t, 'aih-provider-defs-');
  const builtinDir = path.join(root, 'defs');
  const externalDir = path.join(root, 'external');
  const legacyDir = path.join(root, 'legacy-plugins');
  fs.mkdirSync(builtinDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(builtinDir, 'good.js'), `module.exports = {
  contractVersion: 1, id: 'good',
  capabilities: { quota: { supported: false, reason: 'demo: 只验证加载路径' } }
};`);
  fs.writeFileSync(path.join(builtinDir, 'broken.js'), 'module.exports = { id: "broken" };');
  fs.writeFileSync(path.join(externalDir, 'extra.cjs'), `module.exports = {
  contractVersion: 1, id: 'extra',
  capabilities: { quota: { supported: true, kind: 'cline_pass_usage', source: 'extra_api', shape: 'entries', entryShape: 'window',
    strategies: [{ id: 'extra-http', transport: 'http', clientDependent: false, probe: () => ({ probe: async () => ({}) }) }] } }
};`);
  fs.writeFileSync(path.join(legacyDir, 'legacy.js'), `module.exports = {
  id: 'legacy-plugin', contractVersion: 1, providers: ['legacy'], snapshotKind: 'cline_pass_usage',
  source: 'legacy_api', shape: 'entries', createProbe: () => ({ probe: async () => ({}) })
};`);

  const registry = createProviderRegistry();
  const result = loadProviderDefinitions({
    registry, builtinDir, aiHomeDir: root, fs,
    env: { [EXTENSION_DIRS_ENV]: serializeProviderExtensionDirs({ defs: externalDir, quota: legacyDir }) }
  });
  assert.deepEqual(result.loaded.map((entry) => entry.id).sort(), ['extra', 'good', 'legacy']);
  assert.equal(registry.has('legacy'), true);
  assert.equal(registry.getCapability('legacy', 'quota').source, 'legacy_api');
  const errors = registry.listLoadErrors();
  assert.equal(errors.length, 1);
  assert.match(errors[0].code, /provider_descriptor_/);
  assert.match(errors[0].target, /broken\.js$/);
});

test('旧额度插件形状转换后语义不变（一个插件可覆盖多个 provider）', () => {
  const descriptors = legacyPluginToDescriptors({
    id: 'multi', providers: ['a', 'b'], snapshotKind: 'cline_pass_usage', source: 'multi_api', shape: 'entries',
    createProbe: () => ({ probe: async () => ({}) })
  });
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), ['a', 'b']);
  for (const descriptor of descriptors) {
    const quota = descriptor.capabilities.quota;
    assert.equal(quota.source, 'multi_api');
    assert.equal(quota.strategies[0].transport, 'http');
    assert.equal(quota.strategies[0].clientDependent, false);
  }
});
