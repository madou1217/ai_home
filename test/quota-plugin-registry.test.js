'use strict';

// 额度抽象（lib/usage/quota）：插件契约、注册表合并（native ∪ plugin）、冲突策略、
// 插件目录加载与「加载失败必须可观察」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createQuotaProviderRegistry } = require('../lib/usage/quota/registry');
const { buildNativeQuotaSources } = require('../lib/usage/quota/native-sources');
const { loadQuotaPlugins, resolveExternalPluginDirs } = require('../lib/usage/quota/loader');
const {
  createQuotaRegistry,
  listQuotaProviders,
  describeQuotaProvider,
  resolveQuotaTrustRule
} = require('../lib/usage/quota');
const { USAGE_SNAPSHOT_KINDS } = require('../lib/account/usage-remaining');

function makePlugin(overrides = {}) {
  return {
    id: 'demo',
    contractVersion: 1,
    providers: ['demo'],
    snapshotKind: 'cline_pass_usage',
    source: 'demo_api',
    shape: 'entries',
    createProbe: () => ({ probe: async () => ({ snapshot: { kind: 'cline_pass_usage', source: 'demo_api' } }) }),
    ...overrides
  };
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('额度注册表把原生源与插件合并成同一个 provider 视图', () => {
  const registry = createQuotaProviderRegistry({ nativeSources: buildNativeQuotaSources() });
  assert.equal(registry.has('kimi'), true);
  assert.equal(registry.get('kimi').origin, 'native');
  assert.equal(registry.has('cline'), false);
  registry.registerPlugin(makePlugin(), { origin: 'builtin' });
  assert.equal(registry.has('demo'), true);
  assert.equal(registry.get('demo').origin, 'plugin');
  assert.equal(registry.get('demo').snapshotKind, USAGE_SNAPSHOT_KINDS.cline);
  assert.deepEqual(
    registry.listProviders().filter((provider) => provider === 'demo' || provider === 'kimi'),
    ['demo', 'kimi']
  );
});

test('插件不得覆盖 native，也不得抢占别的插件已认领的 provider', () => {
  const registry = createQuotaProviderRegistry({ nativeSources: buildNativeQuotaSources() });
  assert.throws(
    () => registry.registerPlugin(makePlugin({ id: 'x', providers: ['kimi'] })),
    /quota_plugin_provider_conflict/
  );
  registry.registerPlugin(makePlugin(), { origin: 'builtin' });
  assert.throws(() => registry.registerPlugin(makePlugin({ id: 'y' })), /quota_plugin_provider_conflict/);
});

test('插件契约校验：非法定义必须报错而不是静默登记', () => {
  const registry = createQuotaProviderRegistry({ nativeSources: buildNativeQuotaSources() });
  const cases = [
    [makePlugin({ contractVersion: 2 }), /quota_plugin_contract_version_unsupported/],
    [makePlugin({ id: 'BAD ID' }), /quota_plugin_id_invalid/],
    [makePlugin({ providers: [] }), /quota_plugin_providers_missing/],
    [makePlugin({ snapshotKind: 'not_registered_kind' }), /quota_plugin_snapshot_kind_unregistered/],
    [makePlugin({ source: '' }), /quota_plugin_source_missing/],
    [makePlugin({ shape: 'blob' }), /quota_plugin_shape_invalid/],
    [makePlugin({ createProbe: null }), /quota_plugin_create_probe_missing/]
  ];
  for (const [definition, pattern] of cases) {
    assert.throws(() => registry.registerPlugin(definition), pattern);
  }
});

test('可信快照规则来自注册表：插件 provider 可被信任，错 source 被拒', () => {
  const registry = createQuotaProviderRegistry({ nativeSources: buildNativeQuotaSources() });
  registry.registerPlugin(makePlugin(), { origin: 'builtin' });
  const rule = registry.trustRule('demo');
  assert.equal(rule.kind, USAGE_SNAPSHOT_KINDS.cline);
  assert.deepEqual([...rule.sources], ['demo_api']);
  assert.equal(rule.shape, 'entries');
  assert.equal(registry.isTrustedSnapshot('demo', {
    schemaVersion: 2, capturedAt: Date.now(), kind: USAGE_SNAPSHOT_KINDS.cline, source: 'demo_api', entries: []
  }, { schemaVersion: 2 }), true);
  assert.equal(registry.isTrustedSnapshot('demo', {
    schemaVersion: 2, capturedAt: Date.now(), kind: USAGE_SNAPSHOT_KINDS.cline, source: 'other_api', entries: []
  }, { schemaVersion: 2 }), false);
  assert.equal(registry.trustRule('unknown-provider'), null);
});

test('插件目录加载：内置目录 + 外部目录，失败记进可观察的加载错误', (t) => {
  const root = tempDir(t, 'aih-quota-plugins-');
  const builtinDir = path.join(root, 'builtin');
  const externalDir = path.join(root, 'external');
  fs.mkdirSync(builtinDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(path.join(builtinDir, 'good.js'), `module.exports = {
  id: 'good-plugin', contractVersion: 1, providers: ['good'], snapshotKind: 'cline_pass_usage',
  source: 'good_api', shape: 'entries', createProbe: () => ({ probe: async () => ({}) })
};`);
  fs.writeFileSync(path.join(builtinDir, 'broken.js'), 'module.exports = { id: "broken" };');
  fs.writeFileSync(path.join(externalDir, 'extra.cjs'), `module.exports = {
  id: 'extra-plugin', contractVersion: 1, providers: ['extra'], snapshotKind: 'cline_pass_usage',
  source: 'extra_api', shape: 'entries', createProbe: () => ({ probe: async () => ({}) })
};`);

  const registry = createQuotaProviderRegistry({ nativeSources: buildNativeQuotaSources() });
  const result = loadQuotaPlugins({
    registry,
    builtinDir,
    aiHomeDir: root,
    fs,
    env: { AIH_QUOTA_PLUGIN_DIR: externalDir }
  });
  assert.deepEqual(result.loaded.map((item) => item.id).sort(), ['extra-plugin', 'good-plugin']);
  assert.equal(registry.has('good'), true);
  assert.equal(registry.has('extra'), true);
  const errors = registry.listLoadErrors();
  assert.equal(errors.length, 1);
  assert.match(errors[0].code, /quota_plugin_/);
  assert.match(errors[0].target, /broken\.js$/);
});

test('外部插件目录解析：环境变量优先于 AIH_HOME/quota-plugins', () => {
  assert.deepEqual(
    resolveExternalPluginDirs({ env: { AIH_QUOTA_PLUGIN_DIR: '/a:/b' }, aiHomeDir: '/home' }),
    ['/a', '/b', '/home/quota-plugins']
  );
  assert.deepEqual(resolveExternalPluginDirs({ env: {}, aiHomeDir: '/home' }), ['/home/quota-plugins']);
});

test('内置插件目录已随内核加载 Cline Pass，且没有加载错误', () => {
  const providers = listQuotaProviders();
  assert.equal(providers.includes('cline'), true);
  const cline = describeQuotaProvider('cline');
  assert.equal(cline.origin, 'plugin');
  assert.equal(cline.pluginId, 'cline-pass');
  assert.equal(cline.source, 'cline_plan_usages_api');
  assert.equal(resolveQuotaTrustRule('cline').kind, USAGE_SNAPSHOT_KINDS.cline);
});

test('条目语义（entryShape）由额度源声明：展示层据此取时间窗 kind', () => {
  const {
    listQuotaSnapshotKinds,
    getQuotaRegistry
  } = require('../lib/usage/quota');
  const windowKinds = listQuotaSnapshotKinds('window');
  assert.equal(windowKinds.includes('cline_pass_usage'), true);
  assert.equal(windowKinds.includes('codex_oauth_status'), true);
  assert.equal(windowKinds.includes('claude_oauth_usage'), true);
  assert.equal(windowKinds.includes('kimi_oauth_usage'), true);
  // 余额桶与模型型不是时间窗，展示层不能按「5h: 91%」渲染。
  assert.equal(windowKinds.includes('codebuddy_credit_balance'), false);
  assert.equal(windowKinds.includes('zcode_plan_balance'), false);
  assert.equal(windowKinds.includes('agy_code_assist_quota'), false);
  assert.deepEqual(
    listQuotaSnapshotKinds('bucket').sort(),
    ['codebuddy_credit_balance', 'grok_credit_usage', 'kiro_credit_usage', 'zcode_plan_balance']
  );
  assert.equal(getQuotaRegistry().get('cline').entryShape, 'window');
  const registry = createQuotaProviderRegistry({ nativeSources: buildNativeQuotaSources() });
  assert.throws(
    () => registry.registerPlugin(makePlugin({ entryShape: 'nonsense' })),
    /quota_plugin_entry_shape_invalid/
  );
});

test('createQuotaRegistry 只给插件型 provider 造探针，原生 provider 返回 null', () => {
  const { registry } = createQuotaRegistry({ aiHomeDir: '/nonexistent-aih-home' });
  const probe = registry.createProbe('cline', {});
  assert.equal(typeof probe.probe, 'function');
  assert.equal(registry.createProbe('kimi', {}), null);
});
