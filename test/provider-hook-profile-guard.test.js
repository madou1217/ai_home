'use strict';

// Hook 档案守卫：adapter 的唯一真值源已收敛到 Go 合同（sessionSync.adapter）。
//
// 这组测试同时锁住三件事：
//   1. 六个 hook provider 的 profile 字段与预期表一致（adapter 来自 Go，其余档案来自描述符）；
//   2. 描述符里的 hooks.adapter 即使被删除/清空，profile 仍完整（adapter 退役第二步）；
//   3. Go 合同缺 adapter 时兼容回退到描述符值；两边冲突时 Go 优先（单一来源）。

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const { listProviderDefinitions, getProviderDefinition } = require('../lib/provider-catalog');
const { getProviderCapability } = require('../lib/providers');
const hookConfig = require('../lib/server/provider-session-hook-config');

const CONFIG_PATH = require.resolve('../lib/server/provider-session-hook-config');
const CATALOG_PATH = require.resolve('../lib/provider-catalog');
const PROVIDERS_PATH = require.resolve('../lib/providers');

const EXPECTED_PROFILES = Object.freeze({
  codex: {
    adapter: 'json_hooks',
    targetKind: 'hooks.json',
    target: ['.codex', 'hooks.json'],
    timeoutUnit: 'seconds',
    eventMatchers: { SessionStart: 'startup|resume|clear|compact' },
    featureFlag: true
  },
  gemini: {
    adapter: 'json_hooks',
    targetKind: 'settings.json',
    target: ['.gemini', 'settings.json'],
    timeoutUnit: 'ms',
    eventMatchers: {},
    featureFlag: false
  },
  claude: {
    adapter: 'json_hooks',
    targetKind: 'settings.json',
    target: ['.claude', 'settings.json'],
    timeoutUnit: 'seconds',
    eventMatchers: {},
    featureFlag: false
  },
  agy: {
    adapter: 'agy_named_hooks',
    targetKind: 'hooks.json',
    target: ['.gemini', 'config', 'hooks.json'],
    timeoutUnit: 'seconds',
    eventMatchers: {},
    featureFlag: false
  },
  opencode: {
    adapter: 'opencode_plugin',
    targetKind: 'plugin.js',
    target: [],
    timeoutUnit: 'seconds',
    eventMatchers: {},
    featureFlag: false
  },
  grok: {
    adapter: 'json_hooks',
    targetKind: 'hooks.json',
    target: ['.grok', 'hooks', 'aih-session-sync.json'],
    timeoutUnit: 'seconds',
    eventMatchers: {},
    featureFlag: false
  }
});

const HOOK_PROVIDER_IDS = Object.freeze(Object.keys(EXPECTED_PROFILES));

function hookDefinitions(adapterOverrides = {}) {
  return listProviderDefinitions().map((definition) => {
    if (!Object.prototype.hasOwnProperty.call(adapterOverrides, definition.id)) return definition;
    return {
      ...definition,
      sessionSync: {
        ...definition.sessionSync,
        adapter: adapterOverrides[definition.id]
      }
    };
  });
}

function hookCapabilities(overrides = {}) {
  const result = {};
  for (const id of HOOK_PROVIDER_IDS) {
    result[id] = Object.prototype.hasOwnProperty.call(overrides, id)
      ? overrides[id]
      : getProviderCapability(id, 'hooks');
  }
  return result;
}

function capabilityWithoutAdapter(id) {
  const { adapter, ...rest } = getProviderCapability(id, 'hooks');
  return rest;
}

// 重新加载装配模块，并在它 require 依赖的那一刻注入替身：
//   * 合同定义（provider-catalog.listProviderDefinitions）
//   * 描述符能力（providers.getProviderCapability）
// 只拦截装配模块自己发起的 require，其它模块不受影响；加载完立刻还原并清缓存，
// 避免把替身泄漏给同进程的其它测试。
function loadHookConfigWith({ definitions, capabilities }) {
  const realCatalog = require(CATALOG_PATH);
  const realProviders = require(PROVIDERS_PATH);
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename === CONFIG_PATH) {
      if (request === '../provider-catalog') {
        return {
          ...realCatalog,
          listProviderDefinitions: typeof definitions === 'function'
            ? definitions
            : (definitions ? () => definitions : realCatalog.listProviderDefinitions)
        };
      }
      if (request === '../providers') {
        return {
          ...realProviders,
          getProviderCapability(id, capability) {
            if (capability === 'hooks'
              && capabilities
              && Object.prototype.hasOwnProperty.call(capabilities, id)) {
              return capabilities[id];
            }
            return realProviders.getProviderCapability(id, capability);
          }
        };
      }
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    delete require.cache[CONFIG_PATH];
    return require(CONFIG_PATH);
  } finally {
    Module._load = originalLoad;
    delete require.cache[CONFIG_PATH];
  }
}

