'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildGrokIdentitySeed, buildLegacyGrokIdentitySeed } = require('../lib/account/grok-identity');
const { resolveNativeAuthIdentitySeed, resolveIdentitySeedFromAccount } = require('../lib/account/account-identity');
const { buildOAuthIdentity, extractOAuthEmail } = require('../lib/account/transfer-core');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const store = require('../lib/server/account-credential-store');
const { registerProviderAuthProjection, captureProviderAuth } = require('../lib/account/native-auth-projection');
const { writeDefaultAccountRef, readDefaultAccountRef } = require('../lib/account/default-account-store');
const { planOAuthIdentityRekey, applyOAuthIdentityRekey } = require('../lib/cli/services/account/codex-identity-rekey');
const { parseArgs } = require('../scripts/oauth-identity-rekey');
const digest = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const profile = (user = 'fixture-user', email = 'before@example.invalid') => ({ key: 'fixture-key', refresh_token: 'fixture-refresh', user_id: user, email });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-identity-'));
  const login = path.join(root, 'external-login'); fs.mkdirSync(path.join(login, '.grok'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const write = auth => fs.writeFileSync(path.join(login, '.grok/auth.json'), JSON.stringify(auth));
  const registerLegacy = (auth, seed) => {
    const native = { auth };
    const identitySeed = seed || buildLegacyGrokIdentitySeed(auth, extractOAuthEmail('grok', native));
    const ref = registerAccountIdentity(fs, aiHomeDir, { provider: 'grok', identitySeed }).accountRef;
    store.writeAccountNativeAuth(fs, aiHomeDir, ref, native); return ref;
  };
  return { aiHomeDir, login, write, registerLegacy };
}

test('Grok byte vector excludes email and rotating credentials, matching all registration surfaces', () => {
  const auth = profile(), expected = `oauth:grok:auth:${digest('id:fixture-user')}`;
  assert.equal(buildGrokIdentitySeed(auth), expected);
  assert.equal(buildGrokIdentitySeed({ ...auth, email: 'after@example.invalid', key: 'new', refresh_token: 'new-refresh' }), expected);
  assert.equal(resolveNativeAuthIdentitySeed('grok', { auth }).identitySeed, expected);
  assert.equal(buildOAuthIdentity('grok', auth), expected);
  assert.equal(resolveIdentitySeedFromAccount({ provider: 'grok', email: 'display-only@example.invalid' }).identitySeed, '');
});

test('equivalent native profile grants and key ordering do not create another identity', () => {
  const one = profile(), two = { ...profile(), key: 'second-grant' };
  assert.equal(buildGrokIdentitySeed({ b: one, a: two }), buildGrokIdentitySeed(one));
  assert.equal(buildGrokIdentitySeed({ b: profile('other'), a: one }), buildGrokIdentitySeed({ a: one, b: profile('other') }));
});

for (const auth of [{ key: 'token', email: 'only-email@example.invalid' }, { ...profile(), userId: 'different' },
  { ...profile(), user_id: ' spaced ' }, { ...profile(), user_id: 'injected:id' },
  { valid: profile(), unknown: { key: 'token-only' } }]) test('unverifiable or conflicting Grok identity is rejected', () => {
  assert.equal(buildGrokIdentitySeed(auth), '');
  assert.equal(resolveNativeAuthIdentitySeed('grok', { auth }).degraded, true);
});

test('same-user reauthentication preserves the legacy accountRef when display email changes', t => {
  const f = fixture(t), old = profile(), ref = f.registerLegacy(old);
  writeDefaultAccountRef(fs, f.aiHomeDir, 'grok', ref);
  const fresh = { ...old, email: 'after@example.invalid', key: 'new-credential' }; f.write(fresh);
  const result = registerProviderAuthProjection(fs, f.login, 'grok', { aiHomeDir: f.aiHomeDir });
  assert.equal(result.registered, true); assert.equal(result.accountRef, ref);
  assert.equal(readDefaultAccountRef(fs, f.aiHomeDir, 'grok'), ref);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth, fresh);
  assert.equal(store.listAccountCredentialRecords(fs, f.aiHomeDir, 'grok').length, 1);
});

test('native capture never writes a different Grok user into the selected account', t => {
  const f = fixture(t), old = profile(), ref = f.registerLegacy(old); f.write(profile('other-user'));
  const result = captureProviderAuth(fs, f.login, 'grok', { aiHomeDir: f.aiHomeDir, accountRef: ref });
  assert.equal(result.captured, false); assert.equal(result.reason, 'account_identity_mismatch');
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth, old);
});

test('two existing records for a native user require explicit resolution rather than picking the first', t => {
  const f = fixture(t), auth = profile();
  f.registerLegacy(auth, 'oauth:grok:old-one'); f.registerLegacy(auth, 'oauth:grok:old-two'); f.write(auth);
  const result = registerProviderAuthProjection(fs, f.login, 'grok', { aiHomeDir: f.aiHomeDir });
  assert.equal(result.registered, false); assert.equal(result.reason, 'ambiguous_existing_identity');
});

for (const nested of [false, true]) test(`parameterized Grok ledger migrates the exact old vector and default (${nested ? 'profiles' : 'direct'})`, t => {
  const f = fixture(t), auth = nested ? { 'https://auth.x.ai::fixture': profile() } : profile();
  const ref = f.registerLegacy(auth); writeDefaultAccountRef(fs, f.aiHomeDir, 'grok', ref);
  const { ledger } = planOAuthIdentityRekey({ fs, aiHomeDir: f.aiHomeDir, provider: 'grok' });
  assert.equal(ledger.provider, 'grok'); assert.equal(ledger.summary.migrate, 1);
  const result = applyOAuthIdentityRekey({ fs, aiHomeDir: f.aiHomeDir, ledger });
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.equal(readDefaultAccountRef(fs, f.aiHomeDir, 'grok'), ledger.entries[0].new_account_ref);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ledger.entries[0].new_account_ref).auth, auth);
});

test('CLI requires an explicit supported migration Provider and does not accept arbitrary vectors', () => {
  assert.equal(parseArgs(['--provider', 'grok']).provider, 'grok');
  assert.equal(parseArgs([]).provider, 'codex');
  assert.throws(() => parseArgs(['--provider', 'kiro']), /unsupported_identity_rekey_provider/);
});
