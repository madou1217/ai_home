'use strict';

/**
 * Qoder CLI launch isolation (global + CN).
 *
 * Qoder exposes an explicit `--config-dir` override for the user-level config
 * root. Account isolation therefore:
 *   1. keeps the real host HOME (shared caches / PATH / desktop apps),
 *   2. materialises encrypted auth under the per-account runtime dir,
 *   3. injects `--config-dir <runtimeDir>` at spawn (see pty/runtime.js).
 *
 * Env auth: `QODER_PERSONAL_ACCESS_TOKEN` (PAT) is account-scoped and re-injected
 * from the credential store when present.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

const { buildSharedCacheEnv } = require('./home-redirect-strategy');
const { isQoderProvider } = require('../../../../account/qoder-auth-metadata');

const QODER_UNSET_ENV = Object.freeze([
  // Never inherit a host PAT into another account sandbox.
  'QODER_PERSONAL_ACCESS_TOKEN'
]);

/**
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs, sandboxDir } = ctx || {};
  if (!fs || typeof fs.mkdirSync !== 'function') return;
  const configDir = String(sandboxDir || '').trim();
  if (!configDir) return;
  fs.mkdirSync(configDir, { recursive: true });
  // Qoder writes `.auth/machine_id` + encrypted credentials under the config root.
  fs.mkdirSync(ctx.path.join(configDir, '.auth'), { recursive: true });
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { hostHomeDir, path, baseEnv, cliName } = ctx || {};
  const set = {};
  const unset = [...QODER_UNSET_ENV];

  // PAT accounts re-inject from account env after strip; drop host leakage first.
  const accountPat = String(baseEnv && baseEnv.QODER_PERSONAL_ACCESS_TOKEN || '').trim();
  if (accountPat) {
    set.QODER_PERSONAL_ACCESS_TOKEN = accountPat;
  }

  if (hostHomeDir) {
    Object.assign(set, {
      HOME: hostHomeDir,
      USERPROFILE: hostHomeDir,
      ...buildSharedCacheEnv(hostHomeDir, path)
    });
  }

  // CN vs global is entirely determined by the binary; keep env free of region
  // hints that would couple strategies. Mark for diagnostics only.
  if (isQoderProvider(cliName)) {
    set.AIH_QODER_PROVIDER = String(cliName || '').trim();
  }

  return { set, unset };
}

const qoderStrategy = Object.freeze({
  name: 'qoder-config-dir',
  prepare,
  buildEnvPatch
});

module.exports = {
  qoderStrategy,
  prepare,
  buildEnvPatch,
  QODER_UNSET_ENV
};
