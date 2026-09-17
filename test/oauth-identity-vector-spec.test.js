'use strict';

// Executable stable-identity contract. Historical email/token fallbacks have
// been retired deliberately; absent evidence is an error, not another account.
// Kiro obtains the subject through an authenticated evidence adapter because
// its native token database does not contain a documented stable user ID.

const test = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../lib/account/account-identity');

function seedFor(provider, nativeAuth) {
  return identity.resolveNativeAuthIdentitySeed(provider, nativeAuth).identitySeed;
}

test('gemini derives its identity from the active google account email', () => {
  // ⚠️ §8.1 例外：gemini 没有更稳定的字段，邮箱就是身份。与 AGY 同性质。
  assert.equal(
    seedFor('gemini', { oauthCreds: { access_token: 'at' }, googleAccounts: { active: 'gem@example.com' } }),
    'oauth:gemini:gem@example.com'
  );
});

test('opencode derives a digest over its per-provider identity set', () => {
  const seed = seedFor('opencode', { auth: { anthropic: { type: 'oauth', account_id: 'opencode-user', refresh: 'fixture-refresh' } } });
  assert.match(seed, /^oauth:opencode:auth:[0-9a-f]{16}$/);
});

test('kimi requires a stable subject instead of a token fallback', () => {
  assert.match(
    seedFor('kimi', { credentials: { access_token: 'at', user_id: 'kimi-user-1' } }),
    /^oauth:kimi:user:[0-9a-f]{16}$/
  );
  assert.equal(seedFor('kimi', { credentials: { access_token: 'at', refresh_token: 'rt-1' } }), '');
});

test('zcode requires stable user_info id or token subject, never email', () => {
  assert.match(
    seedFor('zcode', { credentials: { zcodejwttoken: 'fixture-token', 'oauth:zai:user_info': JSON.stringify({ user_id: 'z-1' }) } }),
    /^oauth:zcode:user:[0-9a-f]{16}$/
  );
  assert.equal(seedFor('zcode', { credentials: { 'oauth:zai:user_info': JSON.stringify({ email: 'z@example.com' }) } }), '');
});

test('the codebuddy family scopes the same subject by provider', () => {
  const subject = { credentials: { access_token: 'at', refresh_token: 'rt', user_id: 'cb-1' } };
  const codebuddy = seedFor('codebuddy', subject);
  const codebuddycn = seedFor('codebuddycn', subject);
  assert.match(codebuddy, /^oauth:codebuddy:user:[0-9a-f]{16}$/);
  assert.match(codebuddycn, /^oauth:codebuddycn:user:[0-9a-f]{16}$/);
  assert.notEqual(codebuddy, codebuddycn);
});

test('grok ignores mutable email when a stable native user id is available', () => {
  const before = seedFor('grok', { auth: { key: 'at', refresh_token: 'rt', email: 'g@example.com', user_id: 'grok-stable-1' } });
  const after = seedFor('grok', { auth: { key: 'rotated', refresh_token: 'new', email: 'renamed@example.com', user_id: 'grok-stable-1' } });
  assert.equal(after, before);
  assert.match(before, /^oauth:grok:auth:[a-f0-9]{16}$/);
  assert.equal(seedFor('grok', { auth: { key: 'at', email: 'g@example.com' } }), '');
});

test('kiro rejects token-only enrollment without manufacturing a rotating account identity', () => {
  for (const refresh_token of ['rt-1', 'rt-2']) {
    const result = identity.resolveNativeAuthIdentitySeed('kiro', { auth: { access_token: 'at', refresh_token } });
    assert.equal(result.identitySeed, '');
    assert.equal(result.degraded, true);
  }
});
