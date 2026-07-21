'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClaudeAccountRelayEnv,
  shouldRelayClaudeAccount
} = require('../lib/cli/services/ai-cli/claude-account-relay');

const ACCOUNT_REF = 'acct_1234567890abcdef1234';

test('Claude native OAuth accounts relay through the gateway by accountRef', () => {
  assert.equal(shouldRelayClaudeAccount({
    provider: 'claude',
    accountRef: ACCOUNT_REF,
    accountEnv: {}
  }), true);

  assert.deepEqual(buildClaudeAccountRelayEnv({
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, ACCOUNT_REF), {
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527',
    ANTHROPIC_CUSTOM_HEADERS: `x-account-ref: ${ACCOUNT_REF}`
  });
});

test('Claude relay is disabled for gateway, login, and direct token modes', () => {
  const base = { provider: 'claude', accountRef: ACCOUNT_REF, accountEnv: {} };
  assert.equal(shouldRelayClaudeAccount({ ...base, gateway: true }), false);
  assert.equal(shouldRelayClaudeAccount({ ...base, isLogin: true }), false);
  assert.equal(shouldRelayClaudeAccount({
    ...base,
    accountEnv: { ANTHROPIC_AUTH_TOKEN: 'direct-token' }
  }), false);
});

test('Claude relay rejects mutable CLI ids and accepts only accountRef', () => {
  assert.equal(shouldRelayClaudeAccount({
    provider: 'claude',
    accountRef: '9',
    accountEnv: {}
  }), false);
  assert.throws(
    () => buildClaudeAccountRelayEnv({}, '9'),
    /invalid_claude_relay_account_ref/
  );
});
