'use strict';

// Cross-language pin for the Codex OAuth identity vector.
//
// The vectors live in `contracts/codex-oauth-identity.json` and are read by the
// Go suite too (`core/accounts/codex/oauth_identity_contract_test.go`). Both
// sides derive `accountRef` as `acct_` + sha256('unique:' + seed)[:20], so a
// one-character divergence in the seed silently mints a second account for the
// same upstream account — this file turns that into a failing test.
//
// See docs/architecture/codex-oauth-identity-vector-adr.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CODEX_AUTH_CLAIM_NAMESPACE,
  buildCodexOAuthIdentitySeed,
  isCodexIdentityComponent,
  resolveCodexIdentityUserId,
  trimGoSpace
} = require('../lib/account/codex-auth-metadata');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');

const CONTRACT = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'contracts', 'codex-oauth-identity.json'),
  'utf8'
));

test('the contract declares the vector this module implements', () => {
  assert.equal(CONTRACT.provider, 'codex');
  assert.equal(CONTRACT.kind, 'oauth');
  assert.equal(CONTRACT.seed_prefix, 'oauth:codex:');
  assert.equal(CONTRACT.claim_namespace, CODEX_AUTH_CLAIM_NAMESPACE);
  assert.equal(CONTRACT.source_token, 'id_token');
  assert.deepEqual(CONTRACT.user_id_claim_order, ['chatgpt_user_id', 'user_id', 'sub']);
  assert.equal(CONTRACT.vectors.length >= 13, true);
});

test('every shared vector resolves to the same user id, seed and accountRef', () => {
  for (const vector of CONTRACT.vectors) {
    const auth = { tokens: vector.tokens };

    assert.equal(
      resolveCodexIdentityUserId(auth),
      vector.want_user_id,
      `user id mismatch for vector: ${vector.name}`
    );
    assert.equal(
      buildCodexOAuthIdentitySeed(auth),
      vector.want_identity_seed,
      `identity seed mismatch for vector: ${vector.name}`
    );
    if (!vector.want_identity_seed) continue;
    assert.equal(
      getPublicAccountRef(`unique:${buildCodexOAuthIdentitySeed(auth)}`),
      vector.want_account_ref,
      `accountRef mismatch for vector: ${vector.name}`
    );
  }
});

test('an unverifiable credential yields no seed and no ref of its own', () => {
  const verifiedRefs = new Set(
    CONTRACT.vectors.filter((v) => v.want_account_ref).map((v) => v.want_account_ref)
  );
  let unverifiable = 0;
  for (const vector of CONTRACT.vectors) {
    if (vector.want_identity_seed) continue;
    unverifiable += 1;
    const seed = buildCodexOAuthIdentitySeed({ tokens: vector.tokens });
    assert.equal(seed, '', `vector should stay unverifiable: ${vector.name}`);
    // The caller derives the ref from the seed, so an empty seed must not
    // produce a ref that collides with any real identity. `getPublicAccountRef`
    // still hashes the literal `unique:` here, which is exactly why callers
    // must branch on the empty seed instead of calling it unconditionally.
    assert.equal(verifiedRefs.has(getPublicAccountRef(`unique:${seed}`)), false);
  }
  assert.equal(unverifiable >= 6, true, 'the contract should pin several unverifiable cases');
});

test('the email never participates in the identity vector', () => {
  // The regression this whole ADR exists for: an account whose credential only
  // carries an email must be unverifiable, not silently identified by email.
  const emailOnly = {
    tokens: {},
    email: 'user@example.com',
    account: { email: 'user@example.com' }
  };
  assert.equal(buildCodexOAuthIdentitySeed(emailOnly), '');

  // And a valid user id must win over any email that is also present.
  const withEmail = {
    ...CONTRACT.vectors[0],
    email: 'user@example.com'
  };
  const seed = buildCodexOAuthIdentitySeed({ tokens: withEmail.tokens });
  assert.equal(seed, CONTRACT.vectors[0].want_identity_seed);
  assert.equal(seed.includes('@'), false);
});

test('the access token is never consulted for identity', () => {
  // Both tokens carry the same claims in the contract's first vector; the
  // access-only vector must still be unverifiable.
  const accessOnly = CONTRACT.vectors.find((v) => v.name.includes('access token are ignored'));
  assert.ok(accessOnly);
  assert.equal(buildCodexOAuthIdentitySeed({ tokens: accessOnly.tokens }), '');
});

test('identity component validation mirrors the Go rules', () => {
  assert.equal(isCodexIdentityComponent('user-123'), true);
  assert.equal(isCodexIdentityComponent('  user-123  '), true);
  assert.equal(isCodexIdentityComponent('user_123.email@example.com'), true);

  // Colon would make the colon-separated seed ambiguous.
  assert.equal(isCodexIdentityComponent('user:123'), false);
  // Go rejects utf8.RuneError and control characters.
  assert.equal(isCodexIdentityComponent('user\uFFFD123'), false);
  assert.equal(isCodexIdentityComponent('user\u0000123'), false);
  assert.equal(isCodexIdentityComponent('user\u007f123'), false);
  // Empty after trimming.
  assert.equal(isCodexIdentityComponent(''), false);
  assert.equal(isCodexIdentityComponent('   '), false);
  assert.equal(isCodexIdentityComponent(null), false);
  assert.equal(isCodexIdentityComponent(undefined), false);
});

test('trimGoSpace covers the code points Go trims but JS trim does not', () => {
  // U+0085 (NEL) is in Go's unicode.IsSpace set but not in JS WhiteSpace.
  assert.equal(trimGoSpace('\u0085user-123'), 'user-123');
  assert.equal('\u0085user-123'.trim(), '\u0085user-123');
  // U+00A0 (NBSP) is trimmed by both, but must stay trimmed here too.
  assert.equal(trimGoSpace('\u00a0user-123\u00a0'), 'user-123');
  // Interior whitespace is untouched.
  assert.equal(trimGoSpace('user 123'), 'user 123');
});
