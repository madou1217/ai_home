'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { buildGatewayConfig } = require('../lib/cli/services/ai-cli/launch-profile/opencode-strategy');
const { writePersistedWebUiModelsCache } = require('../lib/server/webui-model-cache');

const PROFILE = Object.freeze({
  baseUrl: 'http://127.0.0.1:9527/v1',
  apiKey: 'test-key',
  isExplicitServerProfile: true
});

// 造一个临时 aiHome，写入指定的模型缓存；返回可传给 buildGatewayConfig 的 ctx。
function ctxWithModels(t, byProvider) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-gateway-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  if (byProvider) {
    writePersistedWebUiModelsCache({ fs, aiHomeDir }, { updatedAt: Date.now(), byProvider });
  }
  return { aiHomeDir, fs };
}

// ── 模型列表只来自运行时缓存（不允许硬编码兜底）─────────────────────────────

test('the model list comes from the runtime cache', (t) => {
  const ctx = ctxWithModels(t, {
    opencode: ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free']
  });
  const config = buildGatewayConfig(PROFILE, ctx);
  const ids = Object.keys(config.provider.aih.models || {});
  assert.ok(ids.includes('opencode/deepseek-v4.1-flash-free'));
  assert.ok(ids.includes('opencode/glm-5.3-flash-free'));
});

test('an empty cache injects no models rather than a stale hardcoded list', (t) => {
  const ctx = ctxWithModels(t, null);
  const config = buildGatewayConfig(PROFILE, ctx);
  // 空 models 对象会让 opencode 以为该 provider 没有模型；省略字段才能让它
  // 退回自己的目录。写死一份列表则会随上游变化而失效并误导用户。
  assert.equal('models' in config.provider.aih, false);
  assert.equal(config.model, undefined, '没有可用模型时不该指定默认模型');
});

test('a cache with only non-claude models still registers them', (t) => {
  const ctx = ctxWithModels(t, { opencode: ['opencode/nemotron-3.5-lightning-free'] });
  const config = buildGatewayConfig(PROFILE, ctx);
  assert.ok(Object.keys(config.provider.aih.models).includes('opencode/nemotron-3.5-lightning-free'));
  // 没有 claude 家族模型 → 不建 anthropic provider、不指定默认模型。
  assert.equal(config.provider.anthropic, undefined);
  assert.equal(config.model, undefined);
});

// ── 默认模型必须带 provider 前缀（踩过的坑）────────────────────────────────

