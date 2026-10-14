'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  compareClineCredentialDocuments,
  readClineTokenIssuedAtMs,
  resolveClineAccountName
} = require('../lib/account/cline-credentials');
const {
  createClineNativeCredentialSync,
  detectHostClineAccounts
} = require('../lib/account/cline-native-credential-sync');
const store = require('../lib/server/account-credential-store');
const { deleteAccountRef } = require('../lib/server/account-ref-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { NOW, CLINE_CREDENTIAL_PATH, clineAuth, providersDocument } = require('./helpers/cline-credential');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(hostHomeDir, { recursive: true });
  const hostFile = path.join(hostHomeDir, ...CLINE_CREDENTIAL_PATH);
  const writeHost = (doc) => {
    fs.mkdirSync(path.dirname(hostFile), { recursive: true });
    fs.writeFileSync(hostFile, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
    return hostFile;
  };
  // 沙箱投影路径由账号运行时根推出（与真实部署同一条相对路径）。
  const projectionFile = accountRef => path.join(
    resolveAccountRuntimeDir(aiHomeDir, 'cline', accountRef), ...CLINE_CREDENTIAL_PATH);
  const writeProjection = (accountRef, doc) => {
    const file = projectionFile(accountRef);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
    return file;
  };
  return {
    root,
    aiHomeDir,
    hostHomeDir,
    hostFile,
    writeHost,
    projectionFile,
    writeProjection,
    sync: (extra = {}) => createClineNativeCredentialSync({ fs, aiHomeDir, hostHomeDir, now: () => NOW, ...extra }),
    records: () => store.listAccountCredentialRecords(fs, aiHomeDir, 'cline')
  };
}


test('a host Cline Pass login is auto-registered and only cline slots are stored', t => {
  const f = fixture(t);
  const doc = providersDocument('cline-pass', clineAuth('cline-user-1', 1));
  // CLI 在 Cline Pass 登录时会同时写两个槽位，这里如实复现。
  doc.providers.cline = { settings: { auth: clineAuth('cline-user-1', 1) }, updatedAt: new Date(NOW).toISOString() };
  f.writeHost(doc);
  const result = f.sync().scan();
  assert.equal(result.scanned, 1);
  assert.equal(result.updated.length, 1);
  assert.equal(result.updated[0].created, true);
  const [record] = f.records();
  assert.equal(record.provider, 'cline');
  assert.equal(record.accountRef, result.updated[0].accountRef);
  assert.deepEqual(Object.keys(record.nativeAuth.auth.providers).sort(), ['cline', 'cline-pass']);
  assert.equal(record.nativeAuth.auth.lastUsedProvider, 'cline-pass');
  // 同机其它 provider 的明文密钥绝不进账号库。
  const stored = JSON.stringify(record.nativeAuth);
  assert.equal(stored.includes('must-not-be-copied'), false);
  assert.equal(record.nativeAuth.clineNativeObservation.accountName, 'User cline-user-1');
});

test('rescanning an unchanged login is idempotent and does not rewrite the account', t => {
  const f = fixture(t);
  f.writeHost(providersDocument('cline-pass', clineAuth('cline-user-1', 1)));
  const sync = f.sync();
  const first = sync.scan();
  assert.equal(first.updated.length, 1);
  const before = f.records()[0];
  const second = sync.scan();
  assert.equal(second.updated.length, 0);
  assert.deepEqual(second.skipped, [], 'unchanged 不是跳过原因，界面不该报噪音');
  const after = f.records()[0];
  assert.equal(after.nativeAuthUpdatedAt, before.nativeAuthUpdatedAt, '没有新代际就不写库');
  assert.equal(f.records().length, 1, '同一身份只登记一次');
});

test('a credential rotated inside the account sandbox is adopted into the account library', t => {
  const f = fixture(t);
  f.writeHost(providersDocument('cline-pass', clineAuth('cline-user-1', 1)));
  const sync = f.sync();
  const accountRef = sync.scan().updated[0].accountRef;
  // 沙箱里 CLI 自己续期：签发时间前进、有效期延长。
  f.writeProjection(accountRef, providersDocument('cline-pass', clineAuth('cline-user-1', 5)));
  const result = sync.scan();
  assert.equal(result.updated.length, 1);
  assert.equal(result.updated[0].accountRef, accountRef);
  assert.equal(result.updated[0].created, false, '同一身份不新开账号');
  assert.equal(result.updated[0].reason, 'newer_token_issued_at');
  const [record] = f.records();
  assert.match(record.nativeAuth.auth.providers['cline-pass'].settings.auth.refreshToken, /-5$/);
  assert.equal(f.records().length, 1);
});

test('an older grant never downgrades the stored credential', t => {
  const f = fixture(t);
  f.writeHost(providersDocument('cline-pass', clineAuth('cline-user-1', 4)));
  const sync = f.sync();
  const accountRef = sync.scan().updated[0].accountRef;
  f.writeProjection(accountRef, providersDocument('cline-pass', clineAuth('cline-user-1', 1)));
  const result = sync.scan();
  assert.equal(result.updated.length, 0);
  assert.equal(result.skipped[0].reason, 'older_token_issued_at');
  assert.equal(result.skipped[0].provider, 'cline');
  assert.match(f.records()[0].nativeAuth.auth.providers['cline-pass'].settings.auth.refreshToken, /-4$/);
});


test('sources without a usable cline login are skipped with an explicit reason', t => {
  const f = fixture(t);
  const sync = f.sync();
  // 整库文档里只有别的 provider：不算 cline 凭据。
  f.writeHost({ version: '1', providers: { anthropic: { settings: { apiKey: 'sk-ant-x' } } } });
  assert.equal(sync.scan().skipped[0].reason, 'no_cline_credential');
  // 只有 API Key 槽位：自动入库只认 OAuth 登录态。
  f.writeHost({ version: '1', providers: { cline: { settings: { apiKey: 'cline-key' } } } });
  assert.equal(sync.scan().skipped[0].reason, 'api_key_only_source');
  // 已过期的登录态：不登记（否则账号一进来就是 auth-invalid）。
  f.writeHost(providersDocument('cline-pass', clineAuth('cline-user-1', -1000, { expiresAt: NOW - 1000 })));
  assert.equal(sync.scan().skipped[0].reason, 'credential_expired');
  // 文件损坏：报告可读原因，而不是静默跳过。
  f.writeHost('{ this is not json');
  assert.equal(sync.scan().skipped[0].reason, 'credential_file_unreadable');
  assert.equal(f.records().length, 0);
});

test('a deleted account is not resurrected by the observer', t => {
  const f = fixture(t);
  f.writeHost(providersDocument('cline-pass', clineAuth('cline-user-1', 1)));
  const accountRef = f.sync().scan().updated[0].accountRef;
  store.deleteAccountCredentials(fs, f.aiHomeDir, accountRef);
  deleteAccountRef(fs, f.aiHomeDir, accountRef);
  const result = f.sync().scan();
  assert.equal(result.updated.length, 0);
  assert.equal(result.skipped[0].reason, 'account_deleted_by_user');
  assert.equal(f.records().length, 0);
});

test('a second, different Cline login becomes its own account', t => {
  const f = fixture(t);
  f.writeHost(providersDocument('cline-pass', clineAuth('cline-user-1', 1)));
  const sync = f.sync();
  assert.equal(sync.scan().updated.length, 1);
  f.writeHost(providersDocument('cline-pass', clineAuth('cline-user-2', 1)));
  const second = sync.scan();
  assert.equal(second.updated.length, 1);
  assert.equal(second.updated[0].created, true);
  assert.equal(f.records().length, 2);
});

test('the periodic loop reports new accounts to the caller and stops cleanly', t => {
  const f = fixture(t);
  f.writeHost(providersDocument('cline-pass', clineAuth('cline-user-1', 1)));
  const ticks = [];
  let cleared = 0;
  const sync = createClineNativeCredentialSync({
    fs,
    aiHomeDir: f.aiHomeDir,
    hostHomeDir: f.hostHomeDir,
    now: () => NOW,
    setInterval: (fn) => { ticks.push(fn); return { unref() {} }; },
    clearInterval: () => { cleared += 1; }
  });
  const notified = [];
  sync.start({ intervalMs: 3000, onUpdated: events => notified.push(...events) });
  assert.equal(notified.length, 1, 'start() 立刻跑一轮，不等第一个 interval');
  assert.equal(notified[0].created, true);
  assert.equal(sync.getStats().updated, 1);
  // 同一代际的第二轮不再通知（否则账号池会被无意义地反复重载）。
  ticks[0]();
  assert.equal(notified.length, 1);
  assert.equal(sync.getStats().updated, 0, '第二轮没有新代际');
  assert.equal(sync.getStats().pending, 0);
  sync.stop();
  assert.equal(cleared, 1);
});


test('on-demand detection reports what it registered and refuses incomplete inputs', t => {
  const f = fixture(t);
  f.writeHost(providersDocument('cline-pass', clineAuth('cline-user-1', 1)));
  const first = detectHostClineAccounts({ fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.hostHomeDir });
  assert.equal(first.ok, true);
  assert.equal(first.updated, 1);
  assert.equal(first.accounts.cline, 1);
  assert.deepEqual(first.registered.map(item => item.created), [true]);
  const second = detectHostClineAccounts({ fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.hostHomeDir });
  assert.equal(second.updated, 0);
  assert.equal(second.accounts.cline, 1);
  assert.equal(detectHostClineAccounts({ fs }).ok, false);
});

test('credential comparison prefers the newer generation and refuses ambiguity', () => {
  const older = providersDocument('cline-pass', clineAuth('cline-user-1', 1));
  const newer = providersDocument('cline-pass', clineAuth('cline-user-1', 3));
  assert.deepEqual(compareClineCredentialDocuments(older, newer, { nowMs: NOW }),
    { adopt: true, reason: 'newer_token_issued_at' });
  assert.deepEqual(compareClineCredentialDocuments(newer, older, { nowMs: NOW }),
    { adopt: false, reason: 'older_token_issued_at' });
  assert.deepEqual(compareClineCredentialDocuments(newer, newer, { nowMs: NOW }),
    { adopt: false, reason: 'unchanged' });
  assert.deepEqual(compareClineCredentialDocuments(null, newer, { nowMs: NOW }),
    { adopt: true, reason: 'database_credentials_missing' });
  // iat 解不出来（非 JWT 形态）时退到 expiresAt：更长有效期即更新的一代。
  const noJwt = providersDocument('cline-pass', {
    accessToken: 'opaque-token', refreshToken: 'r-1', expiresAt: String(NOW + 60000)
  });
  const longer = providersDocument('cline-pass', {
    accessToken: 'opaque-token-2', refreshToken: 'r-2', expiresAt: String(NOW + 120000)
  });
  assert.equal(readClineTokenIssuedAtMs(noJwt), 0);
  assert.deepEqual(compareClineCredentialDocuments(noJwt, longer, { nowMs: NOW }),
    { adopt: true, reason: 'newer_expires_at' });
  // 两边都无法比较代际：宁可漏采也不误采。
  const unknownA = providersDocument('cline-pass', { accessToken: 'a', refreshToken: 'ra' });
  const unknownB = providersDocument('cline-pass', { accessToken: 'b', refreshToken: 'rb' });
  assert.deepEqual(compareClineCredentialDocuments(unknownA, unknownB, { nowMs: NOW }),
    { adopt: false, reason: 'credential_time_ambiguous' });
  assert.equal(resolveClineAccountName(newer), 'User cline-user-1');
});
