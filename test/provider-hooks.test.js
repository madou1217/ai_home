'use strict';

// Provider hooks 声明 + 装配逻辑的单元测试。
//
// 两层真值源：
//   1. lib/providers/defs/<id>.js 的 capabilities.hooks —— 「这种 hook 长什么样」；
//   2. Go 生成的 contracts/providers/manifest.json 的 sessionSync —— 「这个 provider 支不支持 hook」。
// 装配层 lib/server/provider-session-hook-config.js 只做合并 + 按 adapter 派发，本测试同时锁住
// 两层的字段与合并结果，避免新增 provider 时只改一边、或装配层偷偷按 provider 名分支。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProvidersRegistry } = require('../lib/providers');
const { listProviderDefinitions, getProviderDefinition } = require('../lib/provider-catalog');
const { validateProviderDescriptor } = require('../lib/providers/contract');
const hookConfig = require('../lib/server/provider-session-hook-config');
const {
  buildProviderHookReceiverUrl,
  buildProviderSessionHookConfigPatch,
  buildProviderSessionHookSenderCommand,
  diagnoseProviderSessionHookConfig,
  getProviderHookConfigTarget,
  getProviderSessionSyncMode,
  installProviderSessionHookConfig,
  isManagedCommand,
  isProviderSessionHookSupported,
  listInstallableProviderIds,
  resolveProviderHookProfile,
  uninstallProviderSessionHookConfig
} = hookConfig;

const BUILTIN_DEFS_DIR = path.join(__dirname, '..', 'lib', 'providers', 'defs');
const EMPTY_AI_HOME_DIR = path.join(os.tmpdir(), 'aih-provider-hooks-test-no-home');

// 每个 provider 的 hooks 声明**逐字段**写死。新增 hook provider 必须同时更新这里，
// 这是一份有意的回归守卫，而不是从描述符自身推导出来的镜像断言。
const EXPECTED_HOOK_DECLARATIONS = Object.freeze({
  codex: {
    adapter: 'json_hooks',
    target: ['.codex', 'hooks.json'],
    timeoutUnit: 'seconds',
    eventMatchers: { SessionStart: 'startup|resume|clear|compact' },
    featureFlag: true
  },
  gemini: {
    adapter: 'json_hooks',
    target: ['.gemini', 'settings.json'],
    // gemini 是唯一以毫秒声明 hook timeout 的 provider。
    timeoutUnit: 'ms',
    eventMatchers: {},
    featureFlag: false
  },
  claude: {
    adapter: 'json_hooks',
    target: ['.claude', 'settings.json'],
    timeoutUnit: 'seconds',
    eventMatchers: {},
    featureFlag: false
  },
  agy: {
    adapter: 'agy_named_hooks',
    target: ['.gemini', 'config', 'hooks.json'],
    timeoutUnit: 'seconds',
    eventMatchers: {},
    featureFlag: false
  },
  opencode: {
    adapter: 'opencode_plugin',
    // 插件桥没有 JSON 事件清单，目标路径由适配器解析。
    target: [],
    timeoutUnit: 'seconds',
    eventMatchers: {},
    featureFlag: false
  },
  grok: {
    adapter: 'json_hooks',
    target: ['.grok', 'hooks', 'aih-session-sync.json'],
    timeoutUnit: 'seconds',
    eventMatchers: {},
    featureFlag: false
  }
});

