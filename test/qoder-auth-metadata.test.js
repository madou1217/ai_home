'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  getQoderVariant,
  isQoderProvider,
  encryptQoderCredentials,
  decryptQoderCredentials,
  buildQoderIdentitySeed,
  extractQoderLoginProjectionMetadata,
  resolveQoderNativeAuthPayload,
  summarizeQoderAuth
} = require('../lib/account/qoder-auth-metadata');

test('isQoderProvider recognises global and CN ids only', () => {
  assert.equal(isQoderProvider('qoder'), true);
  assert.equal(isQoderProvider('qodercn'), true);
  assert.equal(isQoderProvider('claude'), false);
  assert.equal(getQoderVariant('qoder').binaryName, 'qodercli');
  assert.equal(getQoderVariant('qodercn').binaryName, 'qoderclicn');
  assert.equal(getQoderVariant('qoder').credentialPrefix, 'qoder-cli');
  assert.equal(getQoderVariant('qodercn').credentialPrefix, 'qoder-cli-cn');
});

test('encrypt/decrypt round-trips Qoder credentials (AES-256-GCM)', () => {
  const salt = crypto.randomBytes(32);
  const saltB64 = salt.toString('base64');
  const payload = {
    email: 'user@example.com',
    uid: 'uid-123',
    security_oauth_token: 'tok-abc',
    login_method: 'browser'
  };
  const encrypted = encryptQoderCredentials(payload, saltB64, 'qoder-cli');
  assert.match(encrypted, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i);
  const decrypted = decryptQoderCredentials(encrypted, saltB64, 'qoder-cli');
  assert.deepEqual(decrypted, payload);
});

test('decrypt rejects wrong credential prefix (global vs CN)', () => {
  const salt = crypto.randomBytes(32).toString('base64');
  const encrypted = encryptQoderCredentials({ email: 'a@b.c' }, salt, 'qoder-cli');
  assert.equal(decryptQoderCredentials(encrypted, salt, 'qoder-cli-cn'), null);
});

test('buildQoderIdentitySeed prefers email then uid then token hash', () => {
  assert.equal(
    buildQoderIdentitySeed('qoder', { email: 'A@Example.com' }),
    'oauth:qoder:a@example.com'
  );
  assert.equal(
    buildQoderIdentitySeed('qodercn', { uid: 'u-99' }),
    'oauth:qodercn:uid:u-99'
  );
  assert.equal(
    buildQoderIdentitySeed('qoder', { username: 'MeaDeo' }),
    'oauth:qoder:username:meadeo'
  );
  const tokenSeed = buildQoderIdentitySeed('qoder', { security_oauth_token: 'secret-token' });
  assert.match(tokenSeed, /^oauth:qoder:token:[0-9a-f]{16}$/);
  assert.equal(buildQoderIdentitySeed('qoder', {}), '');
});

test('extractQoderLoginProjectionMetadata captures successful email or username identity', () => {
  assert.deepEqual(
    extractQoderLoginProjectionMetadata(
      'qodercn',
      '\u001b[32mLogin successful! Welcome, 779282939@QQ.com.\u001b[0m'
    ),
    { userInfo: { email: '779282939@qq.com' } }
  );
  assert.deepEqual(
    extractQoderLoginProjectionMetadata('qoder', 'Login successful! Welcome, MeaDeo.'),
    { userInfo: { username: 'meadeo' } }
  );
  assert.deepEqual(extractQoderLoginProjectionMetadata('claude', 'Login successful! Welcome, a@b.com.'), {});
  assert.deepEqual(extractQoderLoginProjectionMetadata('qoder', 'Waiting for browser authorization...'), {});
});

test('resolveQoderNativeAuthPayload decrypts projected native auth', () => {
  const salt = crypto.randomBytes(32);
  const saltB64 = salt.toString('base64');
  const payload = { email: 'cn@example.com', uid: 'cn-1' };
  const encrypted = encryptQoderCredentials(payload, saltB64, 'qoder-cli-cn');
  const resolved = resolveQoderNativeAuthPayload('qodercn', {
    credentials: encrypted,
    keychainSalt: saltB64
  });
  assert.deepEqual(resolved, payload);
});

test('summarizeQoderAuth surfaces email and PAT fallback', () => {
  const salt = crypto.randomBytes(32).toString('base64');
  const encrypted = encryptQoderCredentials({ email: 'me@qoder.com' }, salt, 'qoder-cli');
  const oauth = summarizeQoderAuth('qoder', { credentials: encrypted, keychainSalt: salt });
  assert.equal(oauth.configured, true);
  assert.equal(oauth.accountName, 'me@qoder.com');

  const pat = summarizeQoderAuth('qoder', {}, { envToken: 'abcdefghijklmnopqrstuvwxyz' });
  assert.equal(pat.configured, true);
  assert.match(pat.accountName, /^PAT:/);
});
