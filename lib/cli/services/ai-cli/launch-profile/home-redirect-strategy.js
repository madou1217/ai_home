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
  // agy 1.x checks SSH_CONNECTION (not only SSH_CLIENT/SSH_TTY) before it
  // decides whether to consult the native keyring. Keep the synthetic SSH
  // tuple complete so a CLI account remains on its projected file credentials.
  SSH_CONNECTION: '127.0.0.1 12345 127.0.0.1 22',
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
 * 覆盖口径：能用环境变量重定向的一律用环境变量（应用感知不到，且能扛住它自己的
 * `rm -rf <cache>`/重建）；环境变量覆盖不到的固定路径（macOS 的 `Library/Caches`）
 * 由 `shared-host-caches.js` 在启动前做符号链接兜底。
 *
 * @param {string} hostHomeDir
 * @param {{ join: Function }} path
 * @param {string} [platform] 默认取 process.platform；显式传入便于按平台测试
 * @returns {Object<string,string>}
 */
function buildSharedCacheEnv(hostHomeDir, path, platform) {
  if (!hostHomeDir) return {};
  const targetPlatform = String(platform || process.platform || '').toLowerCase();
  const homebrewCache = targetPlatform === 'darwin'
    ? path.join(hostHomeDir, 'Library', 'Caches', 'Homebrew')
    : path.join(hostHomeDir, '.cache', 'Homebrew');
  return {
    XDG_CACHE_HOME: path.join(hostHomeDir, '.cache'),
    CARGO_HOME: path.join(hostHomeDir, '.cargo'),
    GOPATH: path.join(hostHomeDir, 'go'),
    GOMODCACHE: path.join(hostHomeDir, 'go', 'pkg', 'mod'),
    GOCACHE: path.join(hostHomeDir, '.cache', 'go-build'),
    npm_config_cache: path.join(hostHomeDir, '.npm'),
    // pnpm 的 store 是内容寻址的，多账号共用一份即可；npm 风格的配置变量 pnpm 也认。
    npm_config_store_dir: path.join(hostHomeDir, '.pnpm-store'),
    PIP_CACHE_DIR: path.join(hostHomeDir, '.cache', 'pip'),
    UV_CACHE_DIR: path.join(hostHomeDir, '.cache', 'uv'),
    COMPOSER_CACHE_DIR: path.join(hostHomeDir, '.cache', 'composer'),
    // Homebrew 在 macOS 上不跟随 XDG_CACHE_HOME，只认 HOMEBREW_CACHE。
    HOMEBREW_CACHE: homebrewCache
  };
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { sandboxDir, hostHomeDir, path, platform } = ctx;

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

  if (String(platform || '').toLowerCase() === 'win32') {
    const parsedHome = path.win32.parse(sandboxDir);
    if (parsedHome.root && /^[a-z]:\\$/i.test(parsedHome.root)) {
      set.HOMEDRIVE = parsedHome.root.slice(0, 2);
      set.HOMEPATH = sandboxDir.slice(parsedHome.root.length - 1);
    }
  }

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