const HOOK_PROVIDER_IDS = Object.freeze(Object.keys(EXPECTED_HOOK_DECLARATIONS));
const JSON_HOOK_PROVIDER_IDS = Object.freeze(['codex', 'gemini', 'claude', 'grok']);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function listBuiltinDefinitionFiles() {
  return fs.readdirSync(BUILTIN_DEFS_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort();
}

// 独立注册表：不读 process.env 的扩展目录，也不读真实 HOME 下的 provider-defs，
// 保证断言只针对仓库内置描述符。
function loadBuiltinRegistry() {
  const { registry, errors } = createProvidersRegistry({
    env: {},
    aiHomeDir: EMPTY_AI_HOME_DIR,
    skipLegacy: true
  });
  return { registry, errors };
}

function makeHooksDescriptor(hooks, id = 'hookdummy') {
  return {
    contractVersion: 1,
    id,
    capabilities: {
      quota: { supported: false, reason: 'test-only provider' },
      hooks
    }
  };
}

// 只覆盖 provider-session-hook-config 需要的 fs 形状（exists/read/write/mkdir/unlink）。
function createMemoryFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const dirs = new Set();
  return {
    files,
    existsSync(filePath) {
      return files.has(filePath) || dirs.has(filePath);
    },
    readFileSync(filePath) {
      if (!files.has(filePath)) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
    writeFileSync(filePath, content) {
      files.set(filePath, String(content));
    },
    ensureDirSync(dir) {
      dirs.add(dir);
    },
    mkdirSync(dir) {
      dirs.add(dir);
    },
    unlinkSync(filePath) {
      if (!files.has(filePath)) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      files.delete(filePath);
    }
  };
}

// opencode 的目标路径跟随 OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME；测试期间临时改写并还原。
function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function countManagedHandlers(groups, provider) {
  let count = 0;
  for (const group of groups || []) {
    for (const handler of (group && group.hooks) || []) {
      if (isManagedCommand(handler && handler.command, provider)) count += 1;
    }
  }
  return count;
}

function managedHandlersOf(groups, provider) {
  const found = [];
  for (const group of groups || []) {
    for (const handler of (group && group.hooks) || []) {
      if (isManagedCommand(handler && handler.command, provider)) found.push(handler);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. 描述符声明：capabilities.hooks 的字段形状与每个 provider 的具体取值
// ---------------------------------------------------------------------------

test('内置描述符全部通过契约校验，且 hooks 声明与预期逐字段一致', () => {
  const { registry, errors } = loadBuiltinRegistry();
  assert.deepEqual(errors, [], '内置描述符不应有加载错误');

  for (const fileName of listBuiltinDefinitionFiles()) {
    const raw = require(path.join(BUILTIN_DEFS_DIR, fileName));
    const normalized = validateProviderDescriptor(raw);
    assert.equal(normalized.id, raw.id, fileName);

    const expected = EXPECTED_HOOK_DECLARATIONS[raw.id];
    if (!expected) {
      assert.equal(
        registry.getCapability(raw.id, 'hooks'),
        null,
        `${raw.id} 没有预期 hooks 声明，描述符里却出现了 capabilities.hooks`
      );
      continue;
    }

    const hooks = registry.getCapability(raw.id, 'hooks');
    assert.ok(hooks, `${raw.id} 缺少 capabilities.hooks`);
    assert.equal(hooks.supported, true);
    assert.equal(hooks.adapter, expected.adapter, `${raw.id} adapter`);
    assert.deepEqual(hooks.target, expected.target, `${raw.id} target`);
    assert.equal(hooks.timeoutUnit, expected.timeoutUnit, `${raw.id} timeoutUnit`);
    assert.deepEqual(hooks.eventMatchers, expected.eventMatchers, `${raw.id} eventMatchers`);
    assert.equal(hooks.featureFlag, expected.featureFlag, `${raw.id} featureFlag`);
    assert.ok(Object.isFrozen(hooks), `${raw.id} hooks 应被契约冻结`);
    assert.ok(Object.isFrozen(hooks.target), `${raw.id} hooks.target 应被契约冻结`);
    assert.ok(Object.isFrozen(hooks.eventMatchers), `${raw.id} hooks.eventMatchers 应被契约冻结`);
  }

  const declaredHookIds = listBuiltinDefinitionFiles()
    .map((fileName) => require(path.join(BUILTIN_DEFS_DIR, fileName)).id)
    .filter((id) => Boolean(registry.getCapability(id, 'hooks')))
    .sort();
  assert.deepEqual(declaredHookIds, HOOK_PROVIDER_IDS.slice().sort());
});

test('合同 sessionSync 与描述符 hooks 对每个 provider 一致', () => {
  const { registry } = loadBuiltinRegistry();
  const definitions = listProviderDefinitions();
  const hookModeIds = [];

  for (const definition of definitions) {
    const capability = registry.getCapability(definition.id, 'hooks');
    const sync = definition.sessionSync || {};
    if (sync.mode === 'hook') {
      hookModeIds.push(definition.id);
      assert.ok(capability, `${definition.id} 合同声明了 hook，但描述符没有 hooks 能力`);
      assert.equal(capability.supported, true);
      assert.equal(capability.adapter, sync.adapter, `${definition.id} 的 adapter 与合同不一致`);
    } else {
      assert.equal(
        capability,
        null,
        `${definition.id} 合同不是 hook 模式（${sync.mode || 'missing'}），描述符不应声明 hooks`
      );
    }
  }

  assert.deepEqual(hookModeIds.sort(), HOOK_PROVIDER_IDS.slice().sort());
});

test('hook 目标路径段都是 home 内的相对片段，不允许绝对路径或 .. 逃逸', () => {
  const { registry } = loadBuiltinRegistry();
  for (const id of HOOK_PROVIDER_IDS) {
    const hooks = registry.getCapability(id, 'hooks');
    for (const segment of hooks.target) {
      assert.equal(typeof segment, 'string', `${id} target 段必须是字符串`);
      assert.ok(segment.length > 0, `${id} target 段不能为空`);
      assert.ok(!path.isAbsolute(segment), `${id} target 段不能是绝对路径: ${segment}`);
      assert.ok(!segment.includes('/') && !segment.includes('\\'), `${id} target 段不能含路径分隔符: ${segment}`);
      assert.notEqual(segment, '..', `${id} target 段不能越出 home`);
      assert.notEqual(segment, '.', `${id} target 段不能是 .`);
    }
  }
});

test('timeoutUnit 只用 seconds/ms；只有 gemini 用 ms，只有 codex 打开 featureFlag', () => {
  const { registry } = loadBuiltinRegistry();
  for (const id of HOOK_PROVIDER_IDS) {
    const hooks = registry.getCapability(id, 'hooks');
    assert.ok(['seconds', 'ms'].includes(hooks.timeoutUnit), `${id} timeoutUnit 非法`);
  }
  const msProviders = HOOK_PROVIDER_IDS.filter((id) => registry.getCapability(id, 'hooks').timeoutUnit === 'ms');
  const featureFlagProviders = HOOK_PROVIDER_IDS.filter((id) => registry.getCapability(id, 'hooks').featureFlag === true);
  const matcherProviders = HOOK_PROVIDER_IDS.filter((id) => Object.keys(registry.getCapability(id, 'hooks').eventMatchers).length > 0);
  assert.deepEqual(msProviders, ['gemini']);
  assert.deepEqual(featureFlagProviders, ['codex']);
  assert.deepEqual(matcherProviders, ['codex']);
});

test('契约对 hooks 字段做归一化：默认秒、target 去空、matcher 去空、featureFlag 严格布尔', () => {
  const normalized = validateProviderDescriptor(makeHooksDescriptor({
    supported: true,
    adapter: ' json_hooks ',
    target: [' .demo ', '', '   ', '.demo', 'hooks.json'],
    eventMatchers: { SessionStart: ' startup|resume ', Empty: '   ', Nullish: null },
    featureFlag: 'true'
  })).capabilities.hooks;

  assert.equal(normalized.adapter, 'json_hooks');
  assert.deepEqual(normalized.target, ['.demo', '.demo', 'hooks.json']);
  assert.equal(normalized.timeoutUnit, 'seconds', '未声明 timeoutUnit 时默认 seconds');
  assert.deepEqual(normalized.eventMatchers, { SessionStart: 'startup|resume' });
  assert.equal(normalized.featureFlag, false, '只有真正的布尔 true 才打开特性开关');
});

test('契约拒绝未知 adapter / 未知 timeoutUnit / 缺少 reason 的 unsupported 声明', () => {
  assert.throws(
    () => validateProviderDescriptor(makeHooksDescriptor({ supported: true, adapter: 'no_such_adapter' })),
    (error) => error.code === 'provider_descriptor_hooks_adapter_unknown'
  );
  assert.throws(
    () => validateProviderDescriptor(makeHooksDescriptor({ supported: true, adapter: 'json_hooks', timeoutUnit: 'milliseconds' })),
    (error) => error.code === 'provider_descriptor_hooks_timeout_unit_unknown'
  );
  assert.throws(
    () => validateProviderDescriptor(makeHooksDescriptor({ supported: false })),
    (error) => error.code === 'provider_descriptor_hooks_reason_missing'
  );
  assert.throws(
    () => validateProviderDescriptor(makeHooksDescriptor({ adapter: 'json_hooks' })),
    (error) => error.code === 'provider_descriptor_hooks_supported_flag_invalid'
  );

  const unsupported = validateProviderDescriptor(makeHooksDescriptor({
    supported: false,
    reason: '  该 provider 没有官方 hook 机制  '
  })).capabilities.hooks;
  assert.deepEqual(unsupported, { supported: false, reason: '该 provider 没有官方 hook 机制' });
});

// ---------------------------------------------------------------------------
// 2. 装配：合同 + 描述符 → hook 档案
// ---------------------------------------------------------------------------

test('每个 hook provider 的档案字段来自描述符，adapter/targetKind 与合同一致', () => {
  for (const id of HOOK_PROVIDER_IDS) {
    const expected = EXPECTED_HOOK_DECLARATIONS[id];
    const definition = getProviderDefinition(id);
    const profile = resolveProviderHookProfile(id);

    assert.equal(profile.provider, id);
    assert.equal(profile.supported, true);
    assert.equal(profile.adapterId, expected.adapter);
    assert.equal(profile.targetKind, definition.sessionSync.targetKind);
    assert.deepEqual(profile.target, expected.target);
    assert.equal(profile.timeoutUnit, expected.timeoutUnit);
    assert.deepEqual(profile.eventMatchers, expected.eventMatchers);
    assert.equal(profile.featureFlag, expected.featureFlag);
    assert.equal(profile.capabilityMatches, true, `${id} 描述符与合同应匹配`);
    assert.ok(Object.isFrozen(profile), `${id} 档案应冻结`);
    assert.ok(Object.isFrozen(profile.target), `${id} 档案 target 应冻结`);
  }
});

test('非 hook provider 的档案 fail-closed：不支持、无 target、默认秒', () => {
  for (const definition of listProviderDefinitions()) {
    if (definition.sessionSync.mode === 'hook') continue;
    const profile = resolveProviderHookProfile(definition.id);
    assert.equal(profile.provider, definition.id);
    assert.equal(profile.supported, false);
    assert.equal(profile.adapterId, '');
    assert.equal(profile.targetKind, '');
    assert.deepEqual(profile.target, []);
    assert.equal(profile.timeoutUnit, 'seconds');
    assert.deepEqual(profile.eventMatchers, {});
    assert.equal(profile.featureFlag, false);
    assert.equal(profile.capabilityMatches, false);
  }
});

test('provider 名大小写/空白归一化，未知 provider 走安全默认值', () => {
  const profile = resolveProviderHookProfile('  CLAUDE  ');
  assert.equal(profile.provider, 'claude');
  assert.equal(profile.supported, true);

  for (const unknown of ['', '  ', null, undefined]) {
    const fallback = resolveProviderHookProfile(unknown);
    assert.equal(fallback.provider, '', String(unknown));
    assert.equal(fallback.supported, false);
    assert.deepEqual(fallback.target, []);
    assert.equal(fallback.capabilityMatches, false);
  }

  const unknownProfile = resolveProviderHookProfile(' Not-A-Provider ');
  assert.equal(unknownProfile.provider, 'not-a-provider');
  assert.equal(unknownProfile.supported, false);
  assert.deepEqual(unknownProfile.target, []);
  assert.equal(unknownProfile.capabilityMatches, false);
});

test('installable 列表 = 合同声明 hook 且有 adapter 的 provider，默认事件表同步合同', () => {
  const expectedIds = listProviderDefinitions()
    .filter((definition) => definition.sessionSync.mode === 'hook' && definition.sessionSync.adapter)
    .map((definition) => definition.id);
  assert.deepEqual(listInstallableProviderIds(), expectedIds);
  assert.deepEqual(expectedIds.slice().sort(), HOOK_PROVIDER_IDS.slice().sort());

  for (const id of JSON_HOOK_PROVIDER_IDS.concat('agy')) {
    assert.deepEqual(hookConfig.DEFAULT_EVENTS_BY_PROVIDER[id], getProviderDefinition(id).sessionSync.events, id);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(hookConfig.DEFAULT_EVENTS_BY_PROVIDER, 'opencode'), false);
  assert.deepEqual(
    Object.keys(hookConfig.DEFAULT_EVENTS_BY_PROVIDER).sort(),
    ['agy', 'claude', 'codex', 'gemini', 'grok']
  );
});

test('isProviderSessionHookSupported / getProviderSessionSyncMode 覆盖 hook、polling、unavailable', () => {
  for (const id of HOOK_PROVIDER_IDS) {
    assert.equal(isProviderSessionHookSupported(id), true, id);
    assert.equal(getProviderSessionSyncMode(id), 'hook', id);
  }
  for (const id of ['qoder', 'qodercn', 'kiro', 'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']) {
    assert.equal(isProviderSessionHookSupported(id), false, id);
    assert.equal(getProviderSessionSyncMode(id), 'polling', id);
  }
  for (const id of ['kimi', 'zcode', 'cline']) {
    assert.equal(isProviderSessionHookSupported(id), false, id);
    assert.equal(getProviderSessionSyncMode(id), 'unavailable', id);
  }
  assert.equal(getProviderSessionSyncMode('unknown'), 'unavailable');
  assert.equal(isProviderSessionHookSupported('unknown'), false);
});

test('hook 适配器表：三个已知 adapter 可解析，未知 id 返回 null', () => {
  const jsonHooks = hookConfig.getHookAdapter('json_hooks');
  const agyHooks = hookConfig.getHookAdapter('agy_named_hooks');
  const opencodePlugin = hookConfig.getHookAdapter('opencode_plugin');

  for (const adapter of [jsonHooks, agyHooks, opencodePlugin]) {
    assert.ok(adapter);
    assert.equal(typeof adapter.targetPath, 'function');
    assert.equal(typeof adapter.buildPatch, 'function');
    assert.equal(typeof adapter.diagnose, 'function');
  }
  assert.equal(jsonHooks.patchIsRaw, undefined);
  assert.equal(agyHooks.patchIsRaw, undefined);
  assert.equal(opencodePlugin.patchIsRaw, true);
  assert.equal(typeof opencodePlugin.install, 'function');
  assert.equal(typeof opencodePlugin.uninstall, 'function');
  assert.equal(hookConfig.getHookAdapter('no-such-adapter'), null);
  assert.equal(hookConfig.getHookAdapter(''), null);
  assert.equal(hookConfig.getHookAdapter(null), null);
  assert.equal(hookConfig.AGY_MANAGED_HOOK_NAME, 'aih-session-sync');
});

// ---------------------------------------------------------------------------
// 3. 目标路径解析
// ---------------------------------------------------------------------------

test('json/named hooks 的目标路径 = homeDir + 描述符 target 段', () => {
  const homeDir = path.join(os.tmpdir(), 'aih-hook-target-home');
  for (const id of HOOK_PROVIDER_IDS) {
    if (id === 'opencode') continue;
    assert.equal(
      getProviderHookConfigTarget(id, { homeDir }),
      path.join(homeDir, ...EXPECTED_HOOK_DECLARATIONS[id].target),
      id
    );
  }
  assert.equal(getProviderHookConfigTarget('claude'), path.join('~', '.claude', 'settings.json'));
  assert.equal(getProviderHookConfigTarget('qoder', { homeDir }), '');
  assert.equal(getProviderHookConfigTarget('unknown', { homeDir }), '');
});

test('opencode 插件路径跟随 OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME', () => {
  const marker = 'aih-session-hook';
  withEnv({ OPENCODE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined }, () => {
    assert.equal(
      getProviderHookConfigTarget('opencode', { homeDir: '/tmp/aih-home' }),
      path.join('/tmp/aih-home', '.config', 'opencode', 'plugin', `${marker}.js`)
    );
  });
  withEnv({ OPENCODE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: '/tmp/aih-xdg' }, () => {
    assert.equal(
      getProviderHookConfigTarget('opencode', { homeDir: '/tmp/aih-home' }),
      path.join('/tmp/aih-xdg', 'opencode', 'plugin', `${marker}.js`)
    );
  });
  withEnv({ OPENCODE_CONFIG_DIR: '/tmp/aih-opencode', XDG_CONFIG_HOME: '/tmp/aih-xdg' }, () => {
    assert.equal(
      getProviderHookConfigTarget('opencode', { homeDir: '/tmp/aih-home' }),
      path.join('/tmp/aih-opencode', 'plugin', `${marker}.js`)
    );
  });
});

// ---------------------------------------------------------------------------
// 4. JSON hooks 装配（codex / gemini / claude / grok）
// ---------------------------------------------------------------------------

test('json_hooks：每个 provider 都生成托管 handler，timeout 单位按描述符换算', () => {
  const homeDir = path.join(os.tmpdir(), 'aih-json-hooks-home');
  const expectedTimeout = { codex: 10, gemini: 10000, claude: 10, grok: 10 };

  for (const id of JSON_HOOK_PROVIDER_IDS) {
    const patch = buildProviderSessionHookConfigPatch(id, {}, { homeDir, events: ['SessionStart', 'Stop'] });
    assert.equal(patch.ok, true, id);
    assert.equal(patch.provider, id);
    assert.equal(patch.changed, true);
    assert.equal(patch.targetKind, getProviderDefinition(id).sessionSync.targetKind);
    assert.equal(patch.targetPath, path.join(homeDir, ...EXPECTED_HOOK_DECLARATIONS[id].target));
    assert.deepEqual(patch.events, ['SessionStart', 'Stop']);

    for (const eventName of ['SessionStart', 'Stop']) {
      const groups = patch.config.hooks[eventName];
      assert.equal(groups.length, 1, `${id}/${eventName} 只应有一组`);
      assert.equal(groups[0].hooks.length, 1);
      const handler = groups[0].hooks[0];
      assert.equal(handler.type, 'command');
      assert.equal(handler.timeout, expectedTimeout[id], `${id}/${eventName} timeout`);
      assert.ok(handler.command.includes(hookConfig.MANAGED_HOOK_MARKER), `${id} 命令缺 marker`);
      assert.ok(handler.command.includes(`--provider '${id}'`), `${id} 命令缺 provider`);
      assert.ok(handler.command.includes(`--event '${eventName}'`), `${id}/${eventName} 命令缺 event`);
      assert.ok(handler.command.includes(`provider=${id}&event=${eventName}`), `${id}/${eventName} 命令缺 URL 参数`);
    }

    const sessionStartGroup = patch.config.hooks.SessionStart[0];
    if (id === 'codex') {
      assert.equal(sessionStartGroup.matcher, 'startup|resume|clear|compact');
    } else {
      assert.equal(Object.prototype.hasOwnProperty.call(sessionStartGroup, 'matcher'), false, `${id} 不应有 matcher`);
    }
  }
});

test('json_hooks：未传 events 时使用合同默认事件；空数组/空白项按默认与去空处理', () => {
  const defaults = getProviderDefinition('claude').sessionSync.events;
  const implicit = buildProviderSessionHookConfigPatch('claude', {}, { homeDir: '/tmp/aih-hooks' });
  assert.deepEqual(implicit.events, defaults);
  assert.deepEqual(Object.keys(implicit.config.hooks), defaults);
  assert.equal(implicit.config.hooks.SessionStart.length, 1);

  const explicitEmpty = buildProviderSessionHookConfigPatch('claude', {}, { homeDir: '/tmp/aih-hooks', events: [] });
  assert.deepEqual(explicitEmpty.events, defaults);

  const normalized = buildProviderSessionHookConfigPatch('claude', {}, {
    homeDir: '/tmp/aih-hooks',
    events: ['  Stop  ', '', '   ', 'SessionEnd']
  });
  assert.deepEqual(normalized.events, ['Stop', 'SessionEnd']);
  assert.deepEqual(Object.keys(normalized.config.hooks), ['Stop', 'SessionEnd']);
});

test('json_hooks：timeout 选项按单位生效，timeoutMs 优先且毫秒下限 100ms', () => {
  const seconds = buildProviderSessionHookConfigPatch('claude', {}, {
    homeDir: '/tmp/aih-hooks',
    events: ['Stop'],
    timeoutSeconds: 3
  });
  assert.equal(seconds.config.hooks.Stop[0].hooks[0].timeout, 3);

  const geminiSeconds = buildProviderSessionHookConfigPatch('gemini', {}, {
    homeDir: '/tmp/aih-hooks',
    events: ['Stop'],
    timeoutSeconds: 7
  });
  assert.equal(geminiSeconds.config.hooks.Stop[0].hooks[0].timeout, 7000);

  const geminiMs = buildProviderSessionHookConfigPatch('gemini', {}, {
    homeDir: '/tmp/aih-hooks',
    events: ['Stop'],
    timeoutSeconds: 7,
    timeoutMs: 2500
  });
  assert.equal(geminiMs.config.hooks.Stop[0].hooks[0].timeout, 2500);

  const geminiFloor = buildProviderSessionHookConfigPatch('gemini', {}, {
    homeDir: '/tmp/aih-hooks',
    events: ['Stop'],
    timeoutMs: 1
  });
  assert.equal(geminiFloor.config.hooks.Stop[0].hooks[0].timeout, 100);
});

test('json_hooks：保留用户 hook/其它配置键，替换旧托管 handler，重复装配幂等', () => {
  const homeDir = '/tmp/aih-hooks-idempotent';
  const first = buildProviderSessionHookConfigPatch('claude', {}, { homeDir, events: ['Stop'] });

  const repeated = buildProviderSessionHookConfigPatch('claude', first.config, { homeDir, events: ['Stop'] });
  assert.equal(repeated.changed, false, '相同托管内容重复装配不应报告变更');
  assert.deepEqual(repeated.config, first.config);

  const existing = cloneJson(first.config);
  existing.theme = 'dark';
  existing.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'user-session-start' }] }];

  const withUserHook = buildProviderSessionHookConfigPatch('claude', existing, { homeDir, events: ['Stop'] });
  assert.equal(withUserHook.config.theme, 'dark');
  assert.equal(withUserHook.config.hooks.SessionStart[0].hooks[0].command, 'user-session-start');
  assert.equal(countManagedHandlers(withUserHook.config.hooks.Stop, 'claude'), 1);

  // 旧版本留下的托管 handler 必须在追加前被摘掉，不能越装越多。
  const stale = cloneJson(existing);
  stale.hooks.Stop.push({
    hooks: [{
      type: 'command',
      command: `node '/old/sender.js' ${hookConfig.MANAGED_HOOK_MARKER} --provider 'claude' --event 'Stop' --url 'http://127.0.0.1:9527/old'`
    }]
  });
  const repaired = buildProviderSessionHookConfigPatch('claude', stale, { homeDir, events: ['Stop'] });
  assert.equal(managedHandlersOf(repaired.config.hooks.Stop, 'claude').length, 1, '旧托管 handler 应被替换而不是叠加');
  assert.equal(repaired.config.hooks.Stop.length, 1, '托管-only 组应合并为一组');
});