test('the default model carries its provider prefix', (t) => {
  const ctx = ctxWithModels(t, {
    claude: ['claude-sonnet-4-6', 'claude-opus-5']
  });
  const config = buildGatewayConfig(PROFILE, ctx);
  // 缺前缀会被 opencode 当成裸模型名解析失败，回退到它自己的内置 provider
  // （带上宿主遗留的 key），表现为莫名的 invalid x-api-key。
  assert.match(config.model, /^anthropic\//);
  // 家族优先级 sonnet > opus，所以两个都在时选 sonnet。
  assert.equal(config.model, 'anthropic/claude-sonnet-4-6');
});

test('the default model falls back to opus when no sonnet exists', (t) => {
  const ctx = ctxWithModels(t, { claude: ['claude-opus-5', 'claude-haiku-4-5-20251001'] });
  const config = buildGatewayConfig(PROFILE, ctx);
  assert.equal(config.model, 'anthropic/claude-opus-5');
});

test('the default model is the newest of the preferred family, not the alphabetically first', (t) => {
  const ctx = ctxWithModels(t, {
    claude: [
      'claude-3-5-haiku-20241022',
      'claude-3-7-sonnet-20250219',
      'claude-sonnet-4-6',
      'claude-sonnet-5-5',
      'claude-opus-5'
    ]
  });
  const config = buildGatewayConfig(PROFILE, ctx);
  // 字母序会把 claude-3-7-sonnet 排在 claude-sonnet-5-5 前面，选出一个几年前的老模型。
  assert.equal(config.model, 'anthropic/claude-sonnet-5-5');
});

test('the anthropic provider only registers claude-family ids', (t) => {
  const ctx = ctxWithModels(t, {
    claude: ['claude-sonnet-4-6'],
    opencode: ['opencode/deepseek-v4.1-flash-free']
  });
  const config = buildGatewayConfig(PROFILE, ctx);
  assert.deepEqual(Object.keys(config.provider.anthropic.models), ['claude-sonnet-4-6']);
  // 免费模型必须留在 aih provider 下，不能被塞进 anthropic provider。
  assert.ok(!Object.keys(config.provider.anthropic.models).includes('opencode/deepseek-v4.1-flash-free'));
});

test('a non-server profile never gets a default model pinned', (t) => {
  const ctx = ctxWithModels(t, { claude: ['claude-sonnet-4-6'] });
  const config = buildGatewayConfig({ ...PROFILE, isExplicitServerProfile: false }, ctx);
  assert.equal(config.model, undefined);
});

test('the gateway endpoint and key are always injected', (t) => {
  const ctx = ctxWithModels(t, { claude: ['claude-sonnet-4-6'] });
  const config = buildGatewayConfig(PROFILE, ctx);
  assert.equal(config.provider.aih.options.baseURL, PROFILE.baseUrl);
  assert.equal(config.provider.aih.options.apiKey, PROFILE.apiKey);
  assert.equal(config.provider.anthropic.options.baseURL, PROFILE.baseUrl);
});

// ── 内置 Zen provider 改道网关（opencode-zen-gateway-overlay）────────────────
const {
  OVERLAY_FILE_NAME,
  prepareZenGatewayOverlay,
  rewriteZenProviderEndpoint
} = require('../lib/cli/services/ai-cli/launch-profile/opencode-zen-gateway-overlay');
const { opencodeStrategy } = require('../lib/cli/services/ai-cli/launch-profile/opencode-strategy');
const { buildProviderRuntimeEnv } = require('../lib/cli/services/ai-cli/provider-runtime-env');
const { OPENCODE_GATEWAY_ENV, serializeOpencodeGateway } = require('../lib/cli/services/ai-cli/opencode-gateway-context');

const GATEWAY_URL = 'http://127.0.0.1:9527/v1';
const UPSTREAM_ZEN_URL = 'https://opencode.ai/zen/v1';

// 临时根：host home（含 opencode 自己的目录缓存）+ 独立的 aiHome。
function createOverlayFixture(t, catalog) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-zen-overlay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const aiHomeDir = path.join(root, 'data', '.ai_home');
  fs.mkdirSync(hostHomeDir, { recursive: true });
  if (catalog) {
    const cachePath = path.join(hostHomeDir, '.cache', 'opencode', 'models.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(catalog));
  }
  return { root, hostHomeDir, aiHomeDir };
}

function sampleCatalog() {
  return {
    opencode: {
      id: 'opencode',
      api: UPSTREAM_ZEN_URL,
      models: {
        'model-a': { id: 'model-a', name: 'A' },
        'model-b': { id: 'model-b', name: 'B', provider: { npm: '@ai-sdk/x', api: 'https://opencode.ai/inference/v1' } }
      }
    },
    other: { id: 'other', api: 'https://other.example/v1', models: { m: { id: 'm' } } }
  };
}

function gatewayBaseEnv(hostHomeDir) {
  return {
    HOME: hostHomeDir,
    [OPENCODE_GATEWAY_ENV]: serializeOpencodeGateway({ baseUrl: GATEWAY_URL, apiKey: 'gw-test-key' })
  };
}

test('the Zen rewrite redirects provider and model-level endpoints and keeps the model list as-is', () => {
  const rewritten = rewriteZenProviderEndpoint(sampleCatalog(), GATEWAY_URL);
  assert.equal(rewritten.opencode.api, GATEWAY_URL);
  // 模型级 provider.api 会盖过 provider 级地址，必须一并改写。
  assert.equal(rewritten.opencode.models['model-b'].provider.api, GATEWAY_URL);
  assert.equal(rewritten.opencode.models['model-b'].provider.npm, '@ai-sdk/x');
  // 模型清单原样来自目录：不增不减。
  assert.deepEqual(Object.keys(rewritten.opencode.models), ['model-a', 'model-b']);
  assert.deepEqual(rewritten.opencode.models['model-a'], { id: 'model-a', name: 'A' });
  // 其它 provider 不动。
  assert.equal(rewritten.other.api, 'https://other.example/v1');
});

test('a catalog without the Zen provider yields no overlay', () => {
  assert.equal(rewriteZenProviderEndpoint({ other: { api: 'x', models: {} } }, GATEWAY_URL), null);
  assert.equal(rewriteZenProviderEndpoint(null, GATEWAY_URL), null);
});

test('the overlay file lands under the explicit aiHomeDir and is written atomically', (t) => {
  const fixture = createOverlayFixture(t, sampleCatalog());
  const overlay = prepareZenGatewayOverlay({
    fs, path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    baseEnv: {},
    gatewayBaseUrl: GATEWAY_URL,
    gatewayApiKey: 'gw-test-key'
  });
  assert.ok(overlay);
  assert.equal(overlay.modelsPath, path.join(fixture.aiHomeDir, 'run', OVERLAY_FILE_NAME));
  const written = JSON.parse(fs.readFileSync(overlay.modelsPath, 'utf8'));
  assert.equal(written.opencode.api, GATEWAY_URL);
  // 原子写：只留一个固定文件，没有临时文件残骸。
  assert.deepEqual(fs.readdirSync(path.dirname(overlay.modelsPath)), [OVERLAY_FILE_NAME]);
  assert.equal(overlay.providerOptions.apiKey, 'gw-test-key');
});

test('no Zen provider in the catalog means no models path and no gateway key on the Zen provider', (t) => {
  const fixture = createOverlayFixture(t, { other: { id: 'other', api: 'https://other.example/v1', models: {} } });
  const patch = opencodeStrategy.buildEnvPatch({
    fs, path,
    hostHomeDir: fixture.hostHomeDir,
    sandboxDir: fixture.hostHomeDir,
    aiHomeDir: fixture.aiHomeDir,
    baseEnv: gatewayBaseEnv(fixture.hostHomeDir)
  });
  assert.equal(patch.set.OPENCODE_MODELS_PATH, undefined);
  const config = JSON.parse(patch.set.OPENCODE_CONFIG_CONTENT);
  // 改道不成立：内置 provider 照旧直连 opencode.ai，绝不能带上网关 key。
  assert.equal(config.provider.opencode, undefined);
  assert.equal(fs.existsSync(path.join(fixture.aiHomeDir, 'run', OVERLAY_FILE_NAME)), false);
});

test('a missing opencode catalog cache also skips the key injection', (t) => {
  const fixture = createOverlayFixture(t, null);
  const patch = opencodeStrategy.buildEnvPatch({
    fs, path,
    hostHomeDir: fixture.hostHomeDir,
    sandboxDir: fixture.hostHomeDir,
    aiHomeDir: fixture.aiHomeDir,
    baseEnv: gatewayBaseEnv(fixture.hostHomeDir)
  });
  assert.equal(patch.set.OPENCODE_MODELS_PATH, undefined);
  assert.equal(JSON.parse(patch.set.OPENCODE_CONFIG_CONTENT).provider.opencode, undefined);
});

test('the overlay path follows the explicit aiHomeDir, never the sandbox directory depth', (t) => {
  const fixture = createOverlayFixture(t, sampleCatalog());
  // 沙箱目录形如 <X>/run/auth-projections/opencode/<accountRef>，但 X 不是 aiHome：
  // 层级反推会把改道目录写到 X/run 下（2026-10-18 事故的根因）。
  const decoyRoot = path.join(fixture.root, 'decoy');
  const sandboxDir = path.join(decoyRoot, 'run', 'auth-projections', 'opencode', 'acct_0123456789abcdef0123');
  fs.mkdirSync(sandboxDir, { recursive: true });
  const patch = opencodeStrategy.buildEnvPatch({
    fs, path,
    hostHomeDir: fixture.hostHomeDir,
    sandboxDir,
    aiHomeDir: fixture.aiHomeDir,
    baseEnv: gatewayBaseEnv(fixture.hostHomeDir)
  });
  const expected = path.join(fixture.aiHomeDir, 'run', OVERLAY_FILE_NAME);
  assert.equal(patch.set.OPENCODE_MODELS_PATH, expected);
  assert.equal(fs.existsSync(expected), true);
  assert.equal(fs.existsSync(path.join(decoyRoot, 'run', OVERLAY_FILE_NAME)), false);
  const config = JSON.parse(patch.set.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.provider.opencode.options.apiKey, 'gw-test-key');
  assert.equal(config.provider.opencode.options.headers['x-provider'], 'opencode');
});

test('the AIH Server profile launch writes the overlay under the aiHomeDir passed to the runtime env', (t) => {
  const fixture = createOverlayFixture(t, sampleCatalog());
  // AIH Server 内置 profile：运行目录就是宿主 home，不在 auth-projections 下。
  const env = buildProviderRuntimeEnv('opencode', fixture.hostHomeDir, gatewayBaseEnv(fixture.hostHomeDir), {
    path, fs,
    hostHomeDir: fixture.hostHomeDir,
    aiHomeDir: fixture.aiHomeDir,
    platform: 'linux'
  });
  const expected = path.join(fixture.aiHomeDir, 'run', OVERLAY_FILE_NAME);
  assert.equal(env.OPENCODE_MODELS_PATH, expected);
  assert.equal(JSON.parse(fs.readFileSync(expected, 'utf8')).opencode.api, GATEWAY_URL);
  assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.opencode.options.apiKey, 'gw-test-key');
});

test('without an injected aiHomeDir the overlay falls back to the host data root, not the sandbox depth', (t) => {
  const fixture = createOverlayFixture(t, sampleCatalog());
  const decoyRoot = path.join(fixture.root, 'decoy');
  const sandboxDir = path.join(decoyRoot, 'run', 'auth-projections', 'opencode', 'acct_0123456789abcdef0123');
  fs.mkdirSync(sandboxDir, { recursive: true });
  const patch = opencodeStrategy.buildEnvPatch({
    fs, path,
    hostHomeDir: fixture.hostHomeDir,
    sandboxDir,
    baseEnv: gatewayBaseEnv(fixture.hostHomeDir)
  });
  assert.equal(patch.set.OPENCODE_MODELS_PATH, path.join(fixture.hostHomeDir, '.ai_home', 'run', OVERLAY_FILE_NAME));
  assert.equal(fs.existsSync(path.join(decoyRoot, 'run', OVERLAY_FILE_NAME)), false);
});
