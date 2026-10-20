'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const {
  getExternalHarness,
  isExternalHarness,
  listExternalHarnesses
} = require('../lib/harness/catalog');
const { getHarnessAdapter } = require('../lib/harness/adapters');
const {
  buildHarnessModelEntries,
  normalizeInputModalities,
  resolveHarnessProjectionRoot
} = require('../lib/harness/projection');
const {
  buildPiLaunchArgs,
  preparePiHarness
} = require('../lib/harness/pi');
const {
  buildDshWrapperSource,
  ensureDshProfile,
  mergeDshPatchEntries,
  parseDshPatch,
  prepareDshHarness,
  resolveDshEntry,
  resolveDshNodePath
} = require('../lib/harness/dsh');
const {
  buildExternalHarnessEnv,
  prepareExternalHarness,
  spawnExternalHarness
} = require('../lib/harness/run');
const { saveAliases } = require('../lib/server/model-alias-store');
const { createAppEntryDetector } = require('../lib/server/account-app-launcher');
const { parseExternalHarnessArgs } = require('../lib/cli/commands/ai-cli/router');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CATALOG = Object.freeze({
  models: [
    {
      id: 'gpt-test',
      modalities: { input: ['text', 'image'], output: ['text'] },
      metadata: {
        name: 'GPT Test',
        limits: { context: 128000, output: 8192 },
        capabilities: { reasoning: true },
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }
      }
    },
    {
      id: 'claude-test',
      modalities: { input: ['text'], output: ['text'] },
      metadata: { name: 'Claude Test' }
    }
  ]
});

test('external harness catalog exposes descriptor-driven Pi and DSH entries', () => {
  const ids = listExternalHarnesses().map((harness) => harness.id);
  assert.deepEqual(ids, ['pi', 'dsh']);
  assert.equal(isExternalHarness('PI'), true);
  assert.equal(isExternalHarness('codex'), false);
  assert.equal(getExternalHarness('dsh').interactiveKind, 'web');
  assert.equal(getExternalHarness('pi').supportsAccountPin, true);
  assert.equal(getExternalHarness('missing'), null);
  // 每个描述符都必须能解析到投影适配器，否则派发层只会在运行时失败。
  for (const harness of listExternalHarnesses()) {
    assert.equal(typeof getHarnessAdapter(harness.adapter), 'function', `${harness.id} must register an adapter`);
  }
});

test('harness projection maps model metadata and keeps text modality', () => {
  const entries = buildHarnessModelEntries(CATALOG);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    id: 'gpt-test',
    name: 'GPT Test',
    input: ['text', 'image'],
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }
  });
  assert.deepEqual(entries[1], {
    id: 'claude-test',
    name: 'Claude Test',
    input: ['text'],
    reasoning: undefined
  });
  assert.deepEqual(normalizeInputModalities(null, null), ['text']);
  assert.deepEqual(normalizeInputModalities({ modalities: { input: ['image'] } }, null), ['text', 'image']);
});

test('harness projection root is private and stable per account', (t) => {
  const aiHomeDir = tempDir(t, 'aih-harness-root-');
  const root = resolveHarnessProjectionRoot({
    fs,
    path,
    aiHomeDir,
    harnessId: 'PI',
    accountRef: 'acct_ABC'
  });
  assert.equal(root, path.join(aiHomeDir, 'run', 'harness', 'pi', 'acct_abc'));
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
});

test('Pi projection writes an env-interpolated provider and loads the hot-refresh extension', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-pi-home-');
  const hostHomeDir = tempDir(t, 'aih-pi-host-');
  const prepared = await preparePiHarness({
    fs,
    path,
    aiHomeDir,
    hostHomeDir,
    accountRef: 'acct_pi',
    provider: 'codex',
    model: 'gpt-test',
    gateway: { baseUrl: 'http://127.0.0.1:9527/v1/', apiKey: 'gateway-key' },
    catalog: CATALOG
  });
  assert.equal(prepared.model, 'gpt-test');
  assert.deepEqual(prepared.args, ['--provider', 'aih', '--model', 'gpt-test']);
  assert.equal(prepared.env.PI_CODING_AGENT_DIR, prepared.agentDir);
  assert.equal(prepared.env.OPENAI_API_KEY, 'gateway-key');
  assert.equal(fs.statSync(prepared.modelsPath).mode & 0o777, 0o600);

  const document = JSON.parse(fs.readFileSync(prepared.modelsPath, 'utf8'));
  const provider = document.providers.aih;
  assert.equal(provider.baseUrl, 'http://127.0.0.1:9527/v1');
  assert.equal(provider.api, 'openai-completions');
  assert.equal(provider.apiKey, '$OPENAI_API_KEY');
  assert.deepEqual(provider.headers, {
    'x-aih-route-owner': 'node',
    'x-account-ref': 'acct_pi'
  });
  assert.equal(provider.models[0].id, 'gpt-test');
  assert.equal(typeof provider.models[0].name, 'string');
  assert.ok(provider.models[0].input.includes('text'));

  const extension = fs.readFileSync(prepared.extensionPath, 'utf8');
  assert.match(extension, /modelRegistry\.refresh/);
  assert.match(extension, /allowNetwork: false/);
  assert.equal(fs.readlinkSync(path.join(prepared.agentDir, 'sessions')), path.join(hostHomeDir, '.pi', 'agent', 'sessions'));
});