test('json_hooks：hooks 字段形状异常时也能安全装配', () => {
  const patch = buildProviderSessionHookConfigPatch('gemini', {
    hooks: 'not-an-object',
    keep: { nested: true }
  }, { homeDir: '/tmp/aih-hooks', events: ['Stop'] });

  assert.equal(patch.ok, true);
  assert.deepEqual(patch.config.keep, { nested: true });
  assert.equal(patch.config.hooks.Stop.length, 1);
  assert.equal(managedHandlersOf(patch.config.hooks.Stop, 'gemini').length, 1);
});

// ---------------------------------------------------------------------------
// 5. AGY 命名 hook 装配
// ---------------------------------------------------------------------------

test('agy_named_hooks：顶层具名对象 + enabled，替换整个 AIH 命名 hook，保留其它 hook', () => {
  const existing = {
    'other-hook': { enabled: true, Stop: [{ type: 'command', command: 'other' }] },
    'aih-session-sync': { enabled: false, Stale: [{ type: 'command', command: 'stale' }] }
  };
  const patch = buildProviderSessionHookConfigPatch('agy', existing, {
    homeDir: '/tmp/aih-agy-home',
    events: ['PreInvocation', 'PostInvocation', 'Stop']
  });

  assert.equal(patch.ok, true);
  assert.equal(patch.targetKind, 'hooks.json');
  assert.equal(patch.targetPath, '/tmp/aih-agy-home/.gemini/config/hooks.json');
  assert.equal(patch.hookName, 'aih-session-sync');
  assert.deepEqual(patch.config['other-hook'], existing['other-hook']);

  const definition = patch.config['aih-session-sync'];
  assert.equal(definition.enabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(definition, 'Stale'), false, '旧命名 hook 的内容应被整体替换');
  for (const eventName of ['PreInvocation', 'PostInvocation', 'Stop']) {
    assert.equal(definition[eventName].length, 1);
    const handler = definition[eventName][0];
    assert.equal(handler.type, 'command');
    assert.equal(handler.timeout, 10);
    assert.ok(handler.command.includes(`--provider 'agy'`));
    assert.ok(handler.command.includes(`--event '${eventName}'`));
  }

  const again = buildProviderSessionHookConfigPatch('agy', patch.config, {
    homeDir: '/tmp/aih-agy-home',
    events: ['PreInvocation', 'PostInvocation', 'Stop']
  });
  assert.equal(again.changed, false);
  assert.deepEqual(again.config, patch.config);
});

