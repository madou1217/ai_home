'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { credential } = require('./helpers/codebuddy-credential');
const { transformWorkbuddyCredentials, decodeWorkbuddyCredential } = require('../lib/account/workbuddy-credential-codec');
const { readCodebuddyCredentialFile, codebuddyCredentialPaths } = require('../lib/account/codebuddy-credential-source');
const { adoptCodebuddyCredential, createCodebuddyNativeCredentialSync } = require('../lib/account/codebuddy-credential-sync');
const { materializeProviderAuth } = require('../lib/account/native-auth-projection');
const { readAccountNativeAuth } = require('../lib/server/account-credential-store');
const { resolveAccountRuntimeDir, resolveAccountCliRuntimeDir } = require('../lib/runtime/aih-storage-layout');

// Public fixture key, never the installed vendor's native encryption key.
const key = { version: 1, atRestSecretKey: Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64') };
const encode = value => transformWorkbuddyCredentials(value, 'encode', key);
function codecOptions(onRun = () => {}) {
  return { vendorElectron: '/fixture/vendor-electron', execFileSync(command, args, options) {
    assert.equal(command, '/fixture/vendor-electron');
    assert.equal(path.basename(args[0]), 'aih-workbuddy-credential-codec.cjs');
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
    const request = JSON.parse(options.input);
    onRun(request.operation);
    return JSON.stringify(transformWorkbuddyCredentials(request.value, request.operation, key));
  } };
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-codec-'));
  const aiHomeDir = path.join(home, '.ai_home');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, aiHomeDir, write(root, provider, value) {
    const file = codebuddyCredentialPaths(root, provider)[0];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  } };
}

test('plaintext credentials do not require or invoke the vendor runtime', () => {
  const value = credential('workbuddy');
  const result = decodeWorkbuddyCredential(value, 'workbuddy', { execFileSync: () => assert.fail('unexpected codec') });
  assert.deepEqual(result, { credential: value, encrypted: false });
});

test('WorkBuddy field encryption preserves public metadata and all token fields', () => {
  const value = credential('workbuddy');
  value.auth.idToken = 'public-fixture-id-token';
  const original = structuredClone(value);
  const encrypted = encode(value);
  assert.deepEqual(value, original, 'input credential must not be mutated');
  assert.deepEqual(encrypted.account, value.account);
  assert.equal(encrypted.auth.domain, value.auth.domain);
  for (const field of ['accessToken', 'refreshToken', 'idToken']) {
    assert.equal(encrypted.auth[field].$wbEncrypted, 1);
    assert.ok(!JSON.stringify(encrypted).includes(value.auth[field]));
  }
  assert.deepEqual(transformWorkbuddyCredentials(encrypted, 'decode', key), value);
  assert.notEqual(encode(value).auth.accessToken.envelope, encrypted.auth.accessToken.envelope, 'fresh nonces are required');
});

test('wrong keys, altered tags and unsupported envelopes are rejected without plaintext fallback', () => {
  const encrypted = encode(credential('workbuddy'));
  const otherKey = { ...key, atRestSecretKey: Buffer.alloc(32, 42).toString('base64') };
  assert.throws(() => transformWorkbuddyCredentials(encrypted, 'decode', otherKey));
  for (const change of [envelope => { envelope.suite = 2; }, envelope => {
    const tag = Buffer.from(envelope.authTag, 'base64'); tag[0] ^= 1; envelope.authTag = tag.toString('base64');
  }, envelope => { envelope.keyblob = 'unsupported'; }]) {
    const value = structuredClone(encrypted);
    const envelope = JSON.parse(Buffer.from(value.auth.accessToken.envelope, 'base64'));
    change(envelope);
    value.auth.accessToken.envelope = Buffer.from(JSON.stringify(envelope)).toString('base64');
    assert.throws(() => transformWorkbuddyCredentials(value, 'decode', key));
  }
});

