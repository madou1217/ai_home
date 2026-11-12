'use strict';

// opencode 身份回归（2026-11-04 真机）：
//   v2 Console 登录把 email / accountID / orgID / orgName 放在
//   `auth.<provider>.metadata` 里；旧实现只查顶层和 account/user/profile，
//   于是账号页只能显示 `OpenCode Account acct_…`（用户明确说不想看到 acct id）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickOpenCodeAccountEmail,
  pickOpenCodeAccountIdentity,
  summarizeOpenCodeAuth
} = require('../lib/account/opencode-auth-metadata');

function oauthAuth(metadata = {}) {
  return {
    'opencode-go': {
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3600_000,
      metadata
    }
  };
}

test('opencode v2 Console：从 metadata 提取 email，标题不再用 acct id', () => {
  const auth = oauthAuth({
    email: 'user@example.com',
    accountID: 'acct_meta_1',
    orgID: 'org_1',
    orgName: 'Default'
  });
  assert.equal(pickOpenCodeAccountIdentity(auth), 'user@example.com');
  assert.equal(pickOpenCodeAccountEmail(auth), 'user@example.com');

  const summary = summarizeOpenCodeAuth(auth, { accountRef: 'acct_533999af0033f08d6106' });
  assert.equal(summary.configured, true);
  assert.equal(summary.accountName, 'user@example.com');
  assert.equal(summary.email, 'user@example.com');
});

test('metadata 没有 email 时用 username；API Key 仍用 key 指纹', () => {
  const withName = summarizeOpenCodeAuth(oauthAuth({ username: 'Deo' }), { accountRef: 'acct_x' });
  assert.equal(withName.accountName, 'Deo');
  assert.equal(withName.email, '');

  const apiKey = summarizeOpenCodeAuth({
    'opencode-go': { type: 'api', key: 'sk-test-1234' }
  }, { accountRef: 'acct_x' });
  assert.equal(apiKey.email, '');
  assert.match(apiKey.accountName, /\.\.\.1234\)$/);
});
