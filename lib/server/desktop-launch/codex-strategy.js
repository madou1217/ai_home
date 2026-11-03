'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { writeFileAtomic } = require('../../runtime/atomic-file-write');
const {
  mergeConfigs,
  syncCodexBuiltinApiBaseUrl
} = require('../../cli/services/pty/codex-config-sync');
const { resolveHostHomeDir } = require('../../runtime/host-home');
const { readDesktopLaunchEnv } = require('../codex-desktop-external-launcher');
const { createDesktopLaunchStrategy } = require('./default-strategy');

const CODEX_HOME_DIR = '.codex';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function isApiKeyAccount(ctx) {
  return Boolean(String(ctx && ctx.accountEnv && ctx.accountEnv.OPENAI_API_KEY || '').trim());
}

function resolveCodexHostHome(ctx) {
  const platform = ctx && ctx.platformKey === 'macos'
    ? 'darwin'
    : ctx && ctx.platformKey === 'windows'
      ? 'win32'
      : (ctx && ctx.platformKey) || process.platform;
  const env = ctx && typeof ctx.getBaseEnv === 'function' ? ctx.getBaseEnv() : {};
  return resolveHostHomeDir({
    env,
    hostHomeDir: ctx && ctx.hostHomeDir,
    platform
  });
}

function upsertRootKeyLine(configText, key, line) {
  const source = String(configText || '');
  const lines = source.split('\n');
  const keyPattern = new RegExp(`^${String(key || '').replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*=`);
  let firstSectionIndex = lines.findIndex((candidate) => candidate.trim().startsWith('['));
  if (firstSectionIndex < 0) firstSectionIndex = lines.length;

  let replaced = false;
  const next = [];
  lines.forEach((candidate, index) => {
    if (index < firstSectionIndex && keyPattern.test(candidate.trim())) {
      if (!replaced) {
        next.push(line);
        replaced = true;
      }
      return;
    }
    next.push(candidate);
  });

  if (!replaced) next.splice(firstSectionIndex, 0, line);
  return next.join('\n');
}

function buildApiKeyConfig(hostConfig, ctx = {}) {
  const pathImpl = ctx.path || nodePath;
  const hostHomeDir = resolveCodexHostHome(ctx);
  const hostCodexHome = hostHomeDir
    ? pathImpl.join(hostHomeDir, CODEX_HOME_DIR)
    : '';
  let content = mergeConfigs(String(hostConfig || ''), '', {
    // Rebuild the native openai profile and remove any host aih_server block.
    // The Desktop must authenticate with this account's API key directly.
    isApiKeyMode: false,
    ...(hostCodexHome ? { sqliteHome: hostCodexHome } : {})
  });
  content = upsertRootKeyLine(content, 'preferred_auth_method', 'preferred_auth_method = "apikey"');
  content = upsertRootKeyLine(content, 'model_provider', 'model_provider = "openai"');

  const baseUrl = String(ctx.accountEnv && ctx.accountEnv.OPENAI_BASE_URL || '').trim()
    || DEFAULT_OPENAI_BASE_URL;
  // mergeConfigs removes AIH's managed endpoint marker first. Pin the account's
  // endpoint explicitly; an account without one gets the official OpenAI URL.
  content = syncCodexBuiltinApiBaseUrl(content, baseUrl);
  return content;
}

function writePrivateFile(fs, pathImpl, filePath, content) {
  fs.mkdirSync(pathImpl.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileAtomic(fs, filePath, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_error) {}
}

function ensurePrivateDirectory(fs, dirPath) {
  let stat = null;
  if (typeof fs.lstatSync === 'function') {
    try { stat = fs.lstatSync(dirPath); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error('codex_desktop_profile_not_private');
  }
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function readTextIfPresent(fs, filePath) {
  try {
    return fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : '';
  } catch (_error) {
    return '';
  }
}

function prepareLaunchProfile(ctx) {
  if (!isApiKeyAccount(ctx)) return { ready: true };

  const fs = ctx.fs || nodeFs;
  const path = ctx.path || nodePath;
  const codexHome = path.join(ctx.profileDir, CODEX_HOME_DIR);
  const authPath = path.join(codexHome, 'auth.json');
  const configPath = path.join(codexHome, 'config.toml');
  const accountKey = String(ctx.accountEnv.OPENAI_API_KEY || '').trim();

  try {
    // Never follow a stale projection symlink into the host ~/.codex tree.
    ensurePrivateDirectory(fs, codexHome);
    writePrivateFile(fs, path, authPath, `${JSON.stringify({
      auth_mode: 'apikey',
      OPENAI_API_KEY: accountKey,
      tokens: null,
      last_refresh: null
    }, null, 2)}\n`);

    const hostHomeDir = resolveCodexHostHome(ctx);
    const hostConfigPath = hostHomeDir
      ? path.join(hostHomeDir, CODEX_HOME_DIR, 'config.toml')
      : '';
    const config = buildApiKeyConfig(readTextIfPresent(fs, hostConfigPath), ctx);
    writePrivateFile(fs, path, configPath, config);
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      error: 'codex_desktop_profile_prepare_failed',
      reason: String((error && error.message) || error || 'unknown').slice(0, 160)
    };
  }
}

function decorateLaunchEnv(env, ctx) {
  // The ChatGPT Desktop app launches its bundled Codex app-server from inside
  // Electron. Reuse the same optional AIH launcher that the CLI restart path
  // injects, so Desktop and `aih codex ... --restart-client` share the same
  // account-aware upstream boundary. If the hook is not installed, the helper
  // deliberately returns an empty object and the native Desktop path remains
  // unchanged.
  Object.assign(
    env,
    readDesktopLaunchEnv(ctx.fs || nodeFs, ctx.path || nodePath, ctx.aiHomeDir)
  );
  if (!isApiKeyAccount(ctx)) return;
  // The CLI strategy intentionally shares the host CODEX_HOME for API-key
  // sessions. Desktop has its own account profile, so it must read the key and
  // native config from the account projection while keeping SQLite shared.
  env.CODEX_HOME = ctx.path.join(ctx.profileDir, CODEX_HOME_DIR);
}

const codexDesktopLaunchStrategy = createDesktopLaunchStrategy({
  name: 'codex-api-key-profile',
  decorateLaunchEnv,
  prepareLaunchProfile
});

module.exports = {
  buildApiKeyConfig,
  codexDesktopLaunchStrategy,
  decorateLaunchEnv,
  prepareLaunchProfile
};