test('unchanged encrypted credentials reuse the vendor result through private pipes', () => {
  const value = credential('workbuddy'), encrypted = encode(value);
  let calls = 0;
  const options = codecOptions(() => { calls += 1; });
  assert.deepEqual(decodeWorkbuddyCredential(encrypted, 'workbuddy', options).credential, value);
  assert.deepEqual(decodeWorkbuddyCredential(encrypted, 'workbuddy', options).credential, value);
  assert.equal(calls, 1);
});

for (const provider of ['workbuddy', 'workbuddycn']) {
  test(`${provider} decrypts before validating realm and UID, retaining those identity guards`, t => {
    const f = fixture(t), value = credential(provider), options = codecOptions();
    const file = f.write(f.home, provider, encode(value));
    const read = () => readCodebuddyCredentialFile(fs, file, provider, Date.now(), options);
    assert.equal(read().ok, true);
    assert.equal(read().encrypted, true);
    assert.deepEqual(read().credential, value);
    f.write(f.home, provider, encode(credential('codebuddy')));
    assert.equal(read().reason, 'credential_realm_mismatch');
    const differentUid = credential(provider); differentUid.account.uid = 'another-user';
    f.write(f.home, provider, encode(differentUid));
    assert.equal(read().reason, 'credential_identity_mismatch');
  });

  test(`${provider} updates an encrypted desktop projection without downgrading its storage`, t => {
    const f = fixture(t), now = Math.floor(Date.now() / 1000);
    const old = credential(provider, { iat: now - 120 }), fresh = credential(provider, { iat: now - 30 });
    const account = adoptCodebuddyCredential(fs, f.aiHomeDir, provider, old);
    const runtime = resolveAccountRuntimeDir(f.aiHomeDir, provider, account.accountRef);
    const encrypted = encode(old), file = f.write(runtime, provider, encrypted);
    const options = { ...codecOptions(), aiHomeDir: f.aiHomeDir, accountRef: account.accountRef };
    assert.equal(materializeProviderAuth(fs, runtime, provider, options).missing, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), encrypted, 'unchanged ciphertext should be retained');
    assert.equal(adoptCodebuddyCredential(fs, f.aiHomeDir, provider, fresh, { accountRef: account.accountRef }).updated, true);
    assert.equal(materializeProviderAuth(fs, runtime, provider, options).missing, false);
    const updated = JSON.parse(fs.readFileSync(file));
    assert.equal(updated.auth.accessToken.$wbEncrypted, 1);
    assert.deepEqual(transformWorkbuddyCredentials(updated, 'decode', key), fresh);
  });

  test(`${provider} credential observation includes renewals from its separate CLI home`, t => {
    const f = fixture(t), now = Math.floor(Date.now() / 1000);
    const old = credential(provider, { iat: now - 120 }), fresh = credential(provider, { iat: now - 30 });
    const account = adoptCodebuddyCredential(fs, f.aiHomeDir, provider, old);
    f.write(resolveAccountRuntimeDir(f.aiHomeDir, provider, account.accountRef), provider, encode(old));
    f.write(resolveAccountCliRuntimeDir(f.aiHomeDir, provider, account.accountRef), provider, fresh);
    const sync = createCodebuddyNativeCredentialSync({ fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.home, ...codecOptions() });
    assert.equal(sync.scan().updated.some(item => item.accountRef === account.accountRef), true);
    assert.deepEqual(readAccountNativeAuth(fs, f.aiHomeDir, account.accountRef).credentials, fresh);
    assert.equal(sync.scan().updated.length, 0);
  });
}

test('unavailable encrypted credential decoding leaves the desktop file intact', t => {
  const f = fixture(t), value = credential('workbuddy');
  const account = adoptCodebuddyCredential(fs, f.aiHomeDir, 'workbuddy', value);
  const runtime = resolveAccountRuntimeDir(f.aiHomeDir, 'workbuddy', account.accountRef);
  const file = f.write(runtime, 'workbuddy', encode(value)), before = fs.readFileSync(file, 'utf8');
  const result = materializeProviderAuth(fs, runtime, 'workbuddy', {
    aiHomeDir: f.aiHomeDir, accountRef: account.accountRef, platform: 'linux'
  });
  assert.equal(result.reason, 'encrypted_credential_unavailable');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
