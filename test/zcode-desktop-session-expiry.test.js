'use strict';

// 回归守卫：zcode 桌面会话过期必须在**打开前**判定。
//
// 2026-11-03 真机：#5/#7/#8 登录于 8 月，存的是 1 小时寿命的登录 JWT，且没有
// refresh_token。桌面端启动时校验 exp 后直接弹「Your session has expired」，
// 但账号列表此前仍显示「正常」。判成 auth_invalid 后，open-app 返回
// account_auth_invalid，界面引导重新授权，而不是打开一个必然失效的窗口。

const test = require('node:test');
const assert = require('node:assert');
const { isZcodeDesktopSessionExpired } = require('../lib/account/zcode-credential');

function jwt(payload) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${head}.${body}.sig`;
}

function nativeAuth(credentials) {
  return { credentials };
}

test('过期的登录 JWT 且无 refresh token → 判定失效', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const token = jwt({ sub: 'u1', exp: Math.floor(now / 1000) - 60 });
  assert.equal(isZcodeDesktopSessionExpired(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': token
  }), { nowMs: now }), true);
});

test('未过期的登录 JWT → 不判失效', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const token = jwt({ sub: 'u1', exp: Math.floor(now / 1000) + 3600 });
  assert.equal(isZcodeDesktopSessionExpired(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': token
  }), { nowMs: now }), false);
});

test('业务 token（无 exp）→ 不判失效', () => {
  const token = jwt({ sub: '13740999' });
  assert.equal(isZcodeDesktopSessionExpired(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': token
  }), { nowMs: Date.now() }), false);
});

test('有 refresh_token 时交给桌面端续期 → 不判失效', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const token = jwt({ sub: 'u1', exp: Math.floor(now / 1000) - 60 });
  assert.equal(isZcodeDesktopSessionExpired(nativeAuth({
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': token,
    'oauth:zai:refresh_token': 'refresh'
  }), { nowMs: now }), false);
});

test('bigmodel 区域的键同样按 active_provider 解析', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const token = jwt({ sub: 'u2', exp: Math.floor(now / 1000) - 60 });
  assert.equal(isZcodeDesktopSessionExpired(nativeAuth({
    'oauth:active_provider': 'bigmodel',
    'oauth:bigmodel:access_token': token
  }), { nowMs: now }), true);
});

test('没有任何 OAuth token（API Key 模式）→ 不判失效', () => {
  assert.equal(isZcodeDesktopSessionExpired(nativeAuth({}), { nowMs: Date.now() }), false);
});

