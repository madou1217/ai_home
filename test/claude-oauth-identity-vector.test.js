'use strict';

// Cross-language pin for the Claude OAuth identity vector.
//
// The vectors live in `contracts/claude-oauth-identity.json` and are read by the
// Go suite too (`core/accounts/claude/oauth_identity_contract_test.go`). Both
// sides derive `accountRef` as `acct_` + sha256('unique:' + seed)[:20], so a
// divergence here mints a second account for the same Claude account.
//
// The divergences this pins were real: Node used to keep the UUID's original
// case, accept a non-UUID string, and trim an untrimmed value — while Go
// lowercases, enforces the UUID shape, and rejects an untrimmed value outright.
//
// See docs/architecture/codex-oauth-identity-vector-adr.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const identity = require('../lib/account/account-identity');
const { normalizeUuidComponent } = require('../lib/account/identity-components');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');

const CONTRACT = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'contracts', 'claude-oauth-identity.json'),
  'utf8'
));

// claudeCredential 构造 Claude Code 的 .credentials.json 形状。
function claudeCredential(vector) {
  const account = { uuid: vector.account_uuid };
  if (vector.account_email) account.email = vector.account_email;
  return {
    credentials: {
      claudeAiOauth: {
        accessToken: 'synthetic-access-token',
        refreshToken: 'synthetic-refresh-token',
        account
      }
    }
  };
}

test('the contract declares the vector this module implements', () => {
  assert.equal(CONTRACT.provider, 'claude');
  assert.equal(CONTRACT.kind, 'oauth');
  assert.equal(CONTRACT.seed_prefix, 'oauth:claude:uuid:');
  assert.equal(CONTRACT.source_field, 'claudeAiOauth.account.uuid');
  assert.equal(CONTRACT.vectors.length >= 10, true);
});

test('every shared vector resolves to the same seed and accountRef', () => {
  for (const vector of CONTRACT.vectors) {
    const result = identity.resolveNativeAuthIdentitySeed('claude', claudeCredential(vector));
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

test('an uppercase uuid produces the same account as the lowercase form', () => {
  // The regression this contract exists for: case-preservation made one account
  // into two. Go lowercases, so Node must too.
  const lower = CONTRACT.vectors[0].account_uuid;
  const upper = CONTRACT.vectors.find((v) => v.name.includes('uppercase'));
  assert.ok(upper);

  const lowerSeed = identity.resolveNativeAuthIdentitySeed('claude', claudeCredential({ account_uuid: lower })).identitySeed;
  const upperSeed = identity.resolveNativeAuthIdentitySeed('claude', claudeCredential(upper)).identitySeed;
  assert.equal(upperSeed, lowerSeed);
  assert.equal(upperSeed, upperSeed.toLowerCase());
});

test('an email next to the uuid never becomes the identity', () => {
  // Node tries the email vector before the UUID branch, so this pins that the
  // email location Claude Code actually uses does not hijack the identity.
  const withEmail = CONTRACT.vectors.find((v) => v.account_email);
  assert.ok(withEmail);
  const result = identity.resolveNativeAuthIdentitySeed('claude', claudeCredential(withEmail));
  assert.equal(result.identitySeed, withEmail.want_identity_seed);
  assert.equal(result.identitySeed.includes('@'), false);
});

test('uuid normalization mirrors the Go rules', () => {
  assert.equal(normalizeUuidComponent('1fb09d73-89ab-cdef-0123-456789abcdef'), '1fb09d73-89ab-cdef-0123-456789abcdef');
  assert.equal(normalizeUuidComponent('1FB09D73-89AB-CDEF-0123-456789ABCDEF'), '1fb09d73-89ab-cdef-0123-456789abcdef');
  // Go rejects an untrimmed value rather than trimming it.
  assert.equal(normalizeUuidComponent(' 1fb09d73-89ab-cdef-0123-456789abcdef '), '');
  assert.equal(normalizeUuidComponent('not-a-uuid'), '');
  assert.equal(normalizeUuidComponent(''), '');
  assert.equal(normalizeUuidComponent(null), '');
  assert.equal(normalizeUuidComponent(undefined), '');
  assert.equal(normalizeUuidComponent(42), '');
});
