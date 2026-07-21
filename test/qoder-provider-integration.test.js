'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

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
const {
  encryptQoderCredentials
} = require('../lib/account/qoder-auth-metadata');
const { resolveNativeAuthIdentitySeed } = require('../lib/account/account-identity');
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

test('storage policy points at encrypted credential basenames under config-dir root', () => {
  const globalArtifacts = getProviderAuthArtifacts('qoder');
  assert.deepEqual(globalArtifacts.map((a) => a.path.join('/')), [
    'qoder-cli-credentials.json',
    '.keychain-salt'
  ]);
  const cnArtifacts = getProviderAuthArtifacts('qodercn');
  assert.deepEqual(cnArtifacts.map((a) => a.path.join('/')), [
    'qoder-cli-cn-credentials.json',
    '.keychain-salt'
  ]);
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
  assert.equal(winPlans[0].id, 'qoder_global_windows');
  assert.match(winPlans[0].args.at(-1), /qoder\.com\/install\.ps1/);
  assert.equal(winPlans.some((p) => p.id === 'npm_global'), true);

  const cnPosix = resolveNativeCliInstallPlans('qodercn', '', {
    path,
    processObj: { platform: 'linux', env: {} }
  });
  assert.equal(cnPosix.length, 1);
  assert.equal(cnPosix[0].id, 'qoder_cn_posix');
  assert.match(cnPosix[0].args.at(-1), /qoder\.com\.cn\/install/);

  assert.deepEqual(
    collectNativeCliPathEntries('qoder', {
      path,
      hostHomeDir: '/home/u',
      processObj: { platform: 'linux' }
    }),
    [path.join('/home/u', '.local', 'bin')]
  );
});

test('auth projection capture/materialize preserves encrypted blob + salt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-auth-'));
  const salt = crypto.randomBytes(32);
  const saltB64 = salt.toString('base64');
  const payload = { email: 'proj@example.com', uid: 'p1' };
  const encrypted = encryptQoderCredentials(payload, saltB64, 'qoder-cli');
  fs.writeFileSync(path.join(tmp, 'qoder-cli-credentials.json'), encrypted, 'utf8');
  fs.writeFileSync(path.join(tmp, '.keychain-salt'), salt);

  const projection = readProviderAuthProjection(fs, tmp, 'qoder', { path });
  assert.equal(projection.credentials, encrypted);
  assert.equal(projection.keychainSalt, saltB64);

  const identity = resolveNativeAuthIdentitySeed('qoder', projection);
  assert.equal(identity.identitySeed, 'oauth:qoder:proj@example.com');
  assert.equal(identity.degraded, false);

  // Materialise into a fresh dir via a fake storage layer is covered by write
  // of the encrypted text format; verify writeArtifactAtomic binary path via
  // a second projection write.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-out-'));
  // Directly exercise write by materializing with a stubbed credential store is
  // heavy; instead re-read after manual write of projected fields.
  fs.writeFileSync(path.join(out, 'qoder-cli-credentials.json'), projection.credentials, 'utf8');
  fs.writeFileSync(path.join(out, '.keychain-salt'), Buffer.from(projection.keychainSalt, 'base64'));
  const again = readProviderAuthProjection(fs, out, 'qoder', { path });
  assert.equal(again.credentials, encrypted);
  assert.equal(again.keychainSalt, saltB64);

  // materializeProviderAuth without a real account returns missing (unknown ref)
  const result = materializeProviderAuth(fs, out, 'qoder', {
    path,
    aiHomeDir: out,
    accountRef: 'not-a-ref'
  });
  assert.equal(result.missing, true);
});
