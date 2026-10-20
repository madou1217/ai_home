'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createProviderRegistry } = require('../lib/providers/registry');
const {
  registerProviderHandler,
  resetProviderHandlers,
  listMissingProviderHandlers
} = require('../lib/providers/handler-registry');
const {
  PluginProviderRegistry,
  validateProviderDefinition
} = require('../lib/plugins/provider/registry');
const {
  BUILTIN_PROVIDER_CONTRIBUTION_ID,
  assertProviderDescriptorSerializable,
  collectBuiltinProviderDescriptors,
  createBuiltinProviderDescriptorContribution,
  createProviderDescriptorCollector
} = require('../lib/plugins/provider/descriptor-collector');
const { createPluginRuntimeService, buildSnapshot } = require('../lib/plugins/control/runtime-service');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'examples', 'plugins', 'provider-descriptor');

function pluginDescriptor(id, handler = 'sample-models') {
  return {
    contractVersion: 1,
    id,
    capabilities: {
      quota: { supported: false, reason: 'sample provider has no quota api' },
      models: {
        supported: true,
        strategies: [{
          id: `${id}-models`,
          transport: 'local',
          clientDependent: false,
          handler
        }]
      }
    }
  };
}

test('plugin provider registry uses the canonical descriptor contract', () => {
  const registry = createProviderRegistry();
  const plugins = new PluginProviderRegistry({ registry });
  const descriptor = plugins.register(pluginDescriptor('demo-plugin'), 'owner-a');
  assert.equal(descriptor.id, 'demo-plugin');
  assert.deepEqual(plugins.list().map((item) => item.id), ['demo-plugin']);
  assert.deepEqual(registry.listByOrigin('plugin'), ['demo-plugin']);
  assert.deepEqual(registry.listProviders('models'), ['demo-plugin']);

  // canonical 规则：quota 必须显式回答（不能静默缺失）。
  assert.throws(
    () => plugins.register({ contractVersion: 1, id: 'missing-quota', capabilities: {} }, 'owner-a'),
    /provider_descriptor_quota_missing/
  );

  assert.equal(plugins.unregister('demo-plugin', 'owner-b'), false);
  assert.equal(plugins.unregister('demo-plugin', 'owner-a'), true);
  assert.deepEqual(plugins.list(), []);
  assert.deepEqual(registry.listByOrigin('plugin'), []);
});

test('descriptor collector accepts JSON data and resolves handler ids in the host registry', async (t) => {
  resetProviderHandlers();
  t.after(resetProviderHandlers);
  registerProviderHandler('sample-models', async () => ({ models: [] }), { kind: 'models' });
  const collector = createProviderDescriptorCollector({ origin: 'plugin' });
  const result = await collector.collect([{
    id: 'sample.provider.descriptor',
    instanceId: 'sample',
    value: { descriptors: [pluginDescriptor('demo-plugin')] }
  }]);

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.descriptors.map((item) => item.id), ['demo-plugin']);
  assert.deepEqual(result.attempts.map((item) => item.ok), [true]);
});

test('descriptor collector rejects functions (plugin RPC only carries data)', async () => {
  const collector = createProviderDescriptorCollector({ origin: 'plugin' });
  const withFunction = pluginDescriptor('function-plugin');
  withFunction.capabilities.models.strategies[0].discover = () => ({ models: [] });
  const result = await collector.collect([{ id: 'bad', instanceId: 'bad', value: withFunction }]);
  assert.equal(result.descriptors.length, 0);
  assert.equal(result.errors[0].code, 'provider_descriptor_not_serializable');
  assert.throws(() => assertProviderDescriptorSerializable(withFunction), /not_serializable/);
});

test('descriptor collector rejects unresolved handlers but keeps other descriptors in the batch', async (t) => {
  resetProviderHandlers();
  t.after(resetProviderHandlers);
  registerProviderHandler('sample-models', async () => ({ models: [] }));
  const collector = createProviderDescriptorCollector({ origin: 'plugin' });
  const result = await collector.collect([
    { id: 'ok', instanceId: 'ok', value: pluginDescriptor('ok-plugin') },
    { id: 'bad', instanceId: 'bad', value: pluginDescriptor('bad-plugin', 'missing-handler') }
  ]);
  assert.deepEqual(result.descriptors.map((item) => item.id), ['ok-plugin']);
  assert.equal(result.errors.some((error) => error.code === 'provider_descriptor_handler_unavailable'), true);
  assert.match(listMissingProviderHandlers(pluginDescriptor('x', 'missing-handler')).join(','), /missing-handler/);
});

test('descriptor collector records duplicate provider ids instead of overwriting', async (t) => {
  resetProviderHandlers();
  t.after(resetProviderHandlers);
  registerProviderHandler('sample-models', async () => ({ models: [] }));
  const collector = createProviderDescriptorCollector({ origin: 'plugin' });
  const result = await collector.collect([
    { id: 'a', instanceId: 'a', value: pluginDescriptor('same') },
    { id: 'b', instanceId: 'b', value: pluginDescriptor('same') }
  ]);
  assert.equal(result.descriptors.length, 1);
  assert.equal(result.errors.some((error) => error.code === 'provider_descriptor_duplicate'), true);
});

