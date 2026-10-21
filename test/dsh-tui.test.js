'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const {
  BASE_BUNDLE,
  PROFILE_BUNDLE,
  PROFILE_NAME,
  buildDshNodePathEnv,
  buildDshTuiInstallArgs,
  buildDshTuiLaunchArgs,
  buildHomeProjectionEnv,
  ensureDshTuiProfile,
  ensureTuiPreferences,
  hasInstalledBundle,
  mergeDshTuiPatchEntries,
  prepareDshTuiHarness
} = require('../lib/harness/dsh-tui');
const { getExternalHarness, listExternalHarnesses } = require('../lib/harness/catalog');
const { getHarnessAdapter } = require('../lib/harness/adapters');
const { getAppInstaller } = require('../lib/server/app-installers');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CATALOG = Object.freeze({
  models: [
    {
      id: 'gpt-test',
      metadata: {
        name: 'GPT Test',
        limits: { context: 128000, output: 8192 },
        modalities: { input: ['text', 'image'] }
      }
    },
    { id: 'claude-test', metadata: { name: 'Claude Test' } }
  ]
});

function writeBundle(dshHome) {
  const dir = path.join(
    dshHome, 'profiles', PROFILE_NAME, 'node_modules', ...PROFILE_BUNDLE.split('/')
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PROFILE_BUNDLE, version: '0.16.1' }));
}

function writeEntry(root) {
  const entryPath = path.join(root, 'dsh-entry.mjs');
  fs.writeFileSync(entryPath, 'export async function runCli() {}\n');
  return entryPath;
}

test('dsh-tui is a descriptor-driven external harness reusing the DSH app', () => {
  const ids = listExternalHarnesses().map((harness) => harness.id);
  assert.ok(ids.includes('dsh-tui'));
  const harness = getExternalHarness('dsh-tui');
  assert.equal(harness.interactiveKind, 'tui');
  assert.equal(harness.managedAppId, 'dsh');
  assert.equal(harness.binaryName, 'dsh');
  assert.equal(harness.supportsAccountPin, true);
  assert.equal(typeof getHarnessAdapter(harness.adapter), 'function');
});

test('dsh-tui HOME projection redirects every identity path but keeps the host cache', () => {
  const env = buildHomeProjectionEnv({
    homeDir: '/tmp/projection-home',
    hostHomeDir: '/Users/example'
  });
  assert.equal(env.HOME, '/tmp/projection-home');
  assert.equal(env.USERPROFILE, '/tmp/projection-home');
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/projection-home');
  assert.equal(env.XDG_DATA_HOME, '/tmp/projection-home/.local/share');
  assert.equal(env.XDG_STATE_HOME, '/tmp/projection-home/.local/state');
  assert.equal(env.XDG_CACHE_HOME, '/Users/example/.cache');
  assert.deepEqual(buildHomeProjectionEnv({}), {});
});

test('dsh-tui patch merge keeps other providers and rewrites only the AIH entry', () => {
  const entries = mergeDshTuiPatchEntries([
    { id: 'user-plugin', config: { keep: true } },
    {
      id: 'llm-pi-ai',
      config: {
        providers: { other: { displayName: 'Other', apiKeyEnv: 'OTHER_KEY' } },
        extra: 'keep'
      }
    }
  ], {
    baseUrl: 'http://127.0.0.1:9527/v1/',
    accountRef: 'acct_dsh_tui',
    models: [{ id: 'gpt-test', name: 'GPT Test', input: ['text'] }],
    model: 'gpt-test'
  });

  assert.equal(entries[0].id, 'user-plugin');
  assert.deepEqual(entries[0].config, { keep: true });
  const llm = entries.find((entry) => entry.id === 'llm-pi-ai');
  assert.equal(llm.config.extra, 'keep');
  assert.equal(llm.config.providers.other.apiKeyEnv, 'OTHER_KEY');
  assert.equal(llm.config.providers.aih.baseURL, 'http://127.0.0.1:9527/v1');
  assert.equal(llm.config.providers.aih.apiKeyEnv, 'OPENAI_API_KEY');
  assert.deepEqual(llm.config.providers.aih.headers, {
    'x-aih-route-owner': 'node',
    'x-account-ref': 'acct_dsh_tui'
  });
  assert.deepEqual(entries.find((entry) => entry.id === 'agent-default-model').config, {
    provider: 'aih',
    model: 'gpt-test'
  });
});

