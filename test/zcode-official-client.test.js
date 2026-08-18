'use strict';

// zcode 桌面端身份合同（lib/server/zcode-official-client.js）：
// OAuth 计划账号的推理请求必须对齐 mitm 黄金请求的桌面端身份头与
// metadata.user_id；API-key 账号与自定义 baseUrl 账号一律不碰。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ZCODE_DESKTOP_IDENTITY_HEADERS,
  applyZcodeDesktopIdentity,
  isNativeZcodeOAuthAccount,
  zcodeDeviceIdForAccount
} = require('../lib/server/zcode-official-client');

const oauthAccount = {
  provider: 'zcode',
  accountRef: 'acct_91aa805bdd051b40fa47',
  authType: 'oauth'
};

test('isNativeZcodeOAuthAccount scopes to zcode OAuth without custom baseUrl', () => {
  assert.equal(isNativeZcodeOAuthAccount(oauthAccount), true);
  assert.equal(isNativeZcodeOAuthAccount({ ...oauthAccount, authType: 'api-key', apiKeyMode: true }), false);
  assert.equal(isNativeZcodeOAuthAccount({ ...oauthAccount, baseUrl: 'https://relay.example.com' }), false);
  assert.equal(isNativeZcodeOAuthAccount({ ...oauthAccount, provider: 'claude' }), false);
  assert.equal(isNativeZcodeOAuthAccount(null), false);
});

test('zcodeDeviceIdForAccount is a stable account-scoped UUID', () => {
  const a = zcodeDeviceIdForAccount(oauthAccount);
  const b = zcodeDeviceIdForAccount(oauthAccount);
  const c = zcodeDeviceIdForAccount({ ...oauthAccount, accountRef: 'acct_9fe1dc026eaec225df33' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('applyZcodeDesktopIdentity overwrites identity headers and injects metadata.user_id', () => {
  const headers = { 'user-agent': 'kimi-cli/1.0', authorization: 'Bearer jwt' };
  const body = Buffer.from(JSON.stringify({ model: 'GLM-5.3', messages: [] }));
  const out = applyZcodeDesktopIdentity(headers, body, oauthAccount);

  for (const [name, value] of Object.entries(ZCODE_DESKTOP_IDENTITY_HEADERS)) {
    assert.equal(out.headers[name], value, `header ${name}`);
  }
  // 下游客户端的 UA 必须被桌面端 UA 覆盖（黄金请求实证：param 不绑定求解环境 UA）。
  assert.equal(out.headers['user-agent'], ZCODE_DESKTOP_IDENTITY_HEADERS['user-agent']);
  for (const name of ['x-query-id', 'x-request-id', 'x-session-id', 'x-zcode-trace-id']) {
    assert.match(out.headers[name], /^[0-9a-f-]{36}$/, `header ${name}`);
  }
  assert.equal(out.headers.authorization, 'Bearer jwt');

  assert.notEqual(out.bodyBuffer, body);
  const parsed = JSON.parse(out.bodyBuffer.toString('utf8'));
  const userId = JSON.parse(parsed.metadata.user_id);
  assert.equal(userId.device_id, zcodeDeviceIdForAccount(oauthAccount));
  assert.equal(userId.account_uuid, '');
  assert.equal(userId.session_id, out.headers['x-session-id']);
  assert.equal(parsed.model, 'GLM-5.3');
});

test('applyZcodeDesktopIdentity keeps an existing metadata.user_id untouched', () => {
  const existing = JSON.stringify({ device_id: 'real-desktop', account_uuid: 'u1', session_id: 's1' });
  const body = Buffer.from(JSON.stringify({ model: 'GLM-5.3', metadata: { user_id: existing } }));
  const out = applyZcodeDesktopIdentity({}, body, oauthAccount);
  assert.equal(out.bodyBuffer, body, 'body buffer passes through untouched');
});

test('applyZcodeDesktopIdentity no-ops for api-key accounts and invalid bodies', () => {
  const apiKeyAccount = { ...oauthAccount, authType: 'api-key', apiKeyMode: true };
  const headers = {};
  const body = Buffer.from('{"model":"GLM-5.3"}');
  const out1 = applyZcodeDesktopIdentity(headers, body, apiKeyAccount);
  assert.equal(out1.bodyBuffer, body);
  assert.equal(out1.headers['user-agent'], undefined);

  const out2 = applyZcodeDesktopIdentity({}, Buffer.from('not-json'), oauthAccount);
  assert.equal(out2.bodyBuffer.toString(), 'not-json');
});
