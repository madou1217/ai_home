'use strict';

// claude 的 relay 实现仍是 ../claude-account-relay.js（server 侧
// native-session-chat-env.js 是生成文件，直接引用它，不能搬动）；
// 本模块把它纳入 CliRelayProfile 注册表。
const {
  buildClaudeAccountRelayEnv,
  buildClaudeLaunchSettingsArgs,
  resolveClaudeLaunchSettingsDir,
  shouldRelayClaudeAccount
} = require('../claude-account-relay');
const { buildClaudeHarnessModelLaunch } = require('../claude-harness-models');

const claudeRelayProfile = Object.freeze({
  provider: 'claude',
  shouldRelayAccount: shouldRelayClaudeAccount,
  buildAccountRelayEnv: buildClaudeAccountRelayEnv,
  // 跨 Provider harness：除钉选头外再声明「本请求由 Node 完整实现」（见 route-owner-header）。
  buildCrossProviderEnv(gatewayEnv, accountRef) {
    return buildClaudeAccountRelayEnv(gatewayEnv, accountRef, { crossProvider: true });
  },
  // 启动整形：relay / AIH Server 的地址、钉选头与网关凭据经 --settings 交给 Claude，压过宿主
  // settings.json 的 env（见 buildClaudeLaunchSettingsArgs）。登录启动不碰。
  // 凭据经 <aiHomeDir>/run 下的 0600 文件交付（launchStorage: { fs, aiHomeDir }），argv 不含密钥。
  // 跨 Provider harness（身份账号属于别的 Provider）再叠一层模型整形：钉选账号自己的
  // 模型目录进 modelPicker，未识别 id 的上下文窗口进 env（见 claude-harness-models）。
  buildRelayLaunch({ args, accountEnv, isLogin, launchStorage, crossProvider, accountRef, identityProvider }) {
    if (isLogin) return null;
    const storage = launchStorage || {};
    const harness = crossProvider === true
      ? buildClaudeHarnessModelLaunch({
        args,
        accountRef,
        provider: identityProvider,
        fs: storage.fs,
        aiHomeDir: storage.aiHomeDir
      })
      : null;
    const settingsArgs = buildClaudeLaunchSettingsArgs(
      harness ? { ...accountEnv, ...harness.env } : accountEnv,
      args,
      {
        fs: storage.fs,
        settingsDir: resolveClaudeLaunchSettingsDir(storage.aiHomeDir),
        settings: harness ? harness.settings : null
      }
    );
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