test('built-in defs are exposed as canonical provider.descriptor contributions and stay in sync with the Go manifest', () => {
  const builtin = collectBuiltinProviderDescriptors();
  assert.deepEqual(builtin.errors, []);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/providers/manifest.json'), 'utf8'));
  const manifestIds = manifest.providers.map((provider) => provider.id).sort();
  assert.deepEqual(builtin.descriptors.map((item) => item.id).sort(), manifestIds);

  const contribution = createBuiltinProviderDescriptorContribution();
  assert.equal(contribution.id, BUILTIN_PROVIDER_CONTRIBUTION_ID);
  assert.equal(contribution.capability, 'provider.descriptor');
  assert.equal(contribution.descriptors.length, manifestIds.length);

  // 外部 provider 尚未进入 Go manifest：这是显式边界，不是遗漏。
  const sample = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'descriptor.json'), 'utf8'));
  assert.equal(manifestIds.includes(sample.id), false);
});

test('the external provider descriptor sample is canonical and references a host handler', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'plugin.json'), 'utf8'));
  const contribution = manifest.contributes.find((item) => item.capability === 'provider.descriptor');
  assert.ok(contribution);
  assert.equal(contribution.failurePolicy, 'delegate');

  const descriptor = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'descriptor.json'), 'utf8'));
  const validated = validateProviderDefinition(descriptor);
  assert.equal(validated.id, 'sample-provider');
  assert.equal(validated.capabilities.models.strategies[0].handler, 'generic-models-probe');
  assert.equal(validated.capabilities.models.strategies[0].discover, null);
});

test('provider descriptor origins replace as a generation without touching built-ins', () => {
  const registry = createProviderRegistry({ descriptors: [{
    contractVersion: 1,
    id: 'builtin-provider',
    capabilities: { quota: { supported: false, reason: 'builtin' } }
  }] });
  const first = registry.replaceOrigin('plugin', [pluginDescriptor('plugin-one')]);
  assert.deepEqual(first.registered.map((item) => item.id), ['plugin-one']);
  assert.deepEqual(registry.listIds(), ['builtin-provider', 'plugin-one']);

  const second = registry.replaceOrigin('plugin', [pluginDescriptor('plugin-two')]);
  assert.deepEqual(second.registered.map((item) => item.id), ['plugin-two']);
  assert.deepEqual(registry.listIds(), ['builtin-provider', 'plugin-two']);
  assert.equal(registry.has('plugin-one'), false);

  // 插件不能覆盖内置：冲突被记录，内置描述符保持不变。
  const conflict = registry.replaceOrigin('plugin', [{
    contractVersion: 1,
    id: 'builtin-provider',
    capabilities: { quota: { supported: false, reason: 'plugin wants to override' } }
  }]);
  assert.equal(conflict.registered.length, 0);
  assert.equal(conflict.errors[0].code, 'provider_descriptor_conflict');
  assert.equal(registry.getCapability('builtin-provider', 'quota').reason, 'builtin');
});

test('plugin runtime publishes provider descriptors with the generation and clears them when idle', async () => {
  const published = [];
  const supervisor = {
    async start() {},
    async stop() {},
    async call(method, payload) {
      if (method === 'prepare') {
        return { value: { state: 'prepared', contributions: payload.plugins.flatMap((item) => item.manifest.contributes || []) } };
      }
      if (method === 'activate') return { value: { state: 'active' } };
      if (method === 'dispose') return { value: { state: 'disposed' } };
      if (method === 'invoke') return { value: { descriptors: [pluginDescriptor('runtime-plugin')] } };
      throw new Error(`unexpected ${method}`);
    },
    status() { return { running: true, pid: 1 }; },
    access() { return null; }
  };
  const runtime = createPluginRuntimeService({
    aiHomeDir: '/tmp/aih-runtime-descriptor-test',
    supervisorFactory: () => supervisor,
    collectProviderDescriptors: async ({ snapshot }) => {
      assert.equal(snapshot.byCapability.get('provider.descriptor').length, 1);
      return { descriptors: [pluginDescriptor('runtime-plugin')], errors: [] };
    },
    onProviderDescriptors: (payload, meta) => published.push({ payload, meta })
  });
  const plugin = {
    instanceId: 'plugin-a',
    manifest: {
      contributes: [{ id: 'plugin-a.descriptor', capability: 'provider.descriptor', version: 1, failurePolicy: 'delegate' }]
    },
    entryPath: '/tmp/plugin-a/index.mjs'
  };

  const active = await runtime.publish([plugin], null);
  assert.equal(active.state, 'active');
  assert.equal(published.at(-1).payload.descriptors[0].id, 'runtime-plugin');
  assert.equal(published.at(-1).meta.generation, active.generation);

  await runtime.publish([], null);
  assert.deepEqual(published.at(-1).payload.descriptors, []);
  const snapshot = buildSnapshot(1, [plugin], { providerDescriptors: [pluginDescriptor('x')] });
  assert.deepEqual(snapshot.providerDescriptors.map((item) => item.id), ['x']);
});
