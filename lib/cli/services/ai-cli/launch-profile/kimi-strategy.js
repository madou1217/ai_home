'use strict';

const { buildSharedCacheEnv } = require('./home-redirect-strategy');
const { prepareKimiConfig } = require('./kimi-config');

function buildEnvPatch(ctx) {
  const { baseEnv, hostHomeDir, path, sandboxDir } = ctx || {};
  const apiKey = String(baseEnv && baseEnv.MOONSHOT_API_KEY || '').trim();
  const set = {
    // Kimi 0.36.0 resolves all native state below KIMI_CODE_HOME. The
    // projection root itself is reserved for AIH bookkeeping and legacy
    // migration; pointing the CLI at the native subdirectory keeps config,
    // credentials, and device_id in one account-private tree.
    KIMI_CODE_HOME: path.join(sandboxDir, '.kimi-code'),
    // buildHostScopedBaseEnv removes provider-home keys before applying this
    // patch. Re-add only the account-selected API key; an OAuth account must
    // never inherit the host's MOONSHOT_API_KEY.
    ...(apiKey ? { MOONSHOT_API_KEY: apiKey } : {})
  };
  if (hostHomeDir) {
    Object.assign(set, {
      HOME: hostHomeDir,
      USERPROFILE: hostHomeDir,
      ...buildSharedCacheEnv(hostHomeDir, path)
    });
  }
  return { set, unset: apiKey ? [] : ['MOONSHOT_API_KEY'] };
}

const kimiStrategy = Object.freeze({
  name: 'kimi-code-home',
  prepare: prepareKimiConfig,
  buildEnvPatch
});

module.exports = { kimiStrategy, prepare: prepareKimiConfig, buildEnvPatch };
