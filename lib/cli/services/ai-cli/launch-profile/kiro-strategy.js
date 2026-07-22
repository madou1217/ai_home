'use strict';

const { buildSharedCacheEnv } = require('./home-redirect-strategy');

function prepare(ctx) {
  const { fs, path, sandboxDir } = ctx || {};
  if (!fs || !path || !sandboxDir) return;
  fs.mkdirSync(sandboxDir, { recursive: true });
  fs.mkdirSync(path.join(sandboxDir, '.kiro', 'settings'), { recursive: true });
}

function buildEnvPatch(ctx) {
  const { hostHomeDir, path, sandboxDir } = ctx || {};
  const set = {
    KIRO_HOME: path.join(sandboxDir, '.kiro'),
    KIRO_TEST_DB_PATH: path.join(sandboxDir, 'data.sqlite3')
  };
  if (hostHomeDir) {
    Object.assign(set, {
      HOME: hostHomeDir,
      USERPROFILE: hostHomeDir,
      ...buildSharedCacheEnv(hostHomeDir, path)
    });
  }
  return { set, unset: ['KIRO_API_KEY'] };
}

const kiroStrategy = Object.freeze({
  name: 'kiro-sqlite-projection',
  prepare,
  buildEnvPatch
});

module.exports = { kiroStrategy, prepare, buildEnvPatch };