test('dsh-tui profile creation declares the TUI bundle without dropping user bundles', (t) => {
  const dshHome = tempDir(t, 'aih-dsh-tui-home-');
  const profileDir = path.join(dshHome, 'profiles', PROFILE_NAME);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'user-profile',
    dependencies: { 'left-pad': '1.0.0' },
    dsh: { profile: { bundles: ['user-bundle'] } }
  }));
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '- id: user-plugin',
    '  config:',
    '    enabled: true',
    ''
  ].join('\n'));

  const result = ensureDshTuiProfile({
    fs,
    path,
    dshHome,
    baseUrl: 'http://127.0.0.1:9527/v1',
    accountRef: 'acct_dsh_tui',
    models: [{ id: 'gpt-test', name: 'GPT Test', input: ['text'] }],
    model: 'gpt-test'
  });

  const pkg = JSON.parse(fs.readFileSync(result.packagePath, 'utf8'));
  assert.equal(pkg.name, 'user-profile');
  assert.deepEqual(pkg.dependencies, { 'left-pad': '1.0.0' });
  assert.deepEqual(pkg.dsh.profile.bundles, ['user-bundle', BASE_BUNDLE, PROFILE_BUNDLE]);

  const patch = YAML.parse(fs.readFileSync(result.patchPath, 'utf8'));
  assert.equal(patch[0].id, 'user-plugin');
  assert.equal(
    patch.find((entry) => entry.id === 'llm-pi-ai').config.providers.aih.baseURL,
    'http://127.0.0.1:9527/v1'
  );
  assert.equal(patch.find((entry) => entry.id === 'agent-default-model').config.model, 'gpt-test');
  assert.equal(fs.existsSync(result.cordisPath), true);
  assert.equal(fs.existsSync(result.workspacePath), true);
});

test('dsh-tui preferences seed onboarding and model only once', (t) => {
  const homeDir = tempDir(t, 'aih-dsh-tui-pref-');
  const first = ensureTuiPreferences(fs, path, homeDir, { provider: 'aih', model: 'gpt-test' });
  assert.deepEqual(JSON.parse(fs.readFileSync(first.onboardingPath, 'utf8')), {
    completed: true,
    version: 1
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(first.modelPath, 'utf8')), {
    provider: 'aih',
    model: 'gpt-test'
  });

  // 用户在 TUI 内改过模型后不能被下一次启动覆盖。
  fs.writeFileSync(first.modelPath, JSON.stringify({ provider: 'aih', model: 'claude-test' }));
  ensureTuiPreferences(fs, path, homeDir, { provider: 'aih', model: 'gpt-test' });
  assert.deepEqual(JSON.parse(fs.readFileSync(first.modelPath, 'utf8')), {
    provider: 'aih',
    model: 'claude-test'
  });
});

test('dsh-tui install resolves to the DSH managed app through its descriptor', () => {
  const installer = getAppInstaller('dsh-tui');
  assert.ok(installer, 'dsh-tui must resolve to an installer');
  assert.equal(installer.provider, 'dsh');
  assert.equal(getAppInstaller('PI').provider, 'pi');
  assert.equal(getAppInstaller('missing-harness'), null);
});

test('dsh-tui bundle detection requires the installed profile package', (t) => {
  const dshHome = tempDir(t, 'aih-dsh-tui-bundle-');
  assert.equal(hasInstalledBundle(dshHome), false);
  writeBundle(dshHome);
  assert.equal(hasInstalledBundle(dshHome), true);
});

test('dsh-tui install and launch args target its own profile, not the DSH web profile', () => {
  assert.deepEqual(buildDshTuiInstallArgs(), ['plugin', '--profile', PROFILE_NAME, 'add', PROFILE_BUNDLE]);
  assert.deepEqual(buildDshTuiLaunchArgs({}), ['--profile', PROFILE_NAME]);
  assert.deepEqual(
    buildDshTuiLaunchArgs({ nativeArgs: ['--resume', 'x'] }),
    ['--profile', PROFILE_NAME, '--resume', 'x']
  );
  // 复用 DSH web profile 只会组合 dsh-web-app，必须显式钉住 dsh-tui。
  assert.notEqual(PROFILE_NAME, 'aih');
});

