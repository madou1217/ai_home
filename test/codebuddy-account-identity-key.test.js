'use strict';

// 回归守卫（2026-11-01 真机）：`aih codebuddycn ls` 把两个**不同**的国内站账号标成
// 「⚠️ Duplicate of ID 2」——两个账号昵称都叫「MeaDeo」，但 uid / uin / 手机号全不同。
//
// 根因：profile/list 的判重在没有可信身份键时退回昵称启发式。家族状态摘要之前不返回
// identityKey，于是同名即重复。约定：家族身份键取自凭据本身（uid = JWT sub，其次 uin），
// 昵称永远不是身份。

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeCodebuddyAuth } = require('../lib/account/codebuddy-account-status');

const CN_ISSUER = 'https://www.codebuddy.cn/auth/realms/copilot';

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(uid, issuer = CN_ISSUER) {
  const now = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: 'none' }),
    encode({ iss: issuer, sub: uid, iat: now, exp: now + 3600 }),
    'sig'
  ].join('.');
}

function nativeAuth({ uid, nickname, uin }) {
  return {
    credentials: {
      auth: {
        accessToken: token(uid),
        refreshToken: token(uid),
        domain: new URL(CN_ISSUER).hostname,
        lastRefreshTime: Date.now()
      },
      account: { uid, nickname, uin }
    }
  };
}

test('同昵称的两个国内站账号：身份键不同，不再判成重复', () => {
  const left = summarizeCodebuddyAuth('codebuddycn', nativeAuth({
    uid: '23ddaff9-aa4b-485f-85de-8f152eeaabf4', nickname: 'MeaDeo', uin: '330134286413'
  }));
  const right = summarizeCodebuddyAuth('codebuddycn', nativeAuth({
    uid: '393b0689-fb73-47aa-adbe-572dd667496d', nickname: 'MeaDeo', uin: '330134409143'
  }));

  assert.equal(left.configured, true);
  assert.equal(right.configured, true);
  assert.equal(left.accountName, 'MeaDeo');
  assert.equal(right.accountName, 'MeaDeo');
  assert.ok(left.identityKey);
  assert.ok(right.identityKey);
  assert.notEqual(left.identityKey, right.identityKey);
});

test('同一账号重复登录：身份键保持同一个', () => {
  const first = summarizeCodebuddyAuth('codebuddycn', nativeAuth({
    uid: '23ddaff9-aa4b-485f-85de-8f152eeaabf4', nickname: 'MeaDeo', uin: '330134286413'
  }));
  const second = summarizeCodebuddyAuth('codebuddycn', nativeAuth({
    uid: '23ddaff9-aa4b-485f-85de-8f152eeaabf4', nickname: 'MeaDeo 改名了', uin: '330134286413'
  }));
  assert.equal(first.identityKey, second.identityKey);
});

test('没有昵称时用打码手机号做展示名，身份键仍是 uid', () => {
  const auth = nativeAuth({
    uid: '23ddaff9-aa4b-485f-85de-8f152eeaabf4', nickname: '', uin: '330134286413'
  });
  auth.credentials.account.phoneNumber = '18912341630';
  const summary = summarizeCodebuddyAuth('codebuddycn', auth);
  assert.equal(summary.accountName, '189****1630');
  assert.equal(summary.identityKey, 'codebuddy:23ddaff9-aa4b-485f-85de-8f152eeaabf4');
  // 昵称与手机号都缺：展示名为空（调用方会回落到「<cli> OAuth」）。
  auth.credentials.account.phoneNumber = 'not-a-phone';
  assert.equal(summarizeCodebuddyAuth('codebuddycn', auth).accountName, '');
});

test('refresh token 已过期：配置判否，但身份键仍然给出（判重要用）', () => {
  const auth = nativeAuth({
    uid: '23ddaff9-aa4b-485f-85de-8f152eeaabf4', nickname: 'MeaDeo', uin: '330134286413'
  });
  auth.credentials.auth.refreshExpiresAt = Date.now() - 1000;
  const summary = summarizeCodebuddyAuth('codebuddycn', auth);
  assert.equal(summary.configured, false);
  assert.equal(summary.reason, 'refresh_token_expired');
  assert.equal(summary.identityKey, 'codebuddy:23ddaff9-aa4b-485f-85de-8f152eeaabf4');
});

test('凭据不可用时不给身份键（沿用旧的展示名启发式）', () => {
  const summary = summarizeCodebuddyAuth('codebuddycn', {
    credentials: { auth: { accessToken: 'not-a-jwt' }, account: { uid: 'u-1', nickname: 'X' } }
  });
  assert.equal(summary.configured, false);
  assert.equal(summary.identityKey, '');
});
