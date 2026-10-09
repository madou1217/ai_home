'use strict';

const { isAccountRef } = require('../../../server/account-ref-store');

const PINNED_ACCOUNT_HEADER = 'x-account-ref';

// OAuth 与 API key 账号都经网关钉选 relay，用量与可用率才能统一记账；
// 宿主默认账号（set-default）的直连不走这里。
function shouldRelayClaudeAccount(input = {}) {
  return String(input.provider || '').trim().toLowerCase() === 'claude'
    && isAccountRef(String(input.accountRef || '').trim())
    && input.isLogin !== true
    && input.gateway !== true;
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
  shouldRelayClaudeAccount
};
