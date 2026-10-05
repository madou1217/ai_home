'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { translateNodeAccount } = require('../lib/account/go-bridge/go-import-translator');
const { encryptZcodeCredentialValue } = require('../lib/account/zcode-credential');
const { resolveNativeAuthIdentitySeed } = require('../lib/account/account-identity');
const { goAccountRefFromSeed } = require('../lib/account/go-bridge/go-static-account-ref');

function zcodeRecord(credentials) {
  return {
    accountRef: 'acct-zcode-fixture',
    provider: 'zcode',
    cliAccountId: '1',
    env: {},
    nativeAuth: { credentials }
  };
}

function zcodeCredentials() {
  const claims = Buffer.from(JSON.stringify({ sub: 'zcode-user', iat: 1000 })).toString('base64url');
  return {
    'oauth:active_provider': 'zai',
    'oauth:zai:user_info': JSON.stringify({ user_id: 'zcode-user' }),
    'oauth:zai:access_token': `e30.${claims}.signature`,
    zcodejwttoken: `e30.${claims}.signature`
  };
}

test('ZCode bridge materializes encrypted credentials without changing the source or identity', () => {
  const plain = zcodeCredentials();
  const encrypted = Object.fromEntries(Object.entries(plain).map(([key, value]) => [key, encryptZcodeCredentialValue(value)]));
  const record = zcodeRecord(encrypted);
  const before = structuredClone(record);
  const plan = translateNodeAccount(record);
  const plainPlan = translateNodeAccount(zcodeRecord(plain));

  assert.equal(plan.kind, 'import');
  assert.deepEqual(plan.request.body.artifacts.native_auth_json.credentials, plain);
  assert.deepEqual(plan.secrets.nativeAuth.credentials, plain);
  assert.equal(plan.predictedGoRef, plainPlan.predictedGoRef);
  assert.equal(
    plan.predictedGoRef,
    goAccountRefFromSeed(resolveNativeAuthIdentitySeed('zcode', plainPlan.secrets.nativeAuth).identitySeed)
  );
  assert.ok(plan.predictedGoRef);
  assert.deepEqual(record, before);
});

test('ZCode bridge rejects failed decryption before sending partial credentials', () => {
  const record = zcodeRecord({ ...zcodeCredentials(), zcodejwttoken: 'enc:v1:damaged.ciphertext.payload' });
  const plan = translateNodeAccount(record);

  assert.equal(plan.kind, 'unsupported');
  assert.equal(plan.reason, 'zcode_credentials_decryption_failed');
  assert.equal(plan.request, undefined);
});
