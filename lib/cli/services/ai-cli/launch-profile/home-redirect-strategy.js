'use strict';

/**
 * Home-redirect isolation: point HOME / XDG / config-dirs at the per-account
 * profile directory so the CLI reads its credentials and config from there.
 *
 * This is the fallback for providers without a dedicated strategy. Providers
 * with mixed private/shared roots (such as AGY) own that topology in a focused
 * strategy instead of growing provider branches here.
 *
 * @typedef {Object} SandboxLaunchContext
 * @property {string} cliName            provider id (claude/codex/gemini/agy)
 * @property {string} sandboxDir         per-account profile directory
 * @property {string} codexConfigDir     `<sandboxDir>/.codex`
 * @property {string} codexSqliteHome    resolved codex sqlite home ('' if n/a)
 * @property {string} hostHomeDir        the real host home (for shared caches)
 * @property {{ join: Function }} path    injected node:path (testable)
 * @property {Object<string,string>} baseEnv provider launch environment
 *
 * @typedef {Object} SandboxEnvPatch
 * @property {Object<string,string>} set  env vars merged over the base env
 * @property {string[]} unset             env var names deleted after the merge
 */

// AGY (Antigravity) reads the macOS/login keyring for identity; in a multi-account
// sandbox that cross-binds accounts. Pretending to run inside a remote/container
// shell makes it fall back to file-based credentials instead.
const AGY_KEYCHAIN_BYPASS_ENV = Object.freeze({
  SSH_CLIENT: '127.0.0.1 12345 22',
  SSH_TTY: '/dev/tty',
  container: 'docker',
  WSL_DISTRO_NAME: 'Ubuntu'
});

/**
 * Regenerable tool/build caches that must NEVER be duplicated per account.
 * With a fake HOME, Rust/Go/npm/XDG tools would otherwise write gigabytes into
 * each account dir; we point them at the shared real home instead. Identity/state
 * (XDG_DATA/STATE_HOME, the provider config dirs) stays per-account.
 *
 * @param {string} hostHomeDir
 * @param {{ join: Function }} path
 * @returns {Object<string,string>}
 */
function buildSharedCacheEnv(hostHomeDir, path) {
  if (!hostHomeDir) return {};
  return {
    XDG_CACHE_HOME: path.join(hostHomeDir, '.cache'),
    CARGO_HOME: path.join(hostHomeDir, '.cargo'),
    GOPATH: path.join(hostHomeDir, 'go'),
    GOMODCACHE: path.join(hostHomeDir, 'go', 'pkg', 'mod'),
    GOCACHE: path.join(hostHomeDir, '.cache', 'go-build'),
    npm_config_cache: path.join(hostHomeDir, '.npm')
  };
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { sandboxDir, hostHomeDir, path } = ctx;

  const set = {
    HOME: sandboxDir,
    USERPROFILE: sandboxDir,
    XDG_CONFIG_HOME: sandboxDir,
    XDG_DATA_HOME: path.join(sandboxDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(sandboxDir, '.local', 'state'),
    // Shared regenerable caches — keep HOME=sandbox for identity, but never
    // duplicate build caches per account (the cause of the multi-GB bloat).
    ...buildSharedCacheEnv(hostHomeDir, path)
  };
  const unset = [];

  return { set, unset };
}

const homeRedirectStrategy = Object.freeze({
  name: 'home-redirect',
  buildEnvPatch
});

module.exports = {
  homeRedirectStrategy,
  buildSharedCacheEnv,
  buildEnvPatch,
  AGY_KEYCHAIN_BYPASS_ENV
};
