'use strict';

// zcode 账号身份回归（2026-11-04 真机）：
//   * zai 手机号账号的 user_info.email 是 `<phone>@phone.local`，displayName 是
//     「旅行者0378」（昵称 + 手机尾号）。此前 WebUI 把合成邮箱当 email、把带尾号的
//     displayName 当昵称，账号行显示一个假地址和「旅行者0378」。
//   * bigmodel 的 user_info 可能完全没有 email（只有 username）——这是上游没有数据，
//     不能凭空造邮箱。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveZcodeAccountIdentity,
  resolveZcodeDisplayName,
  resolveZcodeAccountLabel
} = require('../lib/account/zcode-identity');
const { readFastAccountPresence } = require('../lib/server/account-presence-probes');
const { buildAccountDisplayNames } = require('../lib/server/account-display-identity');

const ZAI_PHONE = Object.freeze({
  user_id: 'u-phone-1',
  email: '13150310378@phone.local',
  avatar: '',
  name: '旅行者0378'
});

const ZAI_EMAIL = Object.freeze({
  id: 'u-email-1',
  username: 'Deo',
  displayName: 'Deo',
  avatarUrl: '',
  rawProfile: {
    user_id: 'u-email-1',
    email: 'madou1217@126.com',
    name: 'Deo'
  }
});

const BIGMODEL_MASKED = Object.freeze({
  id: 'u-big-1',
  username: 'MeaDeo',
  displayName: 'MeaDeo',
  rawProfile: {
    user_id: 'u-big-1',
    email: 'ma****17@126.com',
    name: 'MeaDeo'
  }
});

const BIGMODEL_NO_EMAIL = Object.freeze({
  id: 'u-big-2',
  username: 'yfadmgkl',
  displayName: 'yfadmgkl',
  rawProfile: {
    user_id: 'u-big-2',
    email: '',
    name: 'yfadmgkl'
  }
});

test('zai 手机号账号：提取完整手机号，昵称去掉手机尾号，不再暴露 @phone.local', () => {
  const identity = resolveZcodeAccountIdentity(ZAI_PHONE);
  assert.equal(identity.email, '13150310378@phone.local');
  assert.equal(identity.phone, '13150310378');
  assert.equal(identity.displayName, '旅行者');
  assert.equal(resolveZcodeDisplayName(ZAI_PHONE), '旅行者');
  assert.equal(resolveZcodeAccountLabel(ZAI_PHONE), '13150310378');
});

test('zai 邮箱账号：邮箱 / 昵称原样保留，不产生 phone 项', () => {
  const identity = resolveZcodeAccountIdentity(ZAI_EMAIL);
  assert.equal(identity.email, 'madou1217@126.com');
  assert.equal(identity.phone, '');
  assert.equal(identity.displayName, 'Deo');
  assert.equal(resolveZcodeDisplayName(ZAI_EMAIL), 'Deo');
  assert.equal(resolveZcodeAccountLabel(ZAI_EMAIL), 'madou1217@126.com');
});

test('bigmodel 打码邮箱：原样展示，昵称取 displayName', () => {
  const identity = resolveZcodeAccountIdentity(BIGMODEL_MASKED);
  assert.equal(identity.email, 'ma****17@126.com');
  assert.equal(identity.phone, '');
  assert.equal(resolveZcodeDisplayName(BIGMODEL_MASKED), 'MeaDeo');
  assert.equal(resolveZcodeAccountLabel(BIGMODEL_MASKED), 'ma****17@126.com');
});

test('bigmodel 无邮箱：不伪造 email，仍保留 username 作为昵称', () => {
  const identity = resolveZcodeAccountIdentity(BIGMODEL_NO_EMAIL);
  assert.equal(identity.email, '');
  assert.equal(identity.phone, '');
  assert.equal(resolveZcodeDisplayName(BIGMODEL_NO_EMAIL), 'yfadmgkl');
  assert.equal(resolveZcodeAccountLabel(BIGMODEL_NO_EMAIL), 'yfadmgkl');
});

test('BigModel 已打码手机号保留 ****，不拼成 7 位数字', () => {
  const userInfo = {
    id: 'u-big-masked',
    username: 'Deo',
    displayName: 'Deo',
    rawProfile: {
      user_id: 'u-big-masked',
      email: '',
      name: 'Deo',
      phoneNumber: '131****1636'
    }
  };
  const identity = resolveZcodeAccountIdentity(userInfo);
  assert.equal(identity.phone, '131****1636');

  const presence = readFastAccountPresence('zcode', zcodeRecord(userInfo, 'bigmodel'));
  assert.equal(presence.phone, '131****1636');
  assert.deepEqual(buildAccountDisplayNames({
    displayName: presence.displayName,
    nickname: presence.nickname,
    phone: presence.phone,
    email: presence.email,
    apiKeyMode: presence.apiKeyMode
  }), [
    { type: 'phone', value: '131****1636' },
    { type: 'nickName', value: 'Deo' }
  ]);
});

function zcodeRecord(userInfo, region = 'zai') {
  return {
    nativeAuth: {
      credentials: {
        'oauth:active_provider': region,
        [`oauth:${region}:access_token`]: 'test-token',
        [`oauth:${region}:user_info`]: JSON.stringify(userInfo)
      }
    },
    env: {}
  };
}

test('WebUI 在场探针：zcode 手机号账号下发 phone，不下发合成邮箱', () => {
  const presence = readFastAccountPresence('zcode', zcodeRecord(ZAI_PHONE));
  assert.equal(presence.configured, true);
  assert.equal(presence.displayName, '旅行者');
  assert.equal(presence.nickname, '旅行者');
  assert.equal(presence.phone, '13150310378');
  assert.equal(presence.email, undefined);
  assert.equal(presence.identityKey, 'u-phone-1');

  const names = buildAccountDisplayNames({
    displayName: presence.displayName,
    phone: presence.phone,
    email: presence.email,
    apiKeyMode: presence.apiKeyMode
  });
  assert.deepEqual(names, [
    { type: 'phone', value: '13150310378' },
    { type: 'nickName', value: '旅行者' }
  ]);
});

test('WebUI 在场探针：zcode 邮箱账号下发真实 email，不产生 phone 项', () => {
  const presence = readFastAccountPresence('zcode', zcodeRecord(ZAI_EMAIL));
  assert.equal(presence.displayName, 'Deo');
  assert.equal(presence.nickname, 'Deo');
  assert.equal(presence.email, 'madou1217@126.com');
  assert.equal(presence.phone, undefined);
});
