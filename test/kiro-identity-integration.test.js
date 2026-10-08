'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createUnifiedImportService } = require('../lib/cli/services/import/unified-import');
const { listAccountCredentialRecords, readAccountNativeAuth } = require('../lib/server/account-credential-store');
const { registerKiroNativeLogin, captureKiroNativeLogin } = require('../lib/account/kiro-native-login');
const { materializeProviderAuth } = require('../lib/account/native-auth-projection');
const { readKiroTokenFromDatabase } = require('../lib/account/kiro-auth-metadata');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-enroll-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source/kiro/first'); fs.mkdirSync(source, { recursive: true });
  const aiHomeDir = path.join(root, 'aih');
  const file = path.join(source, 'data.sqlite3');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE auth_kv(key TEXT PRIMARY KEY,value TEXT)'); db.close();
  const write = (access, refresh) => {
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO auth_kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('kirocli:odic:token', JSON.stringify({ access_token: access, refresh_token: refresh, region: 'us-east-1' }));
    db.close();
  };
  write('first-access', 'first-refresh');
  return { root, source, aiHomeDir, file, write };
}

const requestFor = userId => async () => new Response(JSON.stringify({ userInfo: { userId, email: 'not-stored@example.invalid' } }));

test('Kiro native login and renewal keep the original accountRef; another user never overwrites it', async t => {
  const f = fixture(t);
  const first = await registerKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, request: requestFor('aws-user-A') });
  assert.equal(first.registered, true);
  f.write('second-access', 'second-refresh');
  const capture = await captureKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, accountRef: first.accountRef, request: requestFor('aws-user-A') });
  assert.equal(capture.captured, true);
  assert.equal(readAccountNativeAuth(fs, f.aiHomeDir, first.accountRef).auth.access_token, 'second-access');
  const again = await registerKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, request: requestFor('aws-user-A') });
  assert.equal(again.accountRef, first.accountRef);
  f.write('foreign-access', 'foreign-refresh');
  const foreign = await captureKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, accountRef: first.accountRef, request: requestFor('aws-user-B') });
  assert.equal(foreign.reason, 'account_identity_mismatch');
  assert.equal(readAccountNativeAuth(fs, f.aiHomeDir, first.accountRef).auth.access_token, 'second-access');
});

test('Kiro unified import enriches identity before enrollment; dry-run makes no network call', async t => {
  const f = fixture(t);
  let calls = 0;
  const service = createUnifiedImportService({
    fs, path, os, fse: require('fs-extra'), cryptoImpl: crypto,
    processImpl: { platform: process.platform }, aiHomeDir: f.aiHomeDir,
    cliConfigs: { kiro: {} }, execSync() {},
    kiroIdentityRequest: async (...args) => { calls++; return requestFor('aws-import-user')(...args); }
  });
  const before = fs.readFileSync(f.file);
  const dry = await service.runUnifiedImport(['kiro', path.join(f.root, 'source'), '--dry-run'], { log() {}, error() {} });
  assert.equal(calls, 0);
  assert.equal(listAccountCredentialRecords(fs, f.aiHomeDir, 'kiro').length, 0);
  assert.equal(dry.dryRun, true);
  const result = await service.runUnifiedImport(['kiro', path.join(f.root, 'source')], { log() {}, error() {} });
  assert.equal(result.failedSources.length, 0, JSON.stringify(result.failedSources));
  assert.equal(calls, 1);
  const rows = listAccountCredentialRecords(fs, f.aiHomeDir, 'kiro');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nativeAuth.identityEvidence.subject, 'aws-import-user');
  assert.deepEqual(fs.readFileSync(f.file), before, 'reading/enrichment must not rewrite native SQLite');
});

test('Kiro failure and cancellation leave no half-registered account', async t => {
  const f = fixture(t);
  const failed = await registerKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, request: async () => new Response('private error', { status: 403 }) });
  assert.equal(failed.registered, false);
  assert.equal(failed.reason, 'kiro_identity_access_denied');
  assert.equal(listAccountCredentialRecords(fs, f.aiHomeDir, 'kiro').length, 0);
  const controller = new AbortController(); controller.abort();
  const cancelled = await registerKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, signal: controller.signal,
    request: async (_url, options) => { options.signal.throwIfAborted(); }
  });
  assert.equal(cancelled.reason, 'kiro_identity_cancelled');
  assert.equal(listAccountCredentialRecords(fs, f.aiHomeDir, 'kiro').length, 0);
});

