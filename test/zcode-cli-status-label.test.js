'use strict';

// 回归守卫：`aih zcode ls` 的展示名/判重键必须走统一身份解析。
//
// 2026-11-03 真机：4 个 OAuth 账号全部显示「ZCode OAuth」，并被误报为
// 「Duplicate of ID 1」。根因是 CLI status 分支直接读 userInfo.email / userInfo.name，
// 而 user_info 归一化后是 {id, username, displayName, rawProfile} —— 两个字段都取不到；
// 判重键退化成展示名，于是不同账号互相判重。

const test = require('node:test');
const assert = require('node:assert');
const { describeZcodeAccountStatus } = require('../lib/cli/services/account/status');

function nativeAuth(credentials) {
  return { credentials };
}

test('归一化后的 user_info 显示 displayName，而不是 ZCode OAuth', () => {
  const status = describeZcodeAccountStatus(nativeAuth({
    'oauth:active_provider': 'bigmodel',
    'oauth:bigmodel:user_info': JSON.stringify({
      id: '23701694489963901', username: 'MeaDeo', displayName: 'MeaDeo',
      rawProfile: { user_id: '23701694489963901', email: 'ma****17@126.com', name: 'MeaDeo' }
    })
  }));
  assert.equal(status.configured, true);
  assert.equal(status.accountName, 'MeaDeo');
  assert.equal(status.identityKey, '23701694489963901');
});

test('旧 zai 扁平 user_info 与归一化形状得到一致展示名与稳定身份键', () => {
  const legacy = describeZcodeAccountStatus(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:user_info': JSON.stringify({ user_id: 'u-1', email: '13150310378@phone.local', name: '旅行者0378' })
  }));
  const normalized = describeZcodeAccountStatus(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:user_info': JSON.stringify({
      id: 'u-1', username: '旅行者0378', displayName: '旅行者0378',
      rawProfile: { user_id: 'u-1', email: '13150310378@phone.local', name: '旅行者0378' }
    })
  }));
  // 手机号账号的 displayName 是「昵称 + 手机尾号」；两种形状都去掉尾号，
  // 完整手机号留给 displayNames 的 phone 项展示。
  assert.equal(legacy.accountName, '旅行者');
  assert.equal(normalized.accountName, '旅行者');
  assert.equal(legacy.identityKey, 'u-1');
  assert.equal(normalized.identityKey, 'u-1');
});

test('不同身份不会因为展示名相同而互相判重', () => {
  const a = describeZcodeAccountStatus(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:user_info': JSON.stringify({ user_id: 'u-a', name: '同名' })
  }));
  const b = describeZcodeAccountStatus(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:user_info': JSON.stringify({ user_id: 'u-b', name: '同名' })
  }));
  assert.notEqual(a.identityKey, b.identityKey);
});

test('没有任何凭据 → configured=false，不产生展示名', () => {
  const status = describeZcodeAccountStatus(nativeAuth({}));
  assert.equal(status.configured, false);
  assert.equal(status.accountName, '');
});


test('access_token 过期且无 refresh_token → runtimeStatus=auth_invalid（列表显示认证失效）', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'u-1', exp: Math.floor(now / 1000) - 60 })).toString('base64url');
  const expiredJwt = `${head}.${body}.sig`;
  const status = describeZcodeAccountStatus(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': expiredJwt,
    'oauth:zai:user_info': JSON.stringify({ user_id: 'u-1', name: '旅行者0378' })
  }));
  assert.equal(status.runtimeStatus, 'auth_invalid');
  assert.equal(status.runtimeReason, 'zcode_access_token_expired');
});

test('有 refresh_token 的过期 JWT 不标记失效（交给桌面端续期）', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'u-1', exp: Math.floor(now / 1000) - 60 })).toString('base64url');
  const status = describeZcodeAccountStatus(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': `${head}.${body}.sig`,
    'oauth:zai:refresh_token': 'refresh',
    'oauth:zai:user_info': JSON.stringify({ user_id: 'u-1', name: '旅行者0378' })
  }));
  assert.equal(status.runtimeStatus, undefined);
});