// ---------------------------------------------------------------------------
// 1. 正常数据下的 profile 守卫
// ---------------------------------------------------------------------------

test('profile 守卫：六个 hook provider 的 adapter 来自 Go 合同，格式档案来自描述符', () => {
  for (const id of HOOK_PROVIDER_IDS) {
    const expected = EXPECTED_PROFILES[id];
    const definition = getProviderDefinition(id);
    const capability = getProviderCapability(id, 'hooks');
    const profile = hookConfig.resolveProviderHookProfile(id);

    // Go 合同是真值源：adapter 与 targetKind 必须逐字一致。
    assert.equal(definition.sessionSync.mode, 'hook', id);
    assert.equal(definition.sessionSync.adapter, expected.adapter, `${id} 合同 adapter`);
    assert.equal(definition.sessionSync.targetKind, expected.targetKind, `${id} 合同 targetKind`);

    assert.equal(profile.supported, true, id);
    assert.equal(profile.adapterId, definition.sessionSync.adapter, `${id} profile.adapterId 应来自 Go 合同`);
    assert.equal(profile.adapterId, expected.adapter, id);
    assert.equal(profile.targetKind, expected.targetKind, id);
    assert.equal(profile.capabilityMatches, true, `${id} 描述符档案应可消费`);

    // 描述符仍负责格式档案：这些字段与预期表、描述符三方一致。
    assert.deepEqual(profile.target, expected.target, `${id} target`);
    assert.equal(profile.timeoutUnit, expected.timeoutUnit, `${id} timeoutUnit`);
    assert.deepEqual(profile.eventMatchers, expected.eventMatchers, `${id} eventMatchers`);
    assert.equal(profile.featureFlag, expected.featureFlag, `${id} featureFlag`);
    assert.equal(capability.supported, true, id);
    assert.deepEqual(profile.target, capability.target, id);
    assert.equal(profile.timeoutUnit, capability.timeoutUnit, id);
    assert.deepEqual(profile.eventMatchers, capability.eventMatchers, id);
    assert.equal(profile.featureFlag, capability.featureFlag, id);

    assert.ok(Object.isFrozen(profile), `${id} profile 应冻结`);
  }
});

test('profile 守卫：非 hook provider 保持 fail-closed', () => {
  for (const definition of listProviderDefinitions()) {
    if (definition.sessionSync.mode === 'hook') continue;
    const profile = hookConfig.resolveProviderHookProfile(definition.id);
    assert.equal(profile.supported, false, definition.id);
    assert.equal(profile.adapterId, '', definition.id);
    assert.deepEqual(profile.target, [], definition.id);
    assert.equal(profile.capabilityMatches, false, definition.id);
  }
});

// ---------------------------------------------------------------------------
// 2. adapter 退役后的行为：描述符 adapter 缺失不影响 profile
// ---------------------------------------------------------------------------

test('描述符 hooks.adapter 缺失/清空时 profile 仍完整（退役第二步的核心守卫）', () => {
  const capabilities = {};
  for (const id of HOOK_PROVIDER_IDS) capabilities[id] = capabilityWithoutAdapter(id);

  const config = loadHookConfigWith({
    definitions: hookDefinitions(),
    capabilities
  });

  for (const id of HOOK_PROVIDER_IDS) {
    const expected = EXPECTED_PROFILES[id];
    const profile = config.resolveProviderHookProfile(id);
    assert.equal(profile.supported, true, id);
    assert.equal(profile.adapterId, getProviderDefinition(id).sessionSync.adapter, id);
    assert.equal(profile.adapterId, expected.adapter, id);
    assert.equal(profile.capabilityMatches, true, `${id} 不应再要求描述符 adapter 相等`);
    assert.deepEqual(profile.target, expected.target, id);
    assert.equal(profile.timeoutUnit, expected.timeoutUnit, id);
    assert.deepEqual(profile.eventMatchers, expected.eventMatchers, id);
    assert.equal(profile.featureFlag, expected.featureFlag, id);
    assert.ok(config.getHookAdapter(profile.adapterId), `${id} 的 Go adapter 必须可派发`);
  }

  // 档案完整性的最终用途是装配：描述符没有 adapter 时仍应能生成/诊断托管配置。
  const homeDir = '/tmp/aih-hook-adapter-retired';
  const patch = config.buildProviderSessionHookConfigPatch('codex', {}, { homeDir, events: ['Stop'] });
  assert.equal(patch.ok, true);
  assert.equal(patch.targetPath, path.join(homeDir, '.codex', 'hooks.json'));
  assert.equal(patch.changed, true);
  assert.equal(patch.config.hooks.Stop.length, 1);

  const diagnosed = config.diagnoseProviderSessionHookConfig('codex', patch.config, { homeDir, events: ['Stop'] });
  assert.equal(diagnosed.supported, true);
  assert.equal(diagnosed.installed, true);
});

