'use strict';

// Cross-language pin for the AGY (Antigravity) OAuth identity vector.
//
// The vectors live in `contracts/agy-oauth-identity.json` and are read by the Go
// suite too (`core/accounts/agy/oauth_identity_contract_test.go`).
//
// AGY is the one provider where the email **is** the identity: its native
// oauthToken document carries no user id or uuid, so there is no more stable
// field to use. That makes it a §8.1 exception needing its own ADR (see
// docs/architecture/codex-oauth-identity-vector-adr.md).
//
// What this contract pins is the *validation strength*: Node used to accept any
// non-empty string, so it could mint `oauth:agy:no-at-sign` — a seed Go's
// `normalizeEmail` refuses outright, i.e. an account Node could create and Go
// could never address.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const identity = require('../lib/account/account-identity');
const { normalizeEmailComponent } = require('../lib/account/identity-components');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');

const CONTRACT = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'contracts', 'agy-oauth-identity.json'),
  'utf8'
));

// agyNativeAuth 构造 Antigravity 的原生凭据形状。
function agyNativeAuth(email) {
  return {
    email,
    oauthToken: { accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token' }
  };
}

test('the contract declares the vector this module implements', () => {
  assert.equal(CONTRACT.provider, 'agy');
  assert.equal(CONTRACT.kind, 'oauth');
  assert.equal(CONTRACT.seed_prefix, 'oauth:agy:');
  assert.equal(CONTRACT.source_field, 'nativeAuth.email');
  assert.equal(CONTRACT.vectors.length >= 17, true);
});

test('every shared vector resolves to the same seed and accountRef', () => {
  for (const vector of CONTRACT.vectors) {
    const result = identity.resolveNativeAuthIdentitySeed('agy', agyNativeAuth(vector.email));
    assert.equal(
      result.identitySeed,
      vector.want_identity_seed,
      `identity seed mismatch for vector: ${vector.name}`
    );
    if (!vector.want_identity_seed) {
      assert.equal(result.degraded, true, `vector should stay unverifiable: ${vector.name}`);
      continue;
    }
    assert.equal(
      getPublicAccountRef(`unique:${result.identitySeed}`),
      vector.want_account_ref,
      `accountRef mismatch for vector: ${vector.name}`
    );
  }
});

test('email normalization mirrors the Go rules', () => {
  // 接受
  assert.equal(normalizeEmailComponent('user@example.com'), 'user@example.com');
  assert.equal(normalizeEmailComponent('USER@Example.COM'), 'user@example.com');
  assert.equal(normalizeEmailComponent(' user@example.com '), 'user@example.com');
  assert.equal(normalizeEmailComponent('user@localhost'), 'user@localhost');
  assert.equal(normalizeEmailComponent('user+tag@example.com'), 'user+tag@example.com');
  assert.equal(normalizeEmailComponent('user@[127.0.0.1]'), 'user@[127.0.0.1]');

  // 拒绝：Go 的 mail.ParseAddress 会拒绝，Node 必须同样拒绝
  assert.equal(normalizeEmailComponent('user:tag@example.com'), '');
  assert.equal(normalizeEmailComponent('user..name@example.com'), '');
  assert.equal(normalizeEmailComponent('.user@example.com'), '');
  assert.equal(normalizeEmailComponent('user.@example.com'), '');
  assert.equal(normalizeEmailComponent('"a b"@example.com'), '');
  assert.equal(normalizeEmailComponent('user@example.com.'), '');
  assert.equal(normalizeEmailComponent('@example.com'), '');
  assert.equal(normalizeEmailComponent('user@'), '');
  assert.equal(normalizeEmailComponent('no-at-sign'), '');
  assert.equal(normalizeEmailComponent('a b@c.com'), '');
  assert.equal(normalizeEmailComponent(''), '');
  assert.equal(normalizeEmailComponent(null), '');
  // 长度上限与 Go 一致（320）
  assert.equal(normalizeEmailComponent(`${'a'.repeat(320)}@x.com`), '');
});
