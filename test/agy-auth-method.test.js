'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AGY_CLI_AUTH_METHOD } = require('../lib/account/agy-auth-metadata');
const { normalizeAntigravityAccountRecord } = require('../lib/account/transfer-core');

// The interactive Antigravity CLI rejects any auth_method other than "consumer"
// ("Unknown auth method"). aih used to hardcode "oauth", which left synced accounts
// stuck at the login menu. Lock the value + the import defaults so it can't regress.
test('AGY_CLI_AUTH_METHOD is consumer (the only value the antigravity CLI accepts)', () => {
  assert.equal(AGY_CLI_AUTH_METHOD, 'consumer');
});

test('agy import (array form) defaults auth_method to consumer, never oauth', () => {
  const rec = normalizeAntigravityAccountRecord(['user@example.com', 'refresh-abc']);
  assert.equal(rec.auth_method, 'consumer');
  assert.notEqual(rec.auth_method, 'oauth');
});

test('agy import (object form) defaults auth_method to consumer when absent', () => {
  const rec = normalizeAntigravityAccountRecord({ email: 'a@b.com', refresh_token: 'r' });
  assert.equal(rec.auth_method, 'consumer');
});

test('agy import preserves an explicit source auth_method', () => {
  const rec = normalizeAntigravityAccountRecord({ email: 'a@b.com', refresh_token: 'r', auth_method: 'enterprise' });
  assert.equal(rec.auth_method, 'enterprise');
});
