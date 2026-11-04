'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { readNodeAccounts } = require('../lib/account/go-bridge/node-account-reader');
const {
  addBackupTarget,
  readBackupConfig,
  readBackupState,
  removeBackupTarget,
  setBackupTargetEnabled,
  updateBackupSettings,
  writeBackupConfig,
  resolveBackupConfigPath
} = require('../lib/account/backup/remote-backup-config');
const {
  MANIFEST_FILE,
  buildBackupPlan,
  manifestAccountPath,
  parseManifest
} = require('../lib/account/backup/remote-backup-manifest');
const {
  restoreRemoteBackup,
  runRemoteBackup
} = require('../lib/account/backup/remote-backup-service');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedApiKeyAccount(aiHomeDir, key, provider = 'codex') {
  const env = provider === 'claude'
    ? { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }
    : { OPENAI_API_KEY: key, OPENAI_BASE_URL: 'https://api.openai.com/v1' };
  const registered = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    identitySeed: `api_key:${provider}:${env.OPENAI_BASE_URL || env.ANTHROPIC_BASE_URL}:${encodeURIComponent(key)}`
  });
  writeAccountCredentials(fs, aiHomeDir, registered.accountRef, env);
  const index = createAccountStateIndex({ fs, aiHomeDir });
  index.upsertAccountState(registered.accountRef, provider, { status: 'up', configured: true, apiKeyMode: true });
  index.close();
  return registered;
}

function target(overrides = {}) {
  return {
    id: 'backup-1',
    strategy: 'ssh',
    enabled: true,
    host: 'backup.example.test',
    port: 22,
    username: 'ubuntu',
    remoteDir: '~/.aih-backup',
    identityFile: '',
    passwordEnv: '',
    hostKeyFingerprint: '',
    ...overrides
  };
}

function config(targets = [target()]) {
  return {
    version: 1,
    enabled: true,
    intervalMinutes: 360,
    debounceSeconds: 0,
    targets
  };
}

function memoryStrategy(store) {
  return {
    async connect() {},
    async readFile(relativePath) {
      return store.has(relativePath) ? store.get(relativePath) : null;
    },
    async writeFile(relativePath, content) {
      store.set(relativePath, String(content));
    },
    async statFile(relativePath) {
      return store.has(relativePath) ? { size: store.get(relativePath).length, mtime: 1 } : null;
    },
    close() {}
  };
}

function quietLogger() {
  return { info() {}, warn() {} };
}

test('config: add/list/remove/settings persist as 0600 and reject invalid strategies', (t) => {
  const dir = home(t);
  const added = addBackupTarget({
    fs,
    aiHomeDir: dir,
    target: { address: 'ubuntu@203.0.113.10:2222', id: 'aws', identityFile: '~/.ssh/backup.pem' }
  });
  assert.equal(added.target.host, '203.0.113.10');
  assert.equal(added.target.port, 2222);
  assert.equal(added.target.username, 'ubuntu');

  const configPath = resolveBackupConfigPath(dir);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  const loaded = readBackupConfig({ fs, aiHomeDir: dir });
  assert.equal(loaded.targets.length, 1);
  assert.equal(loaded.targets[0].id, 'aws');
  assert.equal(loaded.targets[0].remoteDir, '~/.aih-backup');

  const disabled = setBackupTargetEnabled({ fs, aiHomeDir: dir, selector: 'aws', enabled: false });
  assert.equal(disabled.target.enabled, false);
  const updated = updateBackupSettings({ fs, aiHomeDir: dir, intervalMinutes: 15, debounceSeconds: 5 });
  assert.equal(updated.intervalMinutes, 15);
  assert.equal(updated.debounceSeconds, 5);

  assert.throws(() => addBackupTarget({
    fs,
    aiHomeDir: dir,
    target: { address: 'ubuntu@host', id: 'webdav', strategy: 'webdav' }
  }), /不支持的备份策略/);

  removeBackupTarget({ fs, aiHomeDir: dir, selector: 'aws' });
  assert.equal(readBackupConfig({ fs, aiHomeDir: dir }).targets.length, 0);
});

