'use strict';

/**
 * Home-redirect isolation: point HOME / XDG / config-dirs at the per-account
 * profile directory so the CLI reads its credentials and config from there.
 *
 * This is the correct (and only viable) isolation for tools that hardcode their
 * config location relative to HOME and expose no config-dir override — notably
 * `agy` (Antigravity), which reads `$HOME/.gemini/antigravity-cli` and ignores
 * `XDG_CONFIG_HOME`/`GEMINI_CLI_HOME`. It is also the safe default for any
 * provider without a dedicated strategy.
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
  const { cliName, sandboxDir, codexConfigDir, codexSqliteHome, hostHomeDir, path } = ctx;

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

  if (cliName === 'codex') {
    set.CODEX_HOME = codexConfigDir;
    if (codexSqliteHome) {
      set.CODEX_SQLITE_HOME = codexSqliteHome;
    }
    // OPENAI_BASE_URL is migrated into config.toml; never leak it into env.
    unset.push('OPENAI_BASE_URL');
  } else if (cliName === 'claude') {
    set.CLAUDE_CONFIG_DIR = path.join(sandboxDir, '.claude');
  } else if (cliName === 'gemini' || cliName === 'agy') {
    set.GEMINI_CLI_SYSTEM_SETTINGS_PATH = path.join(sandboxDir, '.gemini', 'settings.json');
  }

  if (cliName === 'agy') {
    Object.assign(set, AGY_KEYCHAIN_BYPASS_ENV);
  }

  return { set, unset };
}

// Regenerable caches that Electron/Chromium apps (e.g. Antigravity) and macOS
// recreate on demand. A fake HOME makes these pile up per account under
// `<sandbox>/Library`; we trim them before launch so they can never accumulate.
// All macOS-specific paths — a no-op on other platforms / when absent. We only
// touch well-known *cache* dirs, never identity/state (User, globalStorage,
// Local/Session Storage, IndexedDB, the provider config dirs).
const ELECTRON_CACHE_SUBDIRS = Object.freeze([
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'CachedData', 'CachedProfilesData', 'CachedExtensionVSIXs', 'Crashpad',
  'blob_storage', 'ShaderCache', 'GrShaderCache', 'component_crx_cache', 'logs'
]);

function removeIfPresent(fs, target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_error) {
    // best-effort hygiene; never block a launch on it
  }
}

function trimAgyProjectTempFiles(ctx) {
  const { cliName, sandboxDir, fs, path } = ctx;
  if (cliName !== 'agy') return;

  const geminiDir = path.join(sandboxDir, '.gemini');
  let entries = [];
  try {
    entries = fs.readdirSync(geminiDir);
  } catch (_error) {
    return;
  }

  for (const entry of entries) {
    const name = String(entry || '');
    if (/^projects\.json\.[^.]+\.tmp$/.test(name)) {
      removeIfPresent(fs, path.join(geminiDir, name));
    }
  }
}

/**
 * Trim regenerable OS/Electron caches from the account's fake-HOME so disk usage
 * cannot balloon (the cause of the multi-GB per-account bloat).
 * @param {SandboxLaunchContext & {fs: any}} ctx
 */
function prepare(ctx) {
  const { sandboxDir, fs, path } = ctx;
  if (!fs || typeof fs.rmSync !== 'function') return;

  // 1) OS-level cache bucket — entirely regenerable.
  removeIfPresent(fs, path.join(sandboxDir, 'Library', 'Caches'));
  trimAgyProjectTempFiles(ctx);

  // 2) Per-app Electron caches under Library/Application Support/<app>/<sub>.
  const appSupport = path.join(sandboxDir, 'Library', 'Application Support');
  let apps = [];
  try {
    apps = fs.readdirSync(appSupport);
  } catch (_error) {
    return;
  }
  for (const app of apps) {
    for (const sub of ELECTRON_CACHE_SUBDIRS) {
      removeIfPresent(fs, path.join(appSupport, app, sub));
    }
  }
}

const homeRedirectStrategy = Object.freeze({
  name: 'home-redirect',
  prepare,
  buildEnvPatch
});

module.exports = {
  homeRedirectStrategy,
  buildSharedCacheEnv,
  buildEnvPatch,
  prepare,
  ELECTRON_CACHE_SUBDIRS,
  AGY_KEYCHAIN_BYPASS_ENV
};
