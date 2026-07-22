'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const {
  AI_CLI_CONFIGS,
  getAiCliBinaryName,
  isSupportedAiCli,
  listSupportedAiClis
} = require('../lib/cli/services/ai-cli/provider-registry');
const { getProviderLaunchStrategy } = require('../lib/cli/services/ai-cli/launch-profile');
const { getProviderStoragePolicy, getProviderAuthArtifacts } = require('../lib/runtime/provider-storage-policy');
const {
  QODER_INSTALLERS,
  resolveNativeCliInstallPlans,
  collectNativeCliPathEntries
} = require('../lib/cli/services/ai-cli/native-cli-installer');
const {
  readProviderAuthProjection,
  materializeProviderAuth
} = require('../lib/account/native-auth-projection');
const { PROVIDER_IDS } = require('../lib/provider-catalog');

test('catalog and CLI registry expose both Qoder variants', () => {
  assert.ok(PROVIDER_IDS.includes('qoder'));
  assert.ok(PROVIDER_IDS.includes('qodercn'));
  assert.equal(isSupportedAiCli('qoder'), true);
  assert.equal(isSupportedAiCli('qodercn'), true);
  assert.ok(listSupportedAiClis().includes('qoder'));
  assert.ok(listSupportedAiClis().includes('qodercn'));
  assert.equal(getAiCliBinaryName('qoder'), 'qodercli');
  assert.equal(getAiCliBinaryName('qodercn'), 'qoderclicn');
  assert.equal(getAiCliBinaryName('claude'), 'claude');
  assert.deepEqual(AI_CLI_CONFIGS.qoder.loginArgs, ['login']);
  assert.equal(AI_CLI_CONFIGS.qoder.configDirFlag, '--config-dir');
  assert.equal(AI_CLI_CONFIGS.qodercn.configDirFlag, '--config-dir');
});

test('launch strategy isolates Qoder via host HOME + prepare config dir', () => {
  for (const provider of ['qoder', 'qodercn']) {
    const strategy = getProviderLaunchStrategy(provider);
    assert.equal(strategy.name, 'qoder-config-dir');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-'));
    const hostHome = path.join(tmp, 'host');
    const sandbox = path.join(tmp, 'sandbox');
    fs.mkdirSync(hostHome, { recursive: true });
    const ctx = {
      cliName: provider,
      sandboxDir: sandbox,
      hostHomeDir: hostHome,
      path,
      fs,
      baseEnv: {},
      isLogin: true
    };
    strategy.prepare(ctx);
    assert.ok(fs.existsSync(path.join(sandbox, '.auth')));
    const patch = strategy.buildEnvPatch(ctx);
    assert.equal(patch.set.HOME, hostHome);
    assert.equal(patch.set.USERPROFILE, hostHome);
    assert.ok(patch.unset.includes('QODER_PERSONAL_ACCESS_TOKEN'));
  }
});

test('storage policy and artifact hooks share config-root-relative auth paths', () => {
  const expected = ['.auth/user', '.auth/machine_id', '.cache/dns-cache.json'];
  assert.deepEqual(getProviderAuthArtifacts('qoder').map((a) => a.path.join('/')), expected);
  assert.deepEqual(getProviderAuthArtifacts('qodercn').map((a) => a.path.join('/')), expected);
  assert.equal(getProviderStoragePolicy('qoder').nativeRoot.length, 0);
});
test('official install plans cover Windows PowerShell and POSIX curl for both regions', () => {
  assert.ok(QODER_INSTALLERS.qoder.ps1Url.includes('qoder.com'));
  assert.ok(QODER_INSTALLERS.qodercn.ps1Url.includes('qoder.com.cn'));

  const winPlans = resolveNativeCliInstallPlans('qoder', '@qoder-ai/qodercli', {
    path,
    processObj: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    resolveNpmInstall: (pkg) => ({ command: 'npm', args: ['install', '-g', pkg] })
  });
  assert.equal(winPlans[0].id, 'qoder_global_windows_direct');
  assert.equal(winPlans[0].command.endsWith('powershell.exe'), true);
  assert.equal(winPlans.some((p) => p.id === 'npm_global'), true);

  const cnPosix = resolveNativeCliInstallPlans('qodercn', '', {
    path,
    processObj: { platform: 'linux', env: {} }
  });
  assert.equal(cnPosix.length >= 1, true);
  assert.equal(cnPosix.every((plan) => plan.id === 'qoder_cn_posix'), true);
  assert.match(cnPosix[0].args.at(-1), /qoder\.com\.cn\/install/);

  const globalPathEntries = collectNativeCliPathEntries('qoder', {
    path,
    hostHomeDir: '/home/u',
    processObj: { platform: 'linux' }
  });
  assert.equal(globalPathEntries.includes(path.join('/home/u', '.local', 'bin')), true);
  assert.equal(globalPathEntries.includes(path.join('/home/u', '.qoder', 'bin', 'qodercli')), true);
});

test('auth projection capture preserves the official config-root layout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-auth-'));
  const authDir = path.join(tmp, '.auth');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'user'), 'opaque-official-qoder-credential', 'utf8');
  fs.writeFileSync(path.join(authDir, 'machine_id'), 'machine-id', 'utf8');

  const projection = readProviderAuthProjection(fs, tmp, 'qoder', { path });
  assert.equal(projection.credentials, 'opaque-official-qoder-credential');
  assert.equal(projection.machineId, 'machine-id');

  const result = materializeProviderAuth(fs, tmp, 'qoder', {
    path,
    aiHomeDir: tmp,
    accountRef: 'not-a-ref'
  });
  assert.equal(result.missing, true);
});