test('agy_named_hooks：PreToolUse/PostToolUse 用 matcher:* 的组，其它事件用裸 handler', () => {
  const patch = buildProviderSessionHookConfigPatch('agy', {}, {
    homeDir: '/tmp/aih-agy-home',
    events: ['PreToolUse', 'PostToolUse', 'Stop']
  });
  const definition = patch.config['aih-session-sync'];

  for (const eventName of ['PreToolUse', 'PostToolUse']) {
    const value = definition[eventName];
    assert.equal(Array.isArray(value), true);
    assert.equal(value.length, 1);
    assert.equal(value[0].matcher, '*');
    assert.equal(value[0].hooks.length, 1);
    assert.ok(value[0].hooks[0].command.includes(`--event '${eventName}'`));
  }
  assert.equal(definition.Stop.length, 1);
  assert.equal(definition.Stop[0].type, 'command');
  assert.equal(definition.Stop[0].hooks, undefined);
});

test('agy_named_hooks：支持自定义 hookName，且只覆盖该名字', () => {
  const patch = buildProviderSessionHookConfigPatch('agy', { 'aih-session-sync': { enabled: true } }, {
    homeDir: '/tmp/aih-agy-home',
    events: ['Stop'],
    hookName: 'custom-sync'
  });
  assert.equal(patch.hookName, 'custom-sync');
  assert.deepEqual(patch.config['aih-session-sync'], { enabled: true });
  assert.equal(patch.config['custom-sync'].enabled, true);
  assert.equal(patch.config['custom-sync'].Stop.length, 1);
});

