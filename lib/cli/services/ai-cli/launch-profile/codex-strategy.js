'use strict';

/**
 * Codex launch isolation.
 *
 * API-key accounts are configured at launch via `-c` provider flags, so they can
 * use the host Codex home for session state without writing per-account auth
 * files. OAuth/file-state accounts still need an account-local CODEX_HOME for
 * auth.json isolation; only SQLite/session state is shared through
 * CODEX_SQLITE_HOME.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { codexConfigDir, codexSqliteHome, baseEnv, isLogin } = ctx;
  const hasLaunchApiKey = Boolean(String(baseEnv && baseEnv.OPENAI_API_KEY || '').trim());
  const set = {
    CODEX_HOME: hasLaunchApiKey && !isLogin
      ? (codexSqliteHome || codexConfigDir)
      : codexConfigDir
  };
  if (codexSqliteHome) {
    set.CODEX_SQLITE_HOME = codexSqliteHome;
  }
  return { set, unset: [] };
}

const codexStrategy = Object.freeze({
  name: 'codex-account-auth-shared-sessions',
  buildEnvPatch
});

module.exports = { codexStrategy };