test('incremental plan: first run uploads all, unchanged run uploads nothing, new account uploads one file', () => {
  const first = buildBackupPlan({
    accounts: [
      { provider: 'codex', accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', cliAccountId: '1', status: 'up', env: { OPENAI_API_KEY: 'a' }, nativeAuth: {} },
      { provider: 'claude', accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', cliAccountId: '1', status: 'up', env: { ANTHROPIC_API_KEY: 'b' }, nativeAuth: {} }
    ],
    hostName: 'source'
  });
  assert.equal(first.uploads.length, 2);
  assert.equal(first.changed, true);
  assert.equal(first.manifest.revision, 1);

  const second = buildBackupPlan({
    accounts: [
      { provider: 'codex', accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', cliAccountId: '1', status: 'up', env: { OPENAI_API_KEY: 'a' }, nativeAuth: {} },
      { provider: 'claude', accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', cliAccountId: '1', status: 'up', env: { ANTHROPIC_API_KEY: 'b' }, nativeAuth: {} }
    ],
    manifest: first.manifest,
    hostName: 'source'
  });
  assert.equal(second.uploads.length, 0);
  assert.equal(second.unchanged, 2);
  assert.equal(second.changed, false);
  assert.equal(second.manifest.revision, 1);

  const third = buildBackupPlan({
    accounts: [
      { provider: 'codex', accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', cliAccountId: '1', status: 'up', env: { OPENAI_API_KEY: 'a' }, nativeAuth: {} },
      { provider: 'claude', accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', cliAccountId: '1', status: 'up', env: { ANTHROPIC_API_KEY: 'b' }, nativeAuth: {} },
      { provider: 'codex', accountRef: 'acct_cccccccccccccccccccc', cliAccountId: '2', status: 'up', env: { OPENAI_API_KEY: 'c' }, nativeAuth: {} }
    ],
    manifest: second.manifest,
    hostName: 'source'
  });
  assert.equal(third.uploads.length, 1);
  assert.equal(third.uploads[0].accountRef, 'acct_cccccccccccccccccccc');
  assert.equal(third.manifest.revision, 2);

  // 凭据变化只上传该账号。
  const fourth = buildBackupPlan({
    accounts: [
      { provider: 'codex', accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', cliAccountId: '1', status: 'up', env: { OPENAI_API_KEY: 'changed' }, nativeAuth: {} },
      { provider: 'claude', accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', cliAccountId: '1', status: 'up', env: { ANTHROPIC_API_KEY: 'b' }, nativeAuth: {} },
      { provider: 'codex', accountRef: 'acct_cccccccccccccccccccc', cliAccountId: '2', status: 'up', env: { OPENAI_API_KEY: 'c' }, nativeAuth: {} }
    ],
    manifest: third.manifest,
    hostName: 'source'
  });
  assert.equal(fourth.uploads.length, 1);
  assert.equal(fourth.uploads[0].accountRef, 'acct_aaaaaaaaaaaaaaaaaaaa');
});

test('incremental plan: deleted account becomes a tombstone and keeps its file', () => {
  const first = buildBackupPlan({
    accounts: [
      { provider: 'codex', accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', cliAccountId: '1', status: 'up', env: { OPENAI_API_KEY: 'a' }, nativeAuth: {} }
    ],
    hostName: 'source'
  });
  const second = buildBackupPlan({ accounts: [], manifest: first.manifest, hostName: 'source' });
  assert.equal(second.deleted.length, 1);
  assert.equal(second.manifest.accounts.acct_aaaaaaaaaaaaaaaaaaaa.deleted, true);
  assert.equal(second.manifest.revision, 2);
  assert.equal(second.uploads.length, 0);
});

test('service: incremental upload, credential change, and restore into an empty home', async (t) => {
  const source = home(t);
  const destination = home(t);
  const store = new Map();
  const a = seedApiKeyAccount(source, 'sk-test-111111111111111111');
  const cfg = config();
  writeBackupConfig({ fs, aiHomeDir: source, config: cfg });
  const run = () => runRemoteBackup({
    fs,
    aiHomeDir: source,
    config: cfg,
    createStrategy: () => memoryStrategy(store),
    logger: quietLogger()
  });

  const first = await run();
  assert.equal(first.ok, true);
  assert.equal(first.targets[0].uploaded, 1);
  assert.ok(store.has(MANIFEST_FILE));
  assert.ok(store.has(`accounts/codex/${a.accountRef}.json`));

  const second = await run();
  assert.equal(second.targets[0].uploaded, 0);
  assert.equal(second.targets[0].unchanged, 1);

  const b = seedApiKeyAccount(source, 'sk-test-222222222222222222');
  const third = await run();
  assert.equal(third.targets[0].uploaded, 1);
  assert.equal(third.targets[0].total, 2);

  const restored = await restoreRemoteBackup({
    fs,
    aiHomeDir: destination,
    config: cfg,
    targetId: 'backup-1',
    createStrategy: () => memoryStrategy(store)
  });
  assert.equal(restored.ok, true);
  assert.deepEqual({ ...restored.summary }, { total: 2, created: 2, updated: 0, unchanged: 0, invalid: 0, failed: 0 });
  const refs = readNodeAccounts(destination, { fs }).accounts.map((account) => account.accountRef).sort();
  assert.deepEqual(refs, [a.accountRef, b.accountRef].sort());
});

test('service: restore dry-run writes nothing', async (t) => {
  const source = home(t);
  const destination = home(t);
  const store = new Map();
  seedApiKeyAccount(source, 'sk-test-333333333333333333');
  const cfg = config();
  writeBackupConfig({ fs, aiHomeDir: source, config: cfg });
  await runRemoteBackup({
    fs,
    aiHomeDir: source,
    config: cfg,
    createStrategy: () => memoryStrategy(store),
    logger: quietLogger()
  });
  const restored = await restoreRemoteBackup({
    fs,
    aiHomeDir: destination,
    config: cfg,
    targetId: 'backup-1',
    dryRun: true,
    createStrategy: () => memoryStrategy(store)
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.summary.total, 1);
  assert.equal(readNodeAccounts(destination, { fs }).accounts.length, 0);
});

test('service: one unreachable target does not block the others and records the error', async (t) => {
  const source = home(t);
  const store = new Map();
  seedApiKeyAccount(source, 'sk-test-444444444444444444');
  const cfg = config([
    target({ id: 'good' }),
    target({ id: 'bad', host: 'unreachable.example.test' })
  ]);
  writeBackupConfig({ fs, aiHomeDir: source, config: cfg });
  const result = await runRemoteBackup({
    fs,
    aiHomeDir: source,
    config: cfg,
    logger: quietLogger(),
    createStrategy: (item) => {
      if (item.id === 'bad') {
        return {
          async connect() { throw new Error('ssh_connection_refused'); },
          close() {}
        };
      }
      return memoryStrategy(store);
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.targets.find((item) => item.targetId === 'good').ok, true);
  assert.equal(result.targets.find((item) => item.targetId === 'bad').ok, false);
  const state = readBackupState({ fs, aiHomeDir: source });
  assert.match(state.targets.bad.lastError, /ssh_connection_refused/);
  assert.ok(state.targets.good.lastOkAt);
});

test('manifest paths reject traversal in provider/accountRef', () => {
  assert.throws(() => buildBackupPlan({
    accounts: [{ provider: '../evil', accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', env: { OPENAI_API_KEY: 'x' }, nativeAuth: {} }]
  }), /invalid_backup_provider/);
  assert.throws(() => manifestAccountPath('acct_aaaaaaaaaaaaaaaaaaaa', { provider: '../../etc' }), /invalid_backup_provider/);
  assert.throws(() => manifestAccountPath('../../etc/passwd', { provider: 'codex' }), /invalid_backup_account_ref/);
});

test('manifest parser rejects foreign documents instead of guessing', () => {
  assert.equal(parseManifest('not json'), null);
  assert.equal(parseManifest(JSON.stringify({ kind: 'something-else', version: 1, accounts: {} })), null);
  const parsed = parseManifest(JSON.stringify({
    kind: 'aih-account-backup',
    version: 1,
    source: { host: 'h' },
    revision: 3,
    accounts: {
      acct_aaaaaaaaaaaaaaaaaaaa: { provider: 'codex', sha256: 'a'.repeat(64), bytes: 10 }
    }
  }));
  assert.equal(parsed.revision, 3);
  assert.equal(parsed.accounts.acct_aaaaaaaaaaaaaaaaaaaa.provider, 'codex');
});