// ---------------------------------------------------------------------------
// 6. OpenCode 插件桥装配
// ---------------------------------------------------------------------------

test('opencode_plugin：返回原始插件源码（不是 hooks.json），含 v2 契约与 receiver URL', () => {
  withEnv({ OPENCODE_CONFIG_DIR: '/tmp/aih-opencode-config', XDG_CONFIG_HOME: undefined }, () => {
    const patch = buildProviderSessionHookConfigPatch('opencode', {}, {
      homeDir: '/tmp/aih-opencode-home',
      fs: createMemoryFs()
    });

    assert.equal(patch.ok, true);
    assert.equal(patch.provider, 'opencode');
    assert.equal(patch.targetKind, 'plugin.js');
    assert.equal(patch.targetPath, path.join('/tmp/aih-opencode-config', 'plugin', 'aih-session-hook.js'));
    assert.equal(patch.changed, true);
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'config'), false, '插件桥不应伪装成 hooks.json 配置');
    assert.deepEqual(patch.events, ['UserPromptSubmit', 'Stop']);
    assert.ok(patch.source.includes('aih-session-hook'));
    assert.ok(patch.source.includes('export default'));
    assert.ok(patch.source.includes('ctx.event.subscribe'));
    assert.ok(patch.source.includes('session.execution.started'));
    assert.ok(patch.source.includes(patch.receiverUrl));
    assert.equal(patch.receiverUrl, hookConfig.DEFAULT_RECEIVER_URL);
  });
});