test('Pi launch args keep native arguments after the aih-owned provider/model', () => {
  assert.deepEqual(
    buildPiLaunchArgs({ model: 'gpt-test', nativeArgs: ['--verbose'] }),
    ['--provider', 'aih', '--model', 'gpt-test', '--verbose']
  );
});

test('DSH patch merge preserves user entries and provider definitions', () => {
  const entries = mergeDshPatchEntries([
    { id: 'custom-plugin', config: { keep: true } },
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          other: { displayName: 'Other', apiKeyEnv: 'OTHER_KEY' }
        },
        extra: 'keep'
      }
    }
  ], {
    baseUrl: 'http://127.0.0.1:9527/v1',
    accountRef: 'acct_dsh',
    models: [{ id: 'gpt-test', name: 'GPT Test', input: ['text'] }],
    model: 'gpt-test'
  });

  assert.equal(entries[0].id, 'custom-plugin');
  assert.deepEqual(entries[0].config, { keep: true });
  const llm = entries.find((entry) => entry.id === 'llm-pi-ai');
  assert.equal(llm.config.extra, 'keep');
  assert.equal(llm.config.providers.other.apiKeyEnv, 'OTHER_KEY');
  assert.equal(llm.config.providers.aih.baseURL, 'http://127.0.0.1:9527/v1');
  assert.equal(llm.config.providers.aih.headers['x-account-ref'], 'acct_dsh');
  assert.deepEqual(entries.find((entry) => entry.id === 'agent-default-model').config, {
    provider: 'aih',
    model: 'gpt-test'
  });
});

test('DSH patch parser rejects malformed files instead of overwriting them', () => {
  assert.deepEqual(parseDshPatch(''), []);
  assert.deepEqual(parseDshPatch('[]'), []);
  assert.throws(() => parseDshPatch('['), (error) => error.code === 'dsh_patch_parse_failed');
  assert.throws(() => parseDshPatch('foo: bar'), (error) => error.code === 'dsh_patch_parse_failed');
});

test('DSH profile creation adds required bundles without dropping user bundles', (t) => {
  const dshHome = tempDir(t, 'aih-dsh-home-');
  const profileDir = path.join(dshHome, 'profiles', 'aih');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'custom-profile',
    dependencies: { 'left-pad': '1.0.0' },
    dsh: { profile: { bundles: ['user-bundle'] } }
  }));
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '- id: user-plugin',
    '  config:',
    '    enabled: true',
    ''
  ].join('\n'));

  const result = ensureDshProfile({
    fs,
    path,
    dshHome,
    baseUrl: 'http://127.0.0.1:9527/v1',
    accountRef: 'acct_dsh',
    models: [{ id: 'gpt-test', name: 'GPT Test', input: ['text'] }],
    model: 'gpt-test'
  });

  const pkg = JSON.parse(fs.readFileSync(result.packagePath, 'utf8'));
  assert.equal(pkg.name, 'custom-profile');
  assert.deepEqual(pkg.dependencies, { 'left-pad': '1.0.0' });
  assert.deepEqual(pkg.dsh.profile.bundles, [
    'user-bundle',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app'
  ]);
  const patch = YAML.parse(fs.readFileSync(result.patchPath, 'utf8'));
  assert.equal(patch[0].id, 'user-plugin');
  assert.equal(patch.find((entry) => entry.id === 'llm-pi-ai').config.providers.aih.baseURL, 'http://127.0.0.1:9527/v1');
  assert.equal(patch.find((entry) => entry.id === 'agent-default-model').config.model, 'gpt-test');
  assert.equal(fs.existsSync(result.cordisPath), true);
  assert.equal(fs.existsSync(result.workspacePath), true);
});

