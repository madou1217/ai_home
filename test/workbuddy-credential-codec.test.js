'use strict';

// 回归守卫（2026-11-04 真机）：WorkBuddy 国内站桌面端把 account.phoneNumber 也加密成
// sym-v1 信封。凭据解码器原先只解 nickname，导致账号页/轮播永远拿不到手机号——
// 账号只剩昵称可显示。这里钉住两件事：
//   1. phoneNumber 与 nickname 走同一个信封，编码后可以原样解回；
//   2. 即使只有 phoneNumber 被加密，也会触发解码器（不能按「无加密字段」跳过）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeWorkbuddyCredential,
  hasWorkbuddyEncryptedCredentials,
  transformWorkbuddyCredentials
} = require('../lib/account/workbuddy-credential-codec');

const KEY_PAYLOAD = Object.freeze({
  version: 1,
  atRestSecretKey: Buffer.alloc(32, 7).toString('base64')
});

test('phoneNumber 与 nickname 一样走 sym-v1 信封：编码后可原样解回', () => {
  const value = {
    auth: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    account: { uid: 'u-1', nickname: '码逗', phoneNumber: '18912341630' }
  };
  const encoded = transformWorkbuddyCredentials(value, 'encode', KEY_PAYLOAD);
  assert.equal(encoded.account.nickname.$wbEncrypted, 1);
  assert.equal(encoded.account.phoneNumber.$wbEncrypted, 1);
  assert.notEqual(encoded.account.phoneNumber, '18912341630');

  const decoded = transformWorkbuddyCredentials(encoded, 'decode', KEY_PAYLOAD);
  assert.equal(decoded.account.nickname, '码逗');
  assert.equal(decoded.account.phoneNumber, '18912341630');
  assert.equal(decoded.auth.accessToken, 'access-token');
});

test('只有 phoneNumber 被加密时也会触发解码器', () => {
  const value = {
    auth: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    account: { uid: 'u-1', phoneNumber: { $wbEncrypted: 1, envelope: 'ciphertext' } }
  };
  assert.equal(hasWorkbuddyEncryptedCredentials(value), true);

  let calls = 0;
  const decodedPayload = {
    auth: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    account: { uid: 'u-1', phoneNumber: '18912341630' }
  };
  const result = decodeWorkbuddyCredential(value, 'workbuddycn', {
    vendorElectron: '/fake/Electron',
    execFileSync: () => {
      calls += 1;
      return JSON.stringify(decodedPayload);
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.encrypted, true);
  assert.equal(result.credential.account.phoneNumber, '18912341630');
});
