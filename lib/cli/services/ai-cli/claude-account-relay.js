'use strict';

const { isAccountRef } = require('../../../server/account-ref-store');

const PINNED_ACCOUNT_HEADER = 'x-account-ref';

function hasDirectClaudeCredential(accountEnv = {}) {
  return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
    .some((key) => Boolean(String(accountEnv[key] || '').trim()));
}

function shouldRelayClaudeAccount(input = {}) {
  return String(input.provider || '').trim().toLowerCase() === 'claude'
    && isAccountRef(String(input.accountRef || '').trim())
    && input.isLogin !== true
    && input.gateway !== true
    && !hasDirectClaudeCredential(input.accountEnv);
}

function buildClaudeAccountRelayEnv(gatewayEnv = {}, accountRef) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) {
    throw new Error('invalid_claude_relay_account_ref');
  }
  const existingHeaders = String(gatewayEnv.ANTHROPIC_CUSTOM_HEADERS || '').trim();
  const pinHeader = `${PINNED_ACCOUNT_HEADER}: ${normalizedRef}`;
  return {
    ...gatewayEnv,
    ANTHROPIC_CUSTOM_HEADERS: [existingHeaders, pinHeader].filter(Boolean).join('\n')
  };
}

module.exports = {
  PINNED_ACCOUNT_HEADER,
  buildClaudeAccountRelayEnv,
  hasDirectClaudeCredential,
  shouldRelayClaudeAccount
};
