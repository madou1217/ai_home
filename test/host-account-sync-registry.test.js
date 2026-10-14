'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BaseHostAccountSync } = require('../lib/account/host-account-sync/base-host-account-sync');
const {
  HOST_ACCOUNT_SYNCS,
  HOST_ACCOUNT_SYNC_PROVIDERS,
  createHostAccountSyncs
} = require('../lib/account/host-account-sync');
const { HOST_OBSERVED_PROVIDERS } = require('../lib/account/host-observed-providers');
const store = require('../lib/server/account-credential-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { NOW, CLINE_CREDENTIAL_PATH, clineAuth, providersDocument } = require('./helpers/cline-credential');

test('every provider with a host observer also has a deletion tombstone', () => {
  assert.ok(HOST_ACCOUNT_SYNC_PROVIDERS.length > 0, '注册表不能是空的');
  assert.equal(
    new Set(HOST_OBSERVED_PROVIDERS).size,
    HOST_OBSERVED_PROVIDERS.length,
    '墓碑列表不得有重复项'
  );
  // 新接一个宿主观察者却忘了补墓碑，账号删除后就会被后台轮询登记回来（历史 bug）。
  const missing = HOST_ACCOUNT_SYNC_PROVIDERS.filter(provider => !HOST_OBSERVED_PROVIDERS.includes(provider));
  assert.deepEqual(missing, [], '注册表覆盖的 provider 必须同时出现在 host-observed-providers 里');
});

test('registry entries expose the full sync contract and unique identity', () => {
  const syncs = createHostAccountSyncs({ fs, aiHomeDir: '/tmp/aih-registry', hostHomeDir: '/tmp/aih-registry-home' });
  assert.equal(syncs.length, HOST_ACCOUNT_SYNCS.length);
  const ids = new Set();
  const statsKeys = new Set();
  for (const entry of syncs) {
    assert.ok(entry.id && entry.statsKey, '每个 entry 必须有 id 与 statsKey');
    assert.ok(entry.providers.length > 0, `${entry.id} 必须声明覆盖的 provider`);
    assert.ok(!ids.has(entry.id), `重复的注册表 id: ${entry.id}`);
    assert.ok(!statsKeys.has(entry.statsKey), `重复的 statsKey: ${entry.statsKey}`);
    ids.add(entry.id);
    statsKeys.add(entry.statsKey);
    for (const method of ['scan', 'start', 'stop', 'getStats']) {
      assert.equal(typeof entry.sync[method], 'function', `${entry.id} 缺 ${method}()`);
    }
  }
});

test('the base class refuses to run with an unimplemented hook instead of silently scanning nothing', () => {
  class Incomplete extends BaseHostAccountSync {}
  const sync = new Incomplete({ fs, aiHomeDir: '/tmp/x', hostHomeDir: '/tmp/y' });
  assert.throws(() => sync.providers, /providers must be implemented/);
  assert.throws(() => sync.sourceFiles([], {}), /sourceFiles must be implemented/);
  assert.throws(() => sync.inspect({}), /inspect must be implemented/);
  assert.throws(() => sync.extractIdentity({}, 'cline'), /extractIdentity must be implemented/);
  assert.throws(() => sync.compare(null, {}, {}), /compare must be implemented/);
  assert.throws(() => sync.buildPayload(null, {}, {}), /buildPayload must be implemented/);
});

test('a sync with neither host home nor explicit files reports an empty scan, not a fake one', () => {
  const entry = createHostAccountSyncs({ fs, aiHomeDir: '/tmp/aih-registry', hostHomeDir: '' })
    .find(item => item.id === 'cline');
  assert.deepEqual(entry.sync.scan(), { updated: [], skipped: [], scanned: 0 });
  assert.deepEqual(entry.sync.getStats(), { scanned: 0, updated: 0, skipped: [], pending: 0 });
});

test('the registry-wired Cline observer registers a host login once and never duplicates it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-host-sync-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(hostHomeDir, { recursive: true });
  const hostFile = path.join(hostHomeDir, ...CLINE_CREDENTIAL_PATH);
  fs.mkdirSync(path.dirname(hostFile), { recursive: true });
  fs.writeFileSync(hostFile, JSON.stringify(providersDocument('cline-pass', clineAuth('cline-user-1', 1))));

  const entry = createHostAccountSyncs({ fs, aiHomeDir, hostHomeDir, now: () => NOW })
    .find(item => item.id === 'cline');
  const first = entry.sync.scan();
  assert.equal(first.updated.length, 1, '宿主登录态应被自动登记');
  assert.equal(first.updated[0].created, true);
  const accountRef = first.updated[0].accountRef;
  assert.equal(store.listAccountCredentialRecords(fs, aiHomeDir, 'cline').length, 1);

  // 宿主文件与沙箱投影是**同一份身份**：再扫一轮（含新增的投影来源）只允许 0 条新增。
  const projectionFile = path.join(
    resolveAccountRuntimeDir(aiHomeDir, 'cline', accountRef), ...CLINE_CREDENTIAL_PATH);
  fs.mkdirSync(path.dirname(projectionFile), { recursive: true });
  fs.writeFileSync(projectionFile, JSON.stringify(providersDocument('cline-pass', clineAuth('cline-user-1', 1))));
  const second = entry.sync.scan();
  assert.deepEqual(second.updated, [], '同一身份的第二份来源不得再登记一个账号');
  assert.equal(store.listAccountCredentialRecords(fs, aiHomeDir, 'cline').length, 1);
});
