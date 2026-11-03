'use strict';

/**
 * Claude launch policy — one host state directory, temporary login auth only.
 *
 * Every normal session points directly at host `~/.claude`. OAuth account
 * selection is handled by the local gateway, so account credentials never
 * require a second Claude state tree. Login alone uses its disposable runtime
 * directory to capture authentication into the account database.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

const { shouldDisableAdvisorForBaseUrl } = require('../../../../account/anthropic-endpoint');

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  // 普通会话也能执行 /login；保留 USER，确保原生 CLI 与 AIH 寻址同一 Keychain 条目。
  var unset = [];
  var configRoot = ctx && ctx.isLogin ? ctx.sandboxDir : ctx.hostHomeDir;
  var set = { CLAUDE_CONFIG_DIR: ctx.path.join(configRoot, '.claude') };
  var baseUrl = ctx && ctx.baseEnv && ctx.baseEnv.ANTHROPIC_BASE_URL;
  if (shouldDisableAdvisorForBaseUrl(baseUrl)) {
    set.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1';
  }
  return { set, unset };
}

const claudeStrategy = Object.freeze({
  name: 'claude-config-dir',
  buildEnvPatch
});

module.exports = { claudeStrategy };
