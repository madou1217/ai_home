'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { credential } = require('./helpers/codebuddy-credential');
const { inspectCodebuddyCredential, compareCodebuddyCredentials, codebuddyCredentialPaths,
  readCodebuddyCredentialFile, selectCodebuddyCredential } = require('../lib/account/codebuddy-credential-source');
const { readProviderAuthProjection, registerProviderAuthProjection, captureProviderAuth,
  materializeProviderAuth } = require('../lib/account/native-auth-projection');
const { adoptCodebuddyCredential, createCodebuddyNativeCredentialSync } = require('../lib/account/codebuddy-credential-sync');
const store = require('../lib/server/account-credential-store');
const { deleteAccountRef } = require('../lib/server/account-ref-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { createCodebuddyQuotaProbe } = require('../lib/cli/services/usage/codebuddy-quota-probe');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-family-source-')), aiHomeDir = path.join(home, '.ai_home');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (provider, value, root = home, index = 0) => {
    const file = codebuddyCredentialPaths(root, provider)[index];
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file;
  };
  const adopt = (provider, value, options) => adoptCodebuddyCredential(fs, aiHomeDir, provider, value, options);
  return { home, aiHomeDir, write, adopt };
}
const now = Math.floor(Date.now() / 1000), older = now - 120, newer = now - 30;

test('a standalone CN filename is discovered only when its issuer proves CN', t => {
  const f = fixture(t); f.write('codebuddycn', credential('codebuddycn'), f.home, 1);
  assert.ok(readProviderAuthProjection(fs, f.home, 'codebuddycn').credentials);
  assert.equal(readProviderAuthProjection(fs, f.home, 'codebuddy').credentials, undefined);
  const result = registerProviderAuthProjection(fs, f.home, 'codebuddycn', { aiHomeDir: f.aiHomeDir });
  assert.equal(result.registered, true);
  const runtime = resolveAccountRuntimeDir(f.aiHomeDir, 'codebuddycn', result.accountRef);
  assert.equal(materializeProviderAuth(fs, runtime, 'codebuddycn', { aiHomeDir: f.aiHomeDir, accountRef: result.accountRef }).missing, false);
  assert.ok(fs.existsSync(codebuddyCredentialPaths(runtime, 'codebuddycn')[1]));
});

test('international CodeBuddy and WorkBuddy with the same UID cannot exchange grants', () => {
  assert.equal(inspectCodebuddyCredential(credential('codebuddy'), 'workbuddy').reason, 'credential_realm_mismatch');
  assert.equal(inspectCodebuddyCredential(credential('workbuddy'), 'codebuddycn').reason, 'credential_realm_mismatch');
});

test('invalid domain and conflicting user IDs cannot be captured', () => {
  const c = credential('codebuddycn'); c.auth.domain = 'www.codebuddy.ai';
  assert.equal(inspectCodebuddyCredential(c, 'codebuddycn').reason, 'credential_domain_mismatch');
  c.auth.domain = 'www.workbuddy.cn'; c.account.uid = 'different-user';
  assert.equal(inspectCodebuddyCredential(c, 'codebuddycn').reason, 'credential_identity_mismatch');
});

test('newest credential generation wins; a file copy or same-time different token does not', t => {
  const f = fixture(t), a = credential('codebuddycn', { iat: older }), b = credential('codebuddycn', { iat: newer });
  const result = f.adopt('codebuddycn', a);
  const file = f.write('codebuddycn', b);
  assert.equal(f.adopt('codebuddycn', b, { accountRef: result.accountRef }).updated, true);
  fs.utimesSync(file, new Date(), new Date());
  assert.equal(f.adopt('codebuddycn', a, { accountRef: result.accountRef }).reason, 'older_credential');
  assert.equal(f.adopt('codebuddycn', credential('codebuddycn', { iat: newer, marker: 'different' }), { accountRef: result.accountRef }).reason, 'credential_time_ambiguous');
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, result.accountRef).credentials, b);
});