test('DSH wrapper entry resolution follows pnpm real paths and locates the native addon node_modules', (t) => {
  const root = tempDir(t, 'aih-dsh-entry-');
  const shimDir = path.join(root, 'bin');
  const libDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'bin.js'), 'export async function runCli() {}\n');
  fs.writeFileSync(path.join(shimDir, 'dsh'), [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    'cmd-shim-target=../node_modules/@deepseek-ai/dsh/lib/bin.js',
    ''
  ].join('\n'));

  const addonDir = path.join(root, 'node_modules', 'node-addon-require-builtin');
  fs.mkdirSync(path.join(addonDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(addonDir, 'package.json'), JSON.stringify({
    name: 'node-addon-require-builtin',
    main: 'lib/index.js'
  }));
  fs.writeFileSync(path.join(addonDir, 'lib', 'index.js'), 'module.exports = {};\n');

  const entry = resolveDshEntry(path.join(shimDir, 'dsh'));
  assert.equal(entry, fs.realpathSync(path.join(libDir, 'bin.js')));
  assert.equal(resolveDshNodePath(entry), path.join(fs.realpathSync(root), 'node_modules'));
  assert.match(buildDshWrapperSource(entry), /import \{ runCli \}/);
});

test('prepareDshHarness writes the AIH provider and passes the pnpm native addon path', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-dsh-prep-home-');
  const hostHomeDir = tempDir(t, 'aih-dsh-prep-host-');
  const root = tempDir(t, 'aih-dsh-prep-entry-');
  const shimDir = path.join(root, 'bin');
  const libDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'bin.js'), 'export async function runCli() {}\n');
  fs.writeFileSync(path.join(shimDir, 'dsh'), 'cmd-shim-target=../node_modules/@deepseek-ai/dsh/lib/bin.js\n');
  const addonDir = path.join(root, 'node_modules', 'node-addon-require-builtin');
  fs.mkdirSync(path.join(addonDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(addonDir, 'package.json'), JSON.stringify({
    name: 'node-addon-require-builtin',
    main: 'lib/index.js'
  }));
  fs.writeFileSync(path.join(addonDir, 'lib', 'index.js'), 'module.exports = {};\n');

  const prepared = await prepareDshHarness({
    fs,
    path,
    aiHomeDir,
    hostHomeDir,
    accountRef: 'acct_dsh',
    provider: 'codex',
    model: 'gpt-test',
    gateway: { baseUrl: 'http://127.0.0.1:9527/v1', apiKey: 'gateway-key' },
    catalog: CATALOG,
    dshPath: path.join(shimDir, 'dsh')
  });

  assert.equal(prepared.model, 'gpt-test');
  assert.equal(prepared.env.DSH_HOME, prepared.dshHome);
  assert.equal(prepared.env.OPENAI_API_KEY, 'gateway-key');
  assert.equal(prepared.env.NODE_PATH, path.join(fs.realpathSync(root), 'node_modules'));
  assert.equal(prepared.command.file, process.execPath);
  assert.equal(prepared.command.args[0], path.join(prepared.dshHome, 'run-dsh.mjs'));
  assert.deepEqual(prepared.command.args.slice(1), ['--profile', 'aih']);
  assert.equal(fs.readlinkSync(path.join(prepared.dshHome, 'sessions')), path.join(hostHomeDir, '.dsh', 'sessions'));
});

test('prepareDshHarness fails closed when the shim target cannot be resolved', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-dsh-bad-entry-');
  await assert.rejects(() => prepareDshHarness({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: tempDir(t, 'aih-dsh-bad-entry-host-'),
    accountRef: 'acct_dsh',
    provider: 'codex',
    model: 'gpt-test',
    gateway: { baseUrl: 'http://127.0.0.1:9527/v1', apiKey: 'gateway-key' },
    catalog: CATALOG,
    dshPath: path.join(aiHomeDir, 'missing-dsh')
  }), (error) => error.message === 'dsh_entry_not_found');
});

test('external harness env keeps gateway credentials but drops native provider credentials', () => {
  const env = buildExternalHarnessEnv({
    PATH: '/bin',
    OPENAI_API_KEY: 'host-key',
    ANTHROPIC_API_KEY: 'host-anthropic',
    GEMINI_API_KEY: 'host-gemini',
    CODEX_HOME: '/host/codex',
    NODE_PATH: '/existing'
  }, {
    OPENAI_API_KEY: 'gateway-key',
    NODE_PATH: '/dsh'
  });
  assert.equal(env.OPENAI_API_KEY, 'gateway-key');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.NODE_PATH, '/dsh');
  assert.equal(env.PATH, '/bin');
});