test('opencode_plugin：receiverUrl 与 port 选项生效', () => {
  withEnv({ OPENCODE_CONFIG_DIR: '/tmp/aih-opencode-config', XDG_CONFIG_HOME: undefined }, () => {
    const custom = buildProviderSessionHookConfigPatch('opencode', {}, {
      fs: createMemoryFs(),
      receiverUrl: 'http://127.0.0.1:1234/custom'
    });
    assert.equal(custom.receiverUrl, 'http://127.0.0.1:1234/custom');
    assert.ok(custom.source.includes('http://127.0.0.1:1234/custom'));

    const byPort = buildProviderSessionHookConfigPatch('opencode', {}, {
      fs: createMemoryFs(),
      port: 1234
    });
    assert.equal(byPort.receiverUrl, 'http://127.0.0.1:1234/v0/webui/session-events/provider-hook');
    assert.ok(byPort.source.includes(byPort.receiverUrl));
  });
});

test('opencode_plugin：install/diagnose/uninstall 只碰 AIH 托管插件文件', () => {
  withEnv({ OPENCODE_CONFIG_DIR: '/tmp/aih-opencode-config', XDG_CONFIG_HOME: undefined }, () => {
    const homeDir = '/tmp/aih-opencode-home';
    const targetPath = path.join('/tmp/aih-opencode-config', 'plugin', 'aih-session-hook.js');
    const memoryFs = createMemoryFs();

    const dry = installProviderSessionHookConfig('opencode', { homeDir, fs: memoryFs, dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.changed, true);
    assert.equal(memoryFs.files.size, 0, 'dryRun 不应写文件');

    const installed = installProviderSessionHookConfig('opencode', { homeDir, fs: memoryFs });
    assert.equal(installed.ok, true);
    assert.equal(installed.changed, true);
    assert.equal(installed.targetKind, 'plugin.js');
    assert.ok(memoryFs.files.has(targetPath));

    const diagnosed = diagnoseProviderSessionHookConfig('opencode', {}, { homeDir, fs: memoryFs });
    assert.equal(diagnosed.supported, true);
    assert.equal(diagnosed.installed, true);
    assert.equal(diagnosed.syncMode, 'hook');
    assert.deepEqual(diagnosed.events, ['UserPromptSubmit', 'Stop']);

    const again = installProviderSessionHookConfig('opencode', { homeDir, fs: memoryFs });
    assert.equal(again.changed, false, '重复安装同一份源码不应报告变更');

    const removed = uninstallProviderSessionHookConfig('opencode', { homeDir, fs: memoryFs });
    assert.equal(removed.ok, true);
    assert.equal(removed.changed, true);
    assert.equal(removed.removed, true);
    assert.equal(memoryFs.files.has(targetPath), false);

    const userSource = '// user plugin\nexport default { id: "user" };\n';
    memoryFs.files.set(targetPath, userSource);
    const untouched = uninstallProviderSessionHookConfig('opencode', { homeDir, fs: memoryFs });
    assert.equal(untouched.ok, true);
    assert.equal(untouched.changed, false);
    assert.equal(untouched.removed, false);
    assert.equal(memoryFs.files.get(targetPath), userSource, '用户自建插件不能被删除');
  });
});

// ---------------------------------------------------------------------------
// 7. codex featureFlag：hooks.json 旁边的 config.toml 特性开关
// ---------------------------------------------------------------------------

test('codex featureFlag：install 同时修补 config.toml，dryRun 只报告不落盘', () => {
  const homeDir = '/tmp/aih-codex-home';
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const hooksPath = path.join(homeDir, '.codex', 'hooks.json');
  const beforeConfig = '[features]\nhooks = false\n';
  const memoryFs = createMemoryFs({ [configPath]: beforeConfig });

  const dry = installProviderSessionHookConfig('codex', {
    homeDir,
    fs: memoryFs,
    dryRun: true,
    events: ['Stop'],
    codexVersion: '0.120.0'
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.changed, true);
  assert.ok(dry.codexFeatures);
  assert.equal(dry.codexFeatures.path, configPath);
  assert.equal(dry.codexFeatures.changed, true);
  assert.equal(dry.codexFeatures.disabledBefore, true);
  assert.equal(memoryFs.files.get(configPath), beforeConfig, 'dryRun 不应改写 config.toml');
  assert.equal(memoryFs.files.has(hooksPath), false, 'dryRun 不应写 hooks.json');

  const installed = installProviderSessionHookConfig('codex', {
    homeDir,
    fs: memoryFs,
    events: ['Stop'],
    codexVersion: '0.120.0'
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.changed, true);
  assert.equal(installed.codexFeatures.changed, true);
  assert.ok(memoryFs.files.has(hooksPath));
  assert.match(memoryFs.files.get(configPath), /\[features\]\nhooks = true/);

  const writtenHooks = JSON.parse(memoryFs.files.get(hooksPath));
  assert.equal(countManagedHandlers(writtenHooks.hooks.Stop, 'codex'), 1);

  const again = installProviderSessionHookConfig('codex', {
    homeDir,
    fs: memoryFs,
    events: ['Stop'],
    codexVersion: '0.120.0'
  });
  assert.equal(again.changed, false, 'hooks 与特性开关都已是目标状态时不应报告变更');
});

test('codex featureFlag：只有 install 会碰 config.toml，patch 本身不包含 feature 信息', () => {
  const patch = buildProviderSessionHookConfigPatch('codex', {}, { homeDir: '/tmp/aih-codex-patch', events: ['Stop'] });
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'codexFeatures'), false);

  const memoryFs = createMemoryFs();
  const result = installProviderSessionHookConfig('claude', {
    homeDir: '/tmp/aih-claude-home',
    fs: memoryFs,
    dryRun: true,
    events: ['Stop']
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'codexFeatures'), false, '非 codex 不应有特性开关副作用');
});

test('codex 诊断：config.toml 里显式关闭 hooks 时 installed=false 且 disabled=true', () => {
  const homeDir = '/tmp/aih-codex-diag';
  const patch = buildProviderSessionHookConfigPatch('codex', {}, { homeDir, events: ['Stop'] });

  const disabled = diagnoseProviderSessionHookConfig('codex', patch.config, {
    homeDir,
    events: ['Stop'],
    codexVersion: '0.120.0',
    codexConfigText: '[features]\nhooks = false\n'
  });
  assert.equal(disabled.supported, true);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.installed, false);
  assert.deepEqual(disabled.missingEvents, []);
  assert.equal(disabled.codexFeatures.disabled, true);

  const enabled = diagnoseProviderSessionHookConfig('codex', patch.config, {
    homeDir,
    events: ['Stop'],
    codexVersion: '0.120.0',
    codexConfigText: '[features]\nhooks = true\n'
  });
  assert.equal(enabled.disabled, false);
  assert.equal(enabled.installed, true);
});

