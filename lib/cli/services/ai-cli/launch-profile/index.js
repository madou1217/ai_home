'use strict';

const { homeRedirectStrategy } = require('./home-redirect-strategy');
const { agyStrategy } = require('./agy-strategy');
const { claudeStrategy } = require('./claude-strategy');
const { codexStrategy } = require('./codex-strategy');
const { geminiStrategy } = require('./gemini-strategy');
const { opencodeStrategy } = require('./opencode-strategy');

/**
 * Provider launch-isolation registry.
 *
 * A ProviderLaunchStrategy owns how one provider account is isolated at spawn
 * time: which environment variables to inject and which to remove (see
 * `SandboxEnvPatch`). The runtime caller depends only on this abstraction
 * (Dependency Inversion) and never branches on provider name itself.
 *
 * - claude / codex / gemini: shared config/sessions + per-process credential,
 *   real HOME preserved.
 * - agy: home-redirect — it hardcodes `$HOME/.gemini/antigravity-cli` with no
 *   config-dir override, so it MUST relocate via HOME. Not a legacy shim; it is
 *   agy's only correct isolation.
 *
 * Adding/altering a provider's isolation = editing one strategy + this map
 * (Open/Closed); the runtime caller stays untouched.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 * @typedef {Object} ProviderLaunchStrategy
 * @property {string} name
 * @property {(ctx: SandboxLaunchContext) => SandboxEnvPatch} buildEnvPatch
 */

/** @type {Object<string, ProviderLaunchStrategy>} */
const STRATEGY_BY_PROVIDER = {
  claude: claudeStrategy,
  codex: codexStrategy,
  gemini: geminiStrategy,
  agy: agyStrategy,
  opencode: opencodeStrategy
};

/**
 * @param {string} cliName
 * @returns {ProviderLaunchStrategy}
 */
function getProviderLaunchStrategy(cliName) {
  return STRATEGY_BY_PROVIDER[String(cliName || '').trim()] || homeRedirectStrategy;
}

module.exports = {
  getProviderLaunchStrategy,
  STRATEGY_BY_PROVIDER
};
