'use strict';

/**
 * ZCode launch isolation.
 *
 * ZCode reads all shared state (credentials, provider registry, sessions) from
 * one data root selected by ZCODE_DATA_BASE_DIR. Pointing it at the per-account
 * sandbox `.zcode` gives OAuth accounts credential isolation while the storage
 * policy keeps `cli/` and `workspace/` session state provider-shared.
 *
 * API-key accounts additionally receive ZCODE_API_KEY through the provider
 * runtime env passthrough; the projected `v2/config.json` carries the endpoint.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

/**
 * ZCode resolves the data root before loading configuration; ensure the
 * strategy-owned directory exists for new login projections as well as normal
 * account launches.
 *
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const fs = ctx && ctx.fs;
  const dataBaseDir = String(ctx && ctx.zcodeDataBaseDir || '').trim();
  if (!dataBaseDir || !fs || typeof fs.mkdirSync !== 'function') return;
  fs.mkdirSync(dataBaseDir, { recursive: true });
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { sandboxDir, path } = ctx;
  const explicit = String(ctx && ctx.zcodeDataBaseDir || '').trim();
  const dataBaseDir = explicit || (sandboxDir && path ? path.join(sandboxDir, '.zcode') : '');
  const set = {};
  if (dataBaseDir) set.ZCODE_DATA_BASE_DIR = dataBaseDir;
  return { set, unset: [] };
}

const zcodeStrategy = Object.freeze({
  name: 'zcode-data-base-dir',
  prepare,
  buildEnvPatch
});

module.exports = { zcodeStrategy };
