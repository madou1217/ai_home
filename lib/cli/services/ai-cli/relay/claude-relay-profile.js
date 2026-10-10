'use strict';

// claude 的 relay 实现仍是 ../claude-account-relay.js（server 侧
// native-session-chat-env.js 是生成文件，直接引用它，不能搬动）；
// 本模块把它纳入 CliRelayProfile 注册表。
const {
  buildClaudeAccountRelayEnv,
  buildClaudeLaunchSettingsArgs,
  shouldRelayClaudeAccount
} = require('../claude-account-relay');

const claudeRelayProfile = Object.freeze({
  provider: 'claude',
  shouldRelayAccount: shouldRelayClaudeAccount,
  buildAccountRelayEnv: buildClaudeAccountRelayEnv,
  // 启动整形：relay / AIH Server 的地址与钉选头经 --settings 交给 Claude，压过宿主
  // settings.json 的 env（见 buildClaudeLaunchSettingsArgs）。登录启动不碰。
  buildRelayLaunch({ args, accountEnv, isLogin }) {
    if (isLogin) return null;
    const settingsArgs = buildClaudeLaunchSettingsArgs(accountEnv, args);
    return settingsArgs.length > 0 ? { args: [...settingsArgs, ...(args || [])] } : null;
  },
  buildGatewayProfileEnv(urls) {
    // Anthropic SDK 会在 base URL 后自行拼 /v1/messages，所以给裸 root。
    return {
      ANTHROPIC_API_KEY: urls.apiKey,
      ANTHROPIC_BASE_URL: urls.rootUrl
    };
  }
});

module.exports = { claudeRelayProfile };
