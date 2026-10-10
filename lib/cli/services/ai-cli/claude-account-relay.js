'use strict';

const { isAccountRef } = require('../../../server/account-ref-store');

const PINNED_ACCOUNT_HEADER = 'x-account-ref';

// OAuth 与 API key 账号都经网关钉选 relay，用量与可用率才能统一记账。API key 账号设为
// 宿主默认时同样写成钉选 relay（host-sync）；只有 OAuth 宿主默认投射原生登录态直连。
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

function hasSettingsArg(args) {
  return (Array.isArray(args) ? args : [])
    .some((arg) => arg === '--settings' || String(arg).startsWith('--settings='));
}

/**
 * aih 自己启动 Claude 时，把网关地址与钉选头经 --settings 再交一次：Claude Code 会用
 * ~/.claude/settings.json 的 env 覆盖进程环境，而 --settings 的优先级高于它，宿主默认
 * 账号写进 settings 的配置因此劫持不了 aih 的启动。argv 对本机可见，只放不含密钥的字段；
 * 钉选头为空时同样写出，显式清掉宿主默认的钉选（不钉选 = AIH Server 账号池）。
 */
function buildClaudeLaunchSettingsArgs(launchEnv = {}, args = []) {
  const baseUrl = String(launchEnv.ANTHROPIC_BASE_URL || '').trim();
  if (!baseUrl || hasSettingsArg(args)) return [];
  return ['--settings', JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_CUSTOM_HEADERS: String(launchEnv.ANTHROPIC_CUSTOM_HEADERS || '')
    }
  })];
}

module.exports = {
  PINNED_ACCOUNT_HEADER,
  buildClaudeAccountRelayEnv,
  buildClaudeLaunchSettingsArgs,
  shouldRelayClaudeAccount
};
