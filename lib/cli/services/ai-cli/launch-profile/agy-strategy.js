'use strict';

const {
  resolveProviderRuntimeHomeRoot
} = require('../../../../runtime/provider-storage-policy');
const {
  AGY_KEYCHAIN_BYPASS_ENV,
  buildSharedCacheEnv
} = require('./home-redirect-strategy');

/**
 * Antigravity hardcodes OAuth under $HOME, so HOME remains the disposable
 * credential projection. Every configurable auxiliary root is redirected to
 * the provider-owned native runtime home instead of the account projection.
 */
function buildEnvPatch(ctx) {
  const { sandboxDir, hostHomeDir, path, platform } = ctx;
  const runtimeHome = resolveProviderRuntimeHomeRoot(hostHomeDir, 'agy', path);
  if (!runtimeHome) {
    const error = new Error('agy_runtime_home_unavailable');
    error.code = 'agy_runtime_home_unavailable';
    throw error;
  }

  const set = {
    HOME: sandboxDir,
    USERPROFILE: sandboxDir,
    ...buildSharedCacheEnv(hostHomeDir, path),
    XDG_CONFIG_HOME: path.join(runtimeHome, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(runtimeHome, 'xdg', 'data'),
    XDG_STATE_HOME: path.join(runtimeHome, 'xdg', 'state'),
    XDG_CACHE_HOME: path.join(runtimeHome, 'xdg', 'cache'),
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(runtimeHome, '.gemini', 'settings.json'),
    ...AGY_KEYCHAIN_BYPASS_ENV
  };
  if (platform === 'win32') {
    set.APPDATA = path.join(runtimeHome, 'AppData', 'Roaming');
    set.LOCALAPPDATA = path.join(runtimeHome, 'AppData', 'Local');
  }

  return {
    set,
    unset: []
  };
}

const agyStrategy = Object.freeze({
  name: 'agy-provider-home',
  buildEnvPatch
});

module.exports = {
  agyStrategy,
  buildEnvPatch
};
