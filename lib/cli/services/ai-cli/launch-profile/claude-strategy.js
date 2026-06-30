'use strict';

/**
 * Claude launch isolation.
 *
 * Every account uses `CLAUDE_CONFIG_DIR=<sandbox>/.claude` so shared session
 * pieces
 * (`history.jsonl`, `projects`, `shell-snapshots`, `.claude.json`) are symlinked
 * back to the real `~/.claude` by the session-store step. API credential
 * accounts scrub the account-owned `.credentials.json` file from that config
 * dir before spawn; credential isolation must not split session state.
 *
 * The only change from the historical setup is that HOME is left REAL: Claude's
 * native self-updater / `doctor` find `~/.local/bin/claude` again, and we never
 * inject a static OAuth token (which would bypass Claude's own token refresh and
 * die on expiry).
 *
 * Claude Code 2.1.x checks the macOS Keychain first when USER is present. A stale
 * per-config keychain item can shadow a valid account-owned .credentials.json, so
 * normal launches unset USER and let Claude read the file. Login keeps USER so
 * the native OAuth flow writes to its expected keychain account.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

const { shouldDisableAdvisorForBaseUrl } = require('../../../../account/anthropic-endpoint');

const CLAUDE_CONFIG_DIR = '.claude';

function hasNonEmptyEnv(env, key) {
  return Boolean(env && typeof env === 'object' && String(env[key] || '').trim());
}

function hasClaudeApiCredential(ctx) {
  return hasNonEmptyEnv(ctx && ctx.baseEnv, 'ANTHROPIC_API_KEY')
    || hasNonEmptyEnv(ctx && ctx.baseEnv, 'ANTHROPIC_AUTH_TOKEN');
}

function getClaudeConfigDir(ctx) {
  return ctx.path.join(ctx.sandboxDir, CLAUDE_CONFIG_DIR);
}

function prepare(ctx) {
  if (!hasClaudeApiCredential(ctx)) return;
  const fs = ctx && ctx.fs;
  if (!fs || typeof fs.mkdirSync !== 'function') return;

  const configDir = getClaudeConfigDir(ctx);
  fs.mkdirSync(configDir, { recursive: true });

  // API credential launches must not expose claude.ai OAuth artifacts to Claude Code.
  // The file is account-owned; shared session entries remain symlinked.
  if (typeof fs.rmSync === 'function') {
    fs.rmSync(ctx.path.join(configDir, '.credentials.json'), { force: true });
  }
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
// Disable the first-party-only advisor server tool when the account talks
// directly to a non-official Anthropic endpoint. Claude Code injects advisor
// (tool variant `advisor_20260301` + `advisor-tool-*` beta) unconditionally for
// custom base URLs; strict third-party endpoints (e.g. DeepSeek) 400 on it, and
// on the rest (GLM/Zhipu, ...) it is inert since only api.anthropic.com can
// execute it. `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` makes the binary skip both the
// tool and the beta header. The endpoint policy (empty/official/self-relay →
// keep advisor) lives in account/anthropic-endpoint.
function buildEnvPatch(ctx) {
  const unset = ctx && ctx.isLogin ? [] : ['USER'];
  const set = { CLAUDE_CONFIG_DIR: getClaudeConfigDir(ctx) };
  const baseUrl = ctx && ctx.baseEnv && ctx.baseEnv.ANTHROPIC_BASE_URL;
  if (shouldDisableAdvisorForBaseUrl(baseUrl)) {
    set.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1';
  }
  return { set, unset };
}

const claudeStrategy = Object.freeze({
  name: 'claude-config-dir',
  prepare,
  buildEnvPatch
});

module.exports = { claudeStrategy };
