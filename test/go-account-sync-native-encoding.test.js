'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { newerGoNativeAuth } = require('../lib/server/go-account-sync');
const { decryptZcodeCredentialRecord, encryptZcodeCredentialValue } = require('../lib/account/zcode-credential');

function fixture() {
  const plain = {
    'oauth:active_provider': 'zai',
    'oauth:zai:user_info': JSON.stringify({ user_id: 'zcode-user' }),
    zcodejwttoken: 'opaque-token'
  };
  const encrypted = Object.fromEntries(Object.entries(plain).map(([key, value]) => [key, encryptZcodeCredentialValue(value)]));
  return {
    plain,
    record: { provider: 'zcode', nativeAuthUpdatedAt: 1000, nativeAuth: { credentials: encrypted }, env: {} },
    go: { credentialUpdatedAtMs: 2000, credential: { native_auth_json: { credentials: plain } } }
  };
}

test('Go import time does not overwrite an equivalent encrypted Node ZCode snapshot', () => {
  const { record, go } = fixture();
  assert.equal(newerGoNativeAuth(record, go), null);
});

test('Newer Go ZCode credentials preserve the encrypted Node representation', () => {
  const { plain, record, go } = fixture();
  const before = structuredClone(record);
  go.credential.native_auth_json.credentials = { ...plain, zcodejwttoken: 'new-opaque-token', 'oauth:zai:refresh_token': 'new-refresh-token' };
  const next = newerGoNativeAuth(record, go);

  assert.ok(next);
  assert.ok(Object.values(next.credentials).every(value => value.startsWith('enc:v1:')));
  assert.deepEqual(decryptZcodeCredentialRecord(next.credentials), go.credential.native_auth_json.credentials);
  assert.deepEqual(record, before);
  assert.equal(newerGoNativeAuth(record, { ...go, credentialUpdatedAtMs: 999 }), null);
});