test('prepareExternalHarness resolves aliases before pinning and prepares Pi', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-ext-alias-');
  const hostHomeDir = tempDir(t, 'aih-ext-alias-host-');
  await saveAliases(fs, aiHomeDir, {
    aliases: [{
      id: 'a1',
      alias: 'fast',
      target: 'gpt-test',
      provider: 'codex',
      targetProvider: 'codex',
      enabled: true
    }]
  });

  const prepared = await prepareExternalHarness({
    harness: 'pi',
    fs,
    aiHomeDir,
    hostHomeDir,
    accountRef: 'acct_pi',
    provider: 'codex',
    model: 'fast',
    gateway: { baseUrl: 'http://127.0.0.1:9527/v1', apiKey: 'gateway-key' },
    catalog: CATALOG
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.model, 'gpt-test');
  assert.equal(prepared.requestedModel, 'fast');
  assert.equal(prepared.alias.alias, 'fast');
  assert.deepEqual(prepared.args, ['--provider', 'aih', '--model', 'gpt-test']);
});

test('prepareExternalHarness fails closed for unknown harnesses', async () => {
  const result = await prepareExternalHarness({ harness: 'missing' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'external_harness_unknown');
});

test('spawnExternalHarness propagates the child exit code', async () => {
  const result = await spawnExternalHarness({
    ok: true,
    harness: 'pi',
    command: { file: process.execPath, args: ['-e', 'process.exit(7)'] },
    env: {}
  }, { platform: 'linux', env: process.env });
  assert.equal(result.ok, true);
  assert.equal(result.code, 7);
});

test('spawnExternalHarness reports spawn errors without throwing', async () => {
  const result = await spawnExternalHarness({
    ok: true,
    harness: 'pi',
    command: { file: path.join(os.tmpdir(), 'aih-missing-binary-does-not-exist'), args: [] },
    env: {}
  }, { platform: 'linux', env: process.env });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'external_harness_spawn_failed');
});

test('external harness CLI parsing separates aih flags from native arguments', () => {
  assert.deepEqual(parseExternalHarnessArgs('pi', [
    'pi', 'acct_4a833dc13a62526ef5ab', '--model', 'gpt-test', '--', '-p', 'hello'
  ]), {
    accountRef: 'acct_4a833dc13a62526ef5ab',
    model: 'gpt-test',
    nativeArgs: ['-p', 'hello']
  });
  assert.deepEqual(parseExternalHarnessArgs('dsh', [
    'dsh', '--model=gpt-test', '--', '--dump-config'
  ]), {
    accountRef: '',
    model: 'gpt-test',
    nativeArgs: ['--dump-config']
  });
  assert.deepEqual(parseExternalHarnessArgs('pi', ['pi', '--help']), { help: true });
  assert.deepEqual(parseExternalHarnessArgs('pi', ['pi', '--model']), { error: 'model_value_missing' });
  assert.deepEqual(parseExternalHarnessArgs('pi', ['pi', '--provider', 'openai']), {
    error: 'external_harness_controlled_flag',
    flag: '--provider'
  });
  assert.deepEqual(parseExternalHarnessArgs('dsh', ['dsh', '--profile', 'other']), {
    error: 'external_harness_controlled_flag',
    flag: '--profile'
  });
});

test('app entry capabilities expose external harness labels and kinds', (t) => {
  const detector = createAppEntryDetector({
    fs,
    path,
    hostHomeDir: tempDir(t, 'aih-app-caps-'),
    processObj: { platform: 'darwin', env: {} }
  });
  const capabilities = detector.detectCapabilities();
  assert.equal(capabilities.pi.label, 'Pi');
  assert.equal(capabilities.pi.externalHarness, true);
  assert.equal(capabilities.pi.crossProviderHarness, true);
  assert.equal(capabilities.pi.interactiveKind, 'tui');
  assert.equal(capabilities.dsh.label, 'DeepSeek Harness');
  assert.equal(capabilities.dsh.interactiveKind, 'web');
  assert.equal(capabilities.codex.externalHarness, false);
  assert.equal(typeof capabilities.codex.label, 'string');
  assert.ok(capabilities.codex.label.length > 0);
});
