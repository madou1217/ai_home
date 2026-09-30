'use strict';

// 回归:WorkBuddy 账号凭据有效,账号页却一直显示「OAuth 授权中 / pending」——
// 快速快照与 checkStatus 都没有家族分支,家族又不在运行时账号池,已登录永远判不出来。

const test = require('node:test');
const assert = require('node:assert/strict');

const { credential } = require('./helpers/codebuddy-credential');
const { summarizeCodebuddyAuth } = require('../lib/account/codebuddy-account-status');

test('有效的家族 OAuth 凭据判为已登录,账号名取 nickname', () => {
  const summary = summarizeCodebuddyAuth('workbuddy', { credentials: credential('workbuddy') });
  assert.deepEqual(summary, { configured: true, accountName: 'fixture', reason: '' });
});

test('国内站没有 nickname 时用打码手机号', () => {
  const value = credential('workbuddycn');
  value.account = { ...value.account, nickname: '', phoneNumber: '13812345678' };
  assert.equal(summarizeCodebuddyAuth('workbuddycn', { credentials: value }).accountName, '138****5678');
});

test('refresh token 已过期判为未登录,但仍给出账号名', () => {
  const value = credential('codebuddy');
  value.auth.refreshExpiresAt = Date.now() - 1000;
  const summary = summarizeCodebuddyAuth('codebuddy', { credentials: value });
  assert.equal(summary.configured, false);
  assert.equal(summary.reason, 'refresh_token_expired');
  assert.equal(summary.accountName, 'fixture');
});

test('别的站点签发的凭据不能算作本 provider 已登录', () => {
  const summary = summarizeCodebuddyAuth('workbuddy', { credentials: credential('codebuddy') });
  assert.equal(summary.configured, false);
  assert.equal(summary.reason, 'credential_realm_mismatch');
});

test('没有凭据时未登录', () => {
  assert.equal(summarizeCodebuddyAuth('workbuddy', {}).configured, false);
});
