'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildKimiIdentitySeed } = require('../lib/account/account-identity');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { createKimiUsageAccountRefResolver } = require('../lib/usage/kimi-usage-account-ref');

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

function fakeCredentials(subject) {
  return {
    access_token: fakeJwt({ sub: subject, user_id: subject, type: 'access' }),
    refresh_token: fakeJwt({ sub: subject, user_id: subject, type: 'refresh' }),
    token_type: 'Bearer',
    scope: 'kimi-code'
  };
}

function writeKimiCredentials(runtimeDir, credentials) {
  const filePath = path.join(runtimeDir, '.kimi-code', 'credentials', 'kimi-code.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(credentials), 'utf8');
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-usage-ref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  return { root, aiHomeDir };
}

test('kimi usage account resolver matches the owning account by token identity', (t) => {
  const { root, aiHomeDir } = makeFixture(t);
  const credentials = fakeCredentials('d9v1ve1g4pngggebtacg');
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'kimi',
    identitySeed: buildKimiIdentitySeed(credentials)
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, { credentials });

  const runtimeDir = path.join(root, 'projection');
  writeKimiCredentials(runtimeDir, credentials);
  const resolve = createKimiUsageAccountRefResolver({ fs, path, aiHomeDir });

  assert.equal(resolve(runtimeDir), registration.accountRef);
});

test('kimi usage account resolver returns empty for unknown or missing credentials', (t) => {
  const { root, aiHomeDir } = makeFixture(t);
  const credentials = fakeCredentials('d9v1ve1g4pngggebtacg');
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'kimi',
    identitySeed: buildKimiIdentitySeed(credentials)
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, { credentials });
  const resolve = createKimiUsageAccountRefResolver({ fs, path, aiHomeDir });

  const unknownDir = path.join(root, 'unknown-user');
  writeKimiCredentials(unknownDir, fakeCredentials('somebody-else'));
  assert.equal(resolve(unknownDir), '');

  const noCredentialsDir = path.join(root, 'no-credentials');
  fs.mkdirSync(noCredentialsDir, { recursive: true });
  assert.equal(resolve(noCredentialsDir), '');
  assert.equal(resolve(''), '');
});

test('kimi usage account resolver is disabled without an aiHomeDir', () => {
  assert.equal(createKimiUsageAccountRefResolver({ fs }), null);
});
