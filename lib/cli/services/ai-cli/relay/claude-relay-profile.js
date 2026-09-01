'use strict';

// claude 的 relay 实现仍是 ../claude-account-relay.js（server 侧
// native-session-chat-env.js 是生成文件，直接引用它，不能搬动）；
// 本模块只是把它纳入 CliRelayProfile 注册表，行为完全不变。
const {
  buildClaudeAccountRelayEnv,
  shouldRelayClaudeAccount
} = require('../claude-account-relay');

const claudeRelayProfile = Object.freeze({
  provider: 'claude',
  shouldRelayAccount: shouldRelayClaudeAccount,
  buildAccountRelayEnv: buildClaudeAccountRelayEnv,
  buildGatewayProfileEnv(urls) {
    // Anthropic SDK 会在 base URL 后自行拼 /v1/messages，所以给裸 root。
    return {
      ANTHROPIC_API_KEY: urls.apiKey,
      ANTHROPIC_BASE_URL: urls.rootUrl
    };
  }
});

module.exports = { claudeRelayProfile };