// ---------------------------------------------------------------------------
// 8. 诊断与卸载
// ---------------------------------------------------------------------------

test('json_hooks 诊断：缺哪些事件就报哪些，装配后 installed=true', () => {
  const events = ['Stop', 'SessionStart'];
  const empty = diagnoseProviderSessionHookConfig('claude', {}, { events, homeDir: '/tmp/aih-diag' });
  assert.equal(empty.supported, true);
  assert.equal(empty.installed, false);
  assert.deepEqual(empty.missingEvents, ['Stop', 'SessionStart']);
  assert.deepEqual(empty.events, events);
  assert.equal(empty.syncMode, 'hook');

  const patch = buildProviderSessionHookConfigPatch('claude', {}, { events, homeDir: '/tmp/aih-diag' });
  const ready = diagnoseProviderSessionHookConfig('claude', patch.config, { events, homeDir: '/tmp/aih-diag' });
  assert.equal(ready.installed, true);
  assert.deepEqual(ready.missingEvents, []);
});

test('agy 诊断：enabled=false 视为 disabled，事件齐全也不算已安装', () => {
  const patch = buildProviderSessionHookConfigPatch('agy', {}, { events: ['Stop'], homeDir: '/tmp/aih-diag' });
  const disabledConfig = cloneJson(patch.config);
  disabledConfig['aih-session-sync'].enabled = false;

  const disabled = diagnoseProviderSessionHookConfig('agy', disabledConfig, { events: ['Stop'], homeDir: '/tmp/aih-diag' });
  assert.equal(disabled.supported, true);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.installed, false);
  assert.deepEqual(disabled.missingEvents, []);
  assert.equal(disabled.hookName, 'aih-session-sync');

  const enabled = diagnoseProviderSessionHookConfig('agy', patch.config, { events: ['Stop'], homeDir: '/tmp/aih-diag' });
  assert.equal(enabled.disabled, false);
  assert.equal(enabled.installed, true);
});

test('不支持 hook 的 provider 诊断/安装/卸载都返回明确错误', () => {
  for (const id of ['qoder', 'kimi', 'codebuddy', 'unknown']) {
    const diagnosed = diagnoseProviderSessionHookConfig(id, {}, {});
    assert.equal(diagnosed.supported, false, id);
    assert.equal(diagnosed.reason, 'unsupported_provider', id);
    assert.equal(diagnosed.installed, false, id);
    assert.deepEqual(diagnosed.events, [], id);

    assert.deepEqual(buildProviderSessionHookConfigPatch(id, {}, {}), { ok: false, error: 'unsupported_provider', provider: id });
    assert.deepEqual(installProviderSessionHookConfig(id), { ok: false, error: 'unsupported_provider', provider: id });
    assert.deepEqual(uninstallProviderSessionHookConfig(id), { ok: false, error: 'unsupported_provider', provider: id });
  }
});

