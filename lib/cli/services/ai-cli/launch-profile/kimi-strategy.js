'use strict';

const { buildSharedCacheEnv } = require('./home-redirect-strategy');

function buildEnvPatch(ctx) {
  const { hostHomeDir, path, sandboxDir } = ctx || {};
  const set = { KIMI_CODE_HOME: sandboxDir };
  if (hostHomeDir) {
    Object.assign(set, {
      HOME: hostHomeDir,
      USERPROFILE: hostHomeDir,
      ...buildSharedCacheEnv(hostHomeDir, path)
    });
  }
  return { set, unset: ['MOONSHOT_API_KEY'] };
}

const kimiStrategy = Object.freeze({
  name: 'kimi-code-home',
  buildEnvPatch
});

module.exports = { kimiStrategy, buildEnvPatch };