test('dsh-tui node path helper is a no-op when the addon path cannot be resolved', (t) => {
  const root = tempDir(t, 'aih-dsh-tui-node-path-');
  const entryPath = writeEntry(root);
  assert.deepEqual(buildDshNodePathEnv(entryPath, path, ''), {});
  assert.deepEqual(buildDshNodePathEnv('', path, ''), {});
});

test('prepareDshTuiHarness wires the projection, profile and launch args', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-dsh-tui-aihome-');
  const hostHomeDir = tempDir(t, 'aih-dsh-tui-host-');
  const entryPath = writeEntry(aiHomeDir);
  const dshHome = path.join(aiHomeDir, 'run', 'harness', 'dsh-tui', 'acct_dsh_tui', 'dsh');
  writeBundle(dshHome);

  const prepared = await prepareDshTuiHarness({
    fs,
    path,
    aiHomeDir,
    hostHomeDir,
    dshPath: entryPath,
    accountRef: 'acct_dsh_tui',
    provider: 'codex',
    model: 'gpt-test',
    gateway: { baseUrl: 'http://127.0.0.1:9527/v1/', apiKey: 'gateway-key' },
    catalog: CATALOG,
    sharedSessions: false,
    autoInstall: false
  });

  assert.equal(prepared.model, 'gpt-test');
  assert.deepEqual(prepared.args, ['--profile', PROFILE_NAME]);
  assert.equal(prepared.command.args[1], '--profile');
  assert.equal(prepared.env.HOME, prepared.homeDir);
  assert.equal(prepared.env.USERPROFILE, prepared.homeDir);
  assert.equal(prepared.env.DSH_HOME, prepared.dshHome);
  assert.equal(prepared.env.OPENAI_API_KEY, 'gateway-key');
  assert.equal(prepared.installed, true);
  assert.deepEqual(prepared.sessionSummary, { linked: 0, skipped: 'shared_sessions_disabled' });

  const pkg = JSON.parse(fs.readFileSync(prepared.profile.packagePath, 'utf8'));
  assert.deepEqual(pkg.dsh.profile.bundles, [BASE_BUNDLE, PROFILE_BUNDLE]);
  const patch = YAML.parse(fs.readFileSync(prepared.profile.patchPath, 'utf8'));
  assert.equal(
    patch.find((entry) => entry.id === 'llm-pi-ai').config.providers.aih.headers['x-account-ref'],
    'acct_dsh_tui'
  );
  const onboarding = JSON.parse(fs.readFileSync(prepared.preferences.onboardingPath, 'utf8'));
  assert.equal(onboarding.completed, true);
});

test('prepareDshTuiHarness fails closed without a bundle or gateway credentials', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-dsh-tui-fail-');
  const entryPath = writeEntry(aiHomeDir);

  await assert.rejects(
    prepareDshTuiHarness({
      fs,
      path,
      aiHomeDir,
      dshPath: entryPath,
      accountRef: 'acct_dsh_tui',
      gateway: { baseUrl: '', apiKey: 'k' },
      catalog: CATALOG
    }),
    /gateway_base_url_missing/
  );
  await assert.rejects(
    prepareDshTuiHarness({
      fs,
      path,
      aiHomeDir,
      dshPath: entryPath,
      accountRef: 'acct_dsh_tui',
      gateway: { baseUrl: 'http://127.0.0.1:9527/v1', apiKey: '' },
      catalog: CATALOG
    }),
    /gateway_api_key_missing/
  );
  await assert.rejects(
    prepareDshTuiHarness({
      fs,
      path,
      aiHomeDir,
      dshPath: entryPath,
      accountRef: 'acct_dsh_tui',
      gateway: { baseUrl: 'http://127.0.0.1:9527/v1', apiKey: 'k' },
      catalog: CATALOG,
      sharedSessions: false,
      autoInstall: false
    }),
    (error) => error.code === 'dsh_tui_profile_install_failed'
  );
});