// ---------------------------------------------------------------------------
// 3. Go 缺失时的兼容回退 + Go 优先的单一来源
// ---------------------------------------------------------------------------

test('Go sessionSync.adapter 缺失时回退描述符 adapter，行为保持不变', () => {
  const config = loadHookConfigWith({
    definitions: hookDefinitions({ codex: '' }),
    capabilities: hookCapabilities()
  });

  const profile = config.resolveProviderHookProfile('codex');
  assert.equal(profile.supported, true);
  assert.equal(profile.adapterId, 'json_hooks', '合同缺失时应回退描述符值');
  assert.equal(profile.capabilityMatches, true);
  assert.deepEqual(profile.target, ['.codex', 'hooks.json']);
  assert.equal(profile.timeoutUnit, 'seconds');
  assert.deepEqual(profile.eventMatchers, { SessionStart: 'startup|resume|clear|compact' });
  assert.equal(profile.featureFlag, true);
  assert.ok(config.getHookAdapter(profile.adapterId));
});

test('Go 与描述符都缺 adapter 时仍然 fail-closed', () => {
  const config = loadHookConfigWith({
    definitions: hookDefinitions({ codex: '' }),
    capabilities: { codex: capabilityWithoutAdapter('codex') }
  });

  const profile = config.resolveProviderHookProfile('codex');
  assert.equal(profile.supported, false);
  assert.equal(profile.adapterId, '');
  assert.equal(profile.capabilityMatches, false);
  assert.deepEqual(profile.target, []);
  assert.equal(profile.timeoutUnit, 'seconds');
  assert.deepEqual(profile.eventMatchers, {});
  assert.equal(profile.featureFlag, false);
});

test('Go adapter 与描述符 adapter 冲突时以 Go 为准，描述符不再当一致性地雷', () => {
  const decoy = {
    ...getProviderCapability('codex', 'hooks'),
    adapter: 'decoy_hooks'
  };
  const config = loadHookConfigWith({
    definitions: hookDefinitions(),
    capabilities: { codex: decoy }
  });

  const profile = config.resolveProviderHookProfile('codex');
  assert.equal(profile.adapterId, 'json_hooks', '必须使用 Go 合同 adapter，而不是描述符的 decoy');
  assert.equal(profile.supported, true);
  assert.equal(profile.capabilityMatches, true, 'adapter 已不再参与一致性比对');
  assert.deepEqual(profile.target, ['.codex', 'hooks.json'], '描述符仍提供格式档案');
  assert.equal(profile.featureFlag, true);
});

// ---------------------------------------------------------------------------
// 4. 其它 fail-closed 分支
// ---------------------------------------------------------------------------

test('合同不是 hook 模式时，描述符即使声明 hooks 也不接管', () => {
  const syntheticCapability = {
    supported: true,
    adapter: 'json_hooks',
    target: ['.qoder', 'hooks.json'],
    timeoutUnit: 'seconds',
    eventMatchers: {},
    featureFlag: false
  };
  const config = loadHookConfigWith({
    definitions: hookDefinitions(),
    capabilities: { qoder: syntheticCapability }
  });

  const profile = config.resolveProviderHookProfile('qoder');
  assert.equal(profile.supported, false, '合同 mode=polling，不能被描述符 hooks 翻开');
  assert.equal(profile.adapterId, '');
  assert.equal(profile.capabilityMatches, false);
  assert.deepEqual(profile.target, []);
});

test('描述符 supported=false 时不消费档案，即使 Go 合同声明了 adapter', () => {
  const disabledCapability = {
    ...getProviderCapability('codex', 'hooks'),
    supported: false,
    reason: 'test-only disabled capability'
  };
  const config = loadHookConfigWith({
    definitions: hookDefinitions(),
    capabilities: { codex: disabledCapability }
  });

  const profile = config.resolveProviderHookProfile('codex');
  assert.equal(profile.supported, true, '是否支持 hook 仍由 Go 合同决定');
  assert.equal(profile.adapterId, 'json_hooks');
  assert.equal(profile.capabilityMatches, false, '描述符声明不可用时不能消费其档案');
  assert.deepEqual(profile.target, []);
  assert.equal(profile.timeoutUnit, 'seconds');
  assert.deepEqual(profile.eventMatchers, {});
  assert.equal(profile.featureFlag, false);
});