test('json_hooks 卸载：只摘除托管 handler，用户 hook 与其它键原样保留', () => {
  const homeDir = '/tmp/aih-uninstall-home';
  const targetPath = path.join(homeDir, '.claude', 'settings.json');
  const patched = buildProviderSessionHookConfigPatch('claude', {}, { homeDir, events: ['Stop'] }).config;
  patched.theme = 'dark';
  patched.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'user-session-start' }] }];
  const before = JSON.stringify(patched, null, 2);
  const memoryFs = createMemoryFs({ [targetPath]: before });

  const dry = uninstallProviderSessionHookConfig('claude', { homeDir, fs: memoryFs, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.changed, true);
  assert.equal(dry.targetPath, targetPath);
  assert.equal(memoryFs.files.get(targetPath), before, 'dryRun 不应写文件');

  const removed = uninstallProviderSessionHookConfig('claude', { homeDir, fs: memoryFs });
  assert.equal(removed.ok, true);
  assert.equal(removed.changed, true);
  const after = JSON.parse(memoryFs.files.get(targetPath));
  assert.equal(after.theme, 'dark');
  assert.equal(after.hooks.SessionStart[0].hooks[0].command, 'user-session-start');
  assert.equal(Object.prototype.hasOwnProperty.call(after.hooks, 'Stop'), false, '只有托管 handler 的事件应整键移除');
  assert.equal(managedHandlersOf(after.hooks.SessionStart, 'claude').length, 0);

  const again = uninstallProviderSessionHookConfig('claude', { homeDir, fs: memoryFs });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

test('agy 卸载：只删 AIH 命名 hook，其它命名 hook 保留', () => {
  const homeDir = '/tmp/aih-uninstall-agy';
  const targetPath = path.join(homeDir, '.gemini', 'config', 'hooks.json');
  const patched = buildProviderSessionHookConfigPatch('agy', {}, { homeDir, events: ['Stop'] }).config;
  patched['user-hook'] = { enabled: true, Stop: [{ type: 'command', command: 'user' }] };
  const memoryFs = createMemoryFs({ [targetPath]: JSON.stringify(patched, null, 2) });

  const removed = uninstallProviderSessionHookConfig('agy', { homeDir, fs: memoryFs });
  assert.equal(removed.ok, true);
  assert.equal(removed.changed, true);
  const after = JSON.parse(memoryFs.files.get(targetPath));
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'aih-session-sync'), false);
  assert.deepEqual(after['user-hook'], patched['user-hook']);
});

test('卸载在目标文件不存在时安全返回 changed=false', () => {
  const memoryFs = createMemoryFs();
  const result = uninstallProviderSessionHookConfig('grok', {
    homeDir: '/tmp/aih-uninstall-missing',
    fs: memoryFs
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(memoryFs.files.size, 0);
});

// ---------------------------------------------------------------------------
// 9. 命令构造（托管 handler 的可识别性）
// ---------------------------------------------------------------------------

test('receiver URL：默认端点、provider/event 归一化、自定义端点', () => {
  assert.equal(hookConfig.DEFAULT_HOOK_TIMEOUT_SECONDS, 10);
  assert.equal(hookConfig.DEFAULT_HOOK_TIMEOUT_MS, 10000);
  assert.equal(hookConfig.MANAGED_HOOK_MARKER, '--aih-provider-session-hook');
  assert.equal(buildProviderHookReceiverUrl(), hookConfig.DEFAULT_RECEIVER_URL);

  const url = new URL(buildProviderHookReceiverUrl({ provider: '  CLAUDE ', eventName: ' SessionStart ' }));
  assert.equal(url.origin + url.pathname, 'http://127.0.0.1:9527/v0/webui/session-events/provider-hook');
  assert.equal(url.searchParams.get('provider'), 'claude');
  assert.equal(url.searchParams.get('event'), 'SessionStart');

  const alias = new URL(buildProviderHookReceiverUrl({ provider: 'codex', event: 'Stop' }));
  assert.equal(alias.searchParams.get('event'), 'Stop');

  const custom = new URL(buildProviderHookReceiverUrl({
    provider: 'grok',
    eventName: 'StopFailure',
    receiverUrl: 'http://127.0.0.1:1234/custom/hook'
  }));
  assert.equal(custom.origin + custom.pathname, 'http://127.0.0.1:1234/custom/hook');
  assert.equal(custom.searchParams.get('provider'), 'grok');
});

test('sender 命令：posix 加引号，win32 无引号且剥离 URL 查询串', () => {
  const posix = buildProviderSessionHookSenderCommand({
    provider: 'claude',
    eventName: 'Stop',
    platform: 'posix',
    nodeExecPath: '/usr/bin/node',
    senderScriptPath: '/s.js',
    receiverUrl: 'http://127.0.0.1:9527/hook'
  });
  assert.equal(
    posix,
    "/usr/bin/node '/s.js' --aih-provider-session-hook --provider 'claude' --event 'Stop' --url 'http://127.0.0.1:9527/hook?provider=claude&event=Stop'"
  );

  const win32 = buildProviderSessionHookSenderCommand({
    provider: 'claude',
    eventName: 'Stop',
    platform: 'win32',
    nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
    senderScriptPath: 'C:\\ai home\\sender.js',
    receiverUrl: 'http://127.0.0.1:9527/hook'
  });
  assert.equal(win32.includes("'"), false, 'win32 命令不能含单引号');
  assert.equal(win32.includes('?'), false, 'win32 命令必须剥离 URL 查询串');
  assert.ok(win32.startsWith('node '), '含空格的 node 路径退回 PATH 上的 node');
  assert.ok(win32.includes('"C:/ai home/sender.js"'));
  assert.ok(win32.includes('--url http://127.0.0.1:9527/hook'));
});

test('isManagedCommand 按 marker + provider 精确识别，避免前缀误删', () => {
  const command = buildProviderSessionHookSenderCommand({
    provider: 'codex',
    eventName: 'Stop',
    platform: 'posix',
    nodeExecPath: '/usr/bin/node',
    senderScriptPath: '/s.js'
  });
  assert.equal(isManagedCommand(command, 'codex'), true);
  assert.equal(isManagedCommand(command, 'code'), false, 'codex 不能被误认成 code');
  assert.equal(isManagedCommand(command), true, '不传 provider 时只按 marker 判断');
  assert.equal(isManagedCommand('echo hello', 'codex'), false);
  assert.equal(isManagedCommand('', 'codex'), false);
  assert.equal(isManagedCommand(null, 'codex'), false);
});

test('quoteShellArg / quoteWindowsCommandArg 转义单引号与反斜杠', () => {
  assert.equal(hookConfig.quoteShellArg("a'b"), "'a'\\''b'");
  assert.equal(hookConfig.quoteWindowsCommandArg('C:\\a b\\c'), '"C:/a b/c"');
});