test('another user completing a scoped login never overwrites the previous account', t => {
  const f = fixture(t), old = f.adopt('codebuddycn', credential('codebuddycn', { uid: 'first' }));
  const runtime = path.join(f.home, 'login'); f.write('codebuddycn', credential('codebuddycn', { uid: 'second' }), runtime, 1);
  assert.equal(captureProviderAuth(fs, runtime, 'codebuddycn', { aiHomeDir: f.aiHomeDir, accountRef: old.accountRef }).captured, false);
  assert.equal(store.readAccountNativeAuth(fs, f.aiHomeDir, old.accountRef).credentials.account.uid, 'first');
});

test('projection adopts the native renewal before writing, never rolling it back', t => {
  const f = fixture(t), a = credential('codebuddycn', { iat: older }), b = credential('codebuddycn', { iat: newer });
  const record = f.adopt('codebuddycn', a), runtime = resolveAccountRuntimeDir(f.aiHomeDir, 'codebuddycn', record.accountRef);
  const file = f.write('codebuddycn', b, runtime);
  assert.equal(materializeProviderAuth(fs, runtime, 'codebuddycn', { aiHomeDir: f.aiHomeDir, accountRef: record.accountRef }).missing, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).auth, b.auth);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, record.accountRef).credentials, b);
});

test('unknown, future, expired and incomplete credentials cannot create new accounts', t => {
  const f = fixture(t);
  for (const c of [credential('codebuddy', { iat: now + 600 }), credential('codebuddy', { iat: now - 7200 }),
    { ...credential('codebuddy'), auth: { accessToken: 'opaque', domain: 'www.codebuddy.ai' } }]) {
    assert.equal(f.adopt('codebuddy', c).updated, false);
  }
  assert.equal(store.listAccountCredentialRecords(fs, f.aiHomeDir, 'codebuddy').length, 0);
});

test('regular-file, read-stability and size guards reject unsafe credential sources', t => {
  const f = fixture(t), file = f.write('codebuddy', credential('codebuddy'));
  fs.symlinkSync(file, file + '.link');
  assert.equal(readCodebuddyCredentialFile(fs, file + '.link').ok, false);
  let reads = 0;
  const raced = { ...fs, lstatSync: target => { const stat = fs.lstatSync(target); if (++reads > 1) stat.mtimeMs += 1; return stat; } };
  assert.equal(readCodebuddyCredentialFile(raced, file).reason, 'credential_file_changed');
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
  assert.equal(readCodebuddyCredentialFile(fs, file).ok, false);
});

test('independent App login updates existing CN peer but never a different international authorization', t => {
  const f = fixture(t), old = credential('codebuddycn', { iat: older }), fresh = credential('codebuddycn', { iat: newer });
  const code = f.adopt('codebuddycn', old), global = f.adopt('codebuddy', credential('codebuddy', { iat: older }));
  f.write('workbuddycn', fresh);
  const sync = createCodebuddyNativeCredentialSync({ fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.home });
  const result = sync.scan(); assert.equal(result.updated.length, 2);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, code.accountRef).credentials, fresh);
  assert.equal(store.readAccountNativeAuth(fs, f.aiHomeDir, global.accountRef).credentials.auth.domain, 'www.codebuddy.ai');
  assert.equal(sync.scan().updated.length, 0);
});

test('deleted accounts are not recreated from persistent App files, including after observer restart', t => {
  const f = fixture(t), c = credential('codebuddy'); f.write('codebuddy', c);
  let sync = createCodebuddyNativeCredentialSync({ fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.home });
  const first = sync.scan(); const ref = first.updated[0].accountRef;
  store.deleteAccountCredentials(fs, f.aiHomeDir, ref); deleteAccountRef(fs, f.aiHomeDir, ref);
  sync = createCodebuddyNativeCredentialSync({ fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.home });
  assert.equal(sync.scan().skipped[0].reason, 'account_deleted_by_user');
  assert.equal(store.listAccountCredentialRecords(fs, f.aiHomeDir, 'codebuddy').length, 0);
  assert.equal(f.adopt('codebuddy', c).registered, true);
});

