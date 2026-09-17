'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vectors = require('../contracts/extended-native-identity.json').vectors;
const { resolveNativeAuthIdentitySeed } = require('../lib/account/account-identity');
const { getPublicAccountRef } = require('../lib/server/account-ref-store');
for (const vector of vectors) test(`extended identity contract: ${vector.name}`, () => {
  const result = resolveNativeAuthIdentitySeed(vector.provider, vector.nativeAuth);
  assert.equal(result.identitySeed, vector.identitySeed);
  assert.equal(result.identitySeed ? getPublicAccountRef(`unique:${result.identitySeed}`) : '', vector.accountRef);
});
