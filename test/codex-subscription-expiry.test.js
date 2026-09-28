'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCodexSnapshotAccount } = require('../lib/account/codex-auth-metadata');
const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');

function jwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

// Codex OAuth 的订阅到期只在 id_token 的 auth 声明里；access_token 的 auth 声明不带它，
// 不能因为 access_token 优先而丢掉。
test('codex subscription expiry flows from the id_token to the WebUI snapshot', () => {
  const auth = {
    tokens: {
      access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
      id_token: jwt({
        email: 'user@example.com',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'plus',
          chatgpt_subscription_active_until: '2026-10-22T07:47:09+00:00',
          chatgpt_subscription_last_checked: '2026-09-22T07:53:05+00:00'
        }
      })
    }
  };
  const account = buildCodexSnapshotAccount(null, auth);
  assert.equal(account.subscriptionActiveUntilMs, Date.parse('2026-10-22T07:47:09Z'));
  assert.equal(account.subscriptionLastCheckedMs, Date.parse('2026-09-22T07:53:05Z'));

  const view = normalizeAccountUsageSnapshot({ kind: 'codex_oauth_status', capturedAt: 1, account, entries: [] });
  assert.equal(view.account.subscriptionActiveUntilMs, Date.parse('2026-10-22T07:47:09Z'));
  assert.equal(view.account.subscriptionLastCheckedMs, Date.parse('2026-09-22T07:53:05Z'));

  const withoutClaims = buildCodexSnapshotAccount(null, { tokens: { id_token: jwt({ email: 'a@b.c' }) } });
  assert.equal(withoutClaims.subscriptionActiveUntilMs, undefined);
});
