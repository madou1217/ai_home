'use strict';

/**
 * Codex launch isolation.
 *
 * Unlike Claude, Codex encodes per-account *provider routing* in
 * `$CODEX_HOME/config.toml` (`model_provider`, `model_providers`, base URLs) and
 * its credential in `$CODEX_HOME/auth.json` — both genuinely differ per account,
 * so Codex cannot collapse onto a single shared config directory. What it *can*
 * share is the session store, which Codex exposes separately via
 * `CODEX_SQLITE_HOME`.
 *
 * So the isolation unit is: per-account `CODEX_HOME` (routing + auth) + shared
 * `CODEX_SQLITE_HOME` (sessions). Crucially we no longer override HOME/XDG — Codex
 * keys entirely off `CODEX_HOME`/`CODEX_SQLITE_HOME`, so the fake-HOME (and the
 * profile bloat it caused) is unnecessary.
 *
 * The per-account `config.toml`/`auth.json` materialization still happens in the
 * runtime's existing codex config-sync step; this strategy only owns the env.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { codexConfigDir, codexSqliteHome } = ctx;
  const set = {
    CODEX_HOME: codexConfigDir
  };
  if (codexSqliteHome) {
    set.CODEX_SQLITE_HOME = codexSqliteHome;
  }
  // OPENAI_BASE_URL is migrated into config.toml; never leak it into env.
  return { set, unset: ['OPENAI_BASE_URL'] };
}

const codexStrategy = Object.freeze({
  name: 'codex-shared-sessions',
  buildEnvPatch
});

module.exports = { codexStrategy };