test('Kiro enrollment persists the authorized token committed in WAL, even while the native database remains open', async t => {
  const f = fixture(t);
  const writer = new DatabaseSync(f.file);
  t.after(() => writer.close());
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  writer.prepare('UPDATE auth_kv SET value = ? WHERE key = ?').run(
    JSON.stringify({ access_token: 'wal-access', refresh_token: 'wal-refresh', region: 'us-east-1' }),
    'kirocli:odic:token'
  );
  const mainBefore = fs.readFileSync(f.file);
  const registered = await registerKiroNativeLogin(fs, f.source, {
    aiHomeDir: f.aiHomeDir, request: requestFor('aws-wal-user')
  });
  assert.equal(registered.registered, true, registered.reason);
  const restored = path.join(f.root, 'restored');
  materializeProviderAuth(fs, restored, 'kiro', { aiHomeDir: f.aiHomeDir, accountRef: registered.accountRef });
  assert.equal(readKiroTokenFromDatabase(path.join(restored, 'data.sqlite3')).access_token, 'wal-access');
  assert.deepEqual(fs.readFileSync(f.file), mainBefore, 'snapshotting must not rewrite the active native database');
});

test('Kiro credential reprojection preserves live account sessions and updates only auth records', async t => {
  const f = fixture(t);
  const registered = await registerKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, request: requestFor('aws-session-user') });
  const runtimeDir = path.join(f.root, 'account-runtime');
  const options = { aiHomeDir: f.aiHomeDir, accountRef: registered.accountRef };
  materializeProviderAuth(fs, runtimeDir, 'kiro', options);
  const runtime = new DatabaseSync(path.join(runtimeDir, 'data.sqlite3'));
  t.after(() => runtime.close());
  runtime.exec("CREATE TABLE conversations_v2(id TEXT PRIMARY KEY, value TEXT); INSERT INTO conversations_v2 VALUES('live-session', 'keep-me')");
  f.write('renewed-access', 'renewed-refresh');
  await captureKiroNativeLogin(fs, f.source, {
    aiHomeDir: f.aiHomeDir, accountRef: registered.accountRef, request: requestFor('aws-session-user')
  });
  materializeProviderAuth(fs, runtimeDir, 'kiro', options);
  const reread = new DatabaseSync(path.join(runtimeDir, 'data.sqlite3'));
  t.after(() => reread.close());
  assert.equal(reread.prepare('SELECT value FROM conversations_v2 WHERE id = ?').get('live-session').value, 'keep-me');
  assert.equal(readKiroTokenFromDatabase(path.join(runtimeDir, 'data.sqlite3')).access_token, 'renewed-access');
});

test('a second Kiro launch preserves native token renewal until a new stored grant is explicitly applied', async t => {
  const f = fixture(t);
  const registered = await registerKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, request: requestFor('aws-native-renewal-user') });
  const runtimeDir = path.join(f.root, 'runtime');
  const options = { aiHomeDir: f.aiHomeDir, accountRef: registered.accountRef };
  materializeProviderAuth(fs, runtimeDir, 'kiro', options);
  const file = path.join(runtimeDir, 'data.sqlite3');
  const db = new DatabaseSync(file);
  db.prepare('UPDATE auth_kv SET value = ? WHERE key = ?').run(
    JSON.stringify({ access_token: 'native-renewed-access', refresh_token: 'native-renewed-refresh', region: 'us-east-1' }),
    'kirocli:odic:token'
  );
  db.close();
  materializeProviderAuth(fs, runtimeDir, 'kiro', options);
  assert.equal(readKiroTokenFromDatabase(file).access_token, 'native-renewed-access');
});

test('Kiro projection fails closed for unknown existing database content without replacing it', async t => {
  const f = fixture(t);
  const registered = await registerKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, request: requestFor('aws-projection-user') });
  const runtimeDir = path.join(f.root, 'runtime');
  fs.mkdirSync(runtimeDir);
  const file = path.join(runtimeDir, 'data.sqlite3');
  fs.writeFileSync(file, 'unrecognized-content');
  assert.throws(() => materializeProviderAuth(fs, runtimeDir, 'kiro', { aiHomeDir: f.aiHomeDir, accountRef: registered.accountRef }), /kiro_database_credential_projection_failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unrecognized-content');
});

test('a late Kiro identity response cannot replace a newer DB credential generation', async t => {
  const f = fixture(t);
  const first = await registerKiroNativeLogin(fs, f.source, { aiHomeDir: f.aiHomeDir, request: requestFor('aws-user-A') });
  const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
  f.write('old-inflight-access', 'old-inflight-refresh');
  let latest;
  const result = await captureKiroNativeLogin(fs, f.source, {
    aiHomeDir: f.aiHomeDir, accountRef: first.accountRef,
    request: async () => {
      latest = { ...readAccountNativeAuth(fs, f.aiHomeDir, first.accountRef), newerExternalWrite: true };
      writeAccountNativeAuth(fs, f.aiHomeDir, first.accountRef, latest);
      return requestFor('aws-user-A')();
    }
  });
  assert.equal(result.captured, false);
  assert.equal(result.reason, 'concurrent_credential_update');
  assert.deepEqual(readAccountNativeAuth(fs, f.aiHomeDir, first.accountRef), latest);
});