test('observer retries failed runtime notifications and stops its timer', t => {
  const f = fixture(t); f.write('codebuddy', credential('codebuddy'));
  let tick, cleared = false, calls = 0;
  const sync = createCodebuddyNativeCredentialSync({ fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.home,
    setInterval: callback => { tick = callback; return 1; }, clearInterval: () => { cleared = true; } });
  sync.start({ onUpdated: () => { calls++; if (calls === 1) throw new Error('retry'); } });
  assert.equal(sync.getStats().pending, 1); tick(); assert.equal(calls, 2); assert.equal(sync.getStats().pending, 0);
  sync.stop(); tick(); assert.equal(cleared, true); assert.equal(calls, 2);
});

test('quota works from DB without a launched projection and never adopts another logged-in user', async t => {
  const f = fixture(t), c = credential('codebuddy'), a = f.adopt('codebuddy', c);
  f.write('codebuddy', credential('codebuddy', { uid: 'another-user' }));
  const calls = [];
  const probe = createCodebuddyQuotaProbe({ fs, aiHomeDir: f.aiHomeDir, readAccountCredentialRecord: store.readAccountCredentialRecord,
    processObj: { env: { HOME: f.home } },
    fetchWithTimeout: async (_url, init) => { calls.push(init); return { ok: true, json: async () => ({ code: 0, data: { Packages: [{ CycleTotalCapacity: '100', CycleRemainCapacity: '50' }] } }) }; } });
  assert.ok((await probe.probe(a.accountRef)).snapshot);
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + c.auth.accessToken);
  assert.equal(calls[0].headers['X-User-Id'], c.account.uid);
});

test('an old probe cannot publish usage or authentication failure after a newer login wins', async t => {
  const f = fixture(t), old = credential('codebuddy', { iat: older }), fresh = credential('codebuddy', { iat: newer });
  const a = f.adopt('codebuddy', old);
  const probe = createCodebuddyQuotaProbe({ fs, aiHomeDir: f.aiHomeDir, readAccountCredentialRecord: store.readAccountCredentialRecord,
    fetchWithTimeout: async () => { f.adopt('codebuddy', fresh, { accountRef: a.accountRef }); return { ok: false, status: 401, json: async () => ({}) }; } });
  const result = await probe.probe(a.accountRef);
  assert.equal(result.error, 'credential_changed_during_probe'); assert.notEqual(result.auth, true);
});


test('native renewal preserves an existing legacy accountRef instead of creating a duplicate', t => {
  const f = fixture(t), old = credential('codebuddy', { iat: older }), fresh = credential('codebuddy', { iat: newer });
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const legacy = registerAccountIdentity(fs, f.aiHomeDir, { provider: 'codebuddy', identitySeed: 'oauth:codebuddy:legacy-fixture' }).accountRef;
  store.writeAccountNativeAuth(fs, f.aiHomeDir, legacy, { credentials: old });
  const result = f.adopt('codebuddy', fresh);
  assert.equal(result.accountRef, legacy); assert.equal(result.updated, true);
  assert.equal(store.listAccountCredentialRecords(fs, f.aiHomeDir, 'codebuddy').length, 1);
});

test('an empty wrong-provider target cannot receive a CodeBuddy grant', t => {
  const f = fixture(t);
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const other = registerAccountIdentity(fs, f.aiHomeDir, { provider: 'codex', identitySeed: 'oauth:codex:fixture-other' }).accountRef;
  const result = f.adopt('codebuddy', credential('codebuddy'), { accountRef: other });
  assert.equal(result.reason, 'account_provider_mismatch');
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, other), {});
});

test('deleting a legacy family account also suppresses its canonical native observation', t => {
  const f = fixture(t), c = credential('codebuddy');
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const legacy = registerAccountIdentity(fs, f.aiHomeDir, { provider: 'codebuddy', identitySeed: 'oauth:codebuddy:legacy-delete' }).accountRef;
  store.writeAccountNativeAuth(fs, f.aiHomeDir, legacy, { credentials: c });
  deleteAccountRef(fs, f.aiHomeDir, legacy);
  assert.throws(() => f.adopt('codebuddy', c, { automatic: true }), /account_deleted_by_user/);
});
