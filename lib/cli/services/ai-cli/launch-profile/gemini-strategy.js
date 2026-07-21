'use strict';

/**
 * Gemini launch isolation (OAuth only).
 *
 * Gemini keys its whole base directory off `GEMINI_CLI_HOME` (falling back to
 * `~/.gemini`): per-account `oauth_creds.json` / `google_accounts.json` /
 * `projects.json` live there, while the shared session pieces (`history`, `tmp`,
 * `settings.json`, `installation_id`) are symlinked back to the real `~/.gemini`
 * by the existing session-store step. So isolation = per-account `GEMINI_CLI_HOME`
 * pointing at `<sandbox>/.gemini`; no HOME/XDG override is needed (Gemini reads
 * `GEMINI_CLI_HOME`, not HOME, for its base dir).
 *
 * Verified: with `GEMINI_CLI_HOME=<account>/.gemini` and the real HOME, Gemini
 * loads the per-account OAuth credentials without a re-login prompt.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { sandboxDir, path } = ctx;
  const geminiDir = path.join(sandboxDir, '.gemini');
  return {
    set: {
      GEMINI_CLI_HOME: geminiDir,
      // Preserve the historical system-settings pointer (same path the fake-HOME
      // setup resolved to). settings.json itself is a symlink to the shared
      // ~/.gemini/settings.json, so settings stay共用.
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(geminiDir, 'settings.json')
    },
    unset: []
  };
}

const geminiStrategy = Object.freeze({
  name: 'gemini-shared-sessions',
  buildEnvPatch
});

module.exports = { geminiStrategy };
