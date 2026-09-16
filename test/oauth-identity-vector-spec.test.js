'use strict';

// Characterization tests for the identity vectors Go has NOT implemented yet.
//
// `docs/architecture/oauth-identity-vector-spec.md` records what Node does for
// every provider. These tests make that document executable: if someone changes
// one of these vectors, this file fails and points at the spec, instead of the
// change landing silently.
//
// The Kiro assertion below deliberately pins **known §8.1 violations**. They
// are written as characterizations, not as endorsements: they exist so the
// violation is visible in CI and so fixing it is a conscious act that updates
// this file. Read the comments before "fixing" a failure here.
//
// See docs/architecture/oauth-identity-vector-spec.md and
// docs/architecture/codex-oauth-identity-vector-adr.md.

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
  const seed = seedFor('opencode', { auth: { anthropic: { type: 'oauth', email: 'oc@example.com' } } });
  assert.match(seed, /^oauth:opencode:auth:[0-9a-f]{16}$/);
});

test('kimi prefers a stable subject and falls back to a token hash', () => {
  assert.match(
    seedFor('kimi', { credentials: { access_token: 'at', user_id: 'kimi-user-1' } }),
    /^oauth:kimi:user:[0-9a-f]{16}$/
  );
  assert.match(
    seedFor('kimi', { credentials: { access_token: 'at', refresh_token: 'rt-1' } }),
    /^oauth:kimi:token:[0-9a-f]{16}$/
  );
});

test('zcode prefers user_info id and falls back through email to a token hash', () => {
  assert.match(
    seedFor('zcode', { credentials: { 'oauth:zai:user_info': JSON.stringify({ user_id: 'z-1' }) } }),
    /^oauth:zcode:user:[0-9a-f]{16}$/
  );
  assert.match(
    seedFor('zcode', { credentials: { 'oauth:zai:user_info': JSON.stringify({ email: 'z@example.com' }) } }),
    /^oauth:zcode:user:[0-9a-f]{16}$/
  );
});

test('the codebuddy family scopes the same subject by provider', () => {
  const subject = { credentials: { access_token: 'at', refresh_token: 'rt', user_id: 'cb-1' } };
  const codebuddy = seedFor('codebuddy', subject);
  const codebuddycn = seedFor('codebuddycn', subject);
  assert.match(codebuddy, /^oauth:codebuddy:user:[0-9a-f]{16}$/);
  assert.match(codebuddycn, /^oauth:codebuddycn:user:[0-9a-f]{16}$/);
  assert.notEqual(codebuddy, codebuddycn);
});

// ---------------------------------------------------------------------------
// 以下两条是**已知的 §8.1 违规**的特征化断言。
// 它们不是「正确行为」，而是「当前行为」——写在这里是为了让违规在 CI 里可见，
// 并且让修复成为一个必须显式改动本文件的动作。修的时候请一并更新 spec 文档。
// ---------------------------------------------------------------------------

test('grok ignores mutable email when a stable native user id is available', () => {
  const before = seedFor('grok', { auth: { key: 'at', refresh_token: 'rt', email: 'g@example.com', user_id: 'grok-stable-1' } });
  const after = seedFor('grok', { auth: { key: 'rotated', refresh_token: 'new', email: 'renamed@example.com', user_id: 'grok-stable-1' } });
  assert.equal(after, before);
  assert.match(before, /^oauth:grok:auth:[a-f0-9]{16}$/);
  assert.equal(seedFor('grok', { auth: { key: 'at', email: 'g@example.com' } }), '');
});

test('KNOWN §8.1 VIOLATION: kiro rotates its accountRef when the credential rotates', () => {
  // §8.1 第 3 条逐字要求「凭据轮换不得改变 AccountRef」。kiro 的存储里只有
  // access/refresh token，没有 user id 或邮箱，于是身份就是 token 的哈希。
  const first = seedFor('kiro', { auth: { access_token: 'at', refresh_token: 'rt-1' } });
  const rotated = seedFor('kiro', { auth: { access_token: 'at', refresh_token: 'rt-2' } });

  assert.match(first, /^oauth:kiro:token:[0-9a-f]{16}$/);
  assert.notEqual(rotated, first);

  // 关闭它需要上游证据（Kiro 的 token 是否是 JWT、auth_kv 里是否另有身份 key），
  // 见 spec 的「关闭顺序建议」。在拿到证据前不改。
});
