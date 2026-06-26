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
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

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
function buildEnvPatch(ctx) {
  return {
    set: { CLAUDE_CONFIG_DIR: getClaudeConfigDir(ctx) },
    unset: []
  };
}

const claudeStrategy = Object.freeze({
  name: 'claude-config-dir',
  prepare,
  buildEnvPatch
});

module.exports = { claudeStrategy };
