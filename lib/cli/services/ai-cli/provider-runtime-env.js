'use strict';

const nodePath = require('node:path');
const { getProviderLaunchStrategy } = require('./launch-profile');
const {
  resolveCodexSqliteHome,
  resolveHostHomeDirFromProfileDir
} = require('../../../runtime/codex-home');
const { resolveHostHomeDir } = require('../../../runtime/host-home');

const PROVIDER_HOME_KEYS = Object.freeze([
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'GEMINI_CLI_HOME',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  'OPENCODE_API_KEY',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME'
]);

const XDG_DEFAULTS = Object.freeze({
  XDG_CONFIG_HOME: '.config',
  XDG_DATA_HOME: '.local/share',
  XDG_STATE_HOME: '.local/state',
  XDG_CACHE_HOME: '.cache'
});

const POSIX_UTF8_LOCALE_BY_PLATFORM = Object.freeze({
  darwin: 'en_US.UTF-8',
  linux: 'C.UTF-8',
  freebsd: 'C.UTF-8',
  openbsd: 'C.UTF-8'
});

const DARWIN_CJK_UTF8_LOCALE = 'zh_CN.UTF-8';

function normalizeProviderName(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeProfilePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function isUtf8Locale(value) {
  return /(?:^|[._-])utf-?8(?:$|[.@_-])/i.test(String(value || '').trim());
}

function getDefaultUtf8Locale(platform) {
  const normalized = String(platform || process.platform || '').trim().toLowerCase();
  return POSIX_UTF8_LOCALE_BY_PLATFORM[normalized] || 'C.UTF-8';
}

function normalizeLocaleToken(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '');
}

function isGenericUtf8Locale(value) {
  const normalized = normalizeLocaleToken(value);
  return normalized === 'c.utf8' || normalized === 'posix.utf8';
}

function isEnglishUtf8Locale(value) {
  return normalizeLocaleToken(value).startsWith('en_');
}

function hasDarwinCjkRuntimeSignal(env) {
  return Boolean(
    String(env && env.SSH_CONNECTION || '').trim()
    || String(env && env.SSH_TTY || '').trim()
    || String(env && env.TERM_PROGRAM || '').trim() === 'WarpTerminal'
    || String(env && env.TERM_PROGRAM || '').trim() === 'tmux'
    || String(env && env.WARP_CLIENT_VERSION || '').trim()
    || String(env && env.WARP_IS_LOCAL_SHELL_SESSION || '').trim()
    || String(env && env.AIH_PERSIST_ACTIVE || '').trim()
  );
}

function isGenericOrEnglishUtf8Locale(value) {
  return isGenericUtf8Locale(value) || isEnglishUtf8Locale(value);
}

function shouldPreferDarwinCjkLocale(env, platform, locale) {
  if (String(platform || '').trim().toLowerCase() !== 'darwin') return false;
  if (String(env && env.AIH_CJK_LOCALE || '1') === '0') return false;
  if (!isGenericOrEnglishUtf8Locale(locale)) return false;
  if (isGenericUtf8Locale(locale)) return true;
  return isEnglishUtf8Locale(locale) && hasDarwinCjkRuntimeSignal(env);
}

function resolveUtf8Locale(env, platform) {
  const override = String(env && env.AIH_UTF8_LOCALE || '').trim();
  if (isUtf8Locale(override)) return override;
  for (const key of ['LC_ALL', 'LC_CTYPE', 'LANG']) {
    const value = String(env && env[key] || '').trim();
    if (isUtf8Locale(value)) {
      return shouldPreferDarwinCjkLocale(env, platform, value)
        ? DARWIN_CJK_UTF8_LOCALE
        : value;
    }
  }
  const fallback = getDefaultUtf8Locale(platform);
  return shouldPreferDarwinCjkLocale(env, platform, fallback)
    ? DARWIN_CJK_UTF8_LOCALE
    : fallback;
}

function shouldForceResolvedLocale(env, platform, locale) {
  if (!isUtf8Locale(locale)) return false;
  if (isUtf8Locale(env && env.AIH_UTF8_LOCALE)) return true;
  return shouldPreferDarwinCjkLocale(env, platform, String(env && (
    env.LC_ALL || env.LC_CTYPE || env.LANG || locale
  ) || locale));
}

function normalizeUtf8LocaleEnv(envObj, options = {}) {
  const env = { ...(envObj || {}) };
  const platform = String(options.platform || process.platform || '').trim().toLowerCase();
  const locale = resolveUtf8Locale(env, platform);
  const forceLocale = shouldForceResolvedLocale(env, platform, locale);

  if (forceLocale || !isUtf8Locale(env.LANG)) env.LANG = locale;
  if (forceLocale || !isUtf8Locale(env.LC_CTYPE)) env.LC_CTYPE = locale;
  if (forceLocale || !isUtf8Locale(env.LC_ALL)) env.LC_ALL = locale;

  // Windows-native tools ignore POSIX locale variables, but Python and several
  // Node-adjacent CLIs still consult these knobs when they run under cmd/PTY.
  if (platform === 'win32') {
    if (!String(env.PYTHONUTF8 || '').trim()) env.PYTHONUTF8 = '1';
    if (!String(env.PYTHONIOENCODING || '').trim()) env.PYTHONIOENCODING = 'utf-8';
  }

  return env;
}

function isNestedAiHomeProfilePath(value) {
  return normalizeProfilePath(value).includes('/.ai_home/profiles/');
}

function hasHostHomeHint(env, platform) {
  if (!env || typeof env !== 'object') return false;
  if (String(env.AIH_HOST_HOME || '').trim()) return true;
  if (platform === 'win32') {
    return Boolean(
      String(env.USERPROFILE || '').trim()
      || (String(env.HOMEDRIVE || '').trim() && String(env.HOMEPATH || '').trim())
      || String(env.HOME || '').trim()
    );
  }
  return Boolean(String(env.HOME || '').trim() || String(env.USERPROFILE || '').trim());
}

function resolveRuntimeHostHome(profileDir, baseEnv, options = {}) {
  const pathImpl = options.path || nodePath;
  if (String(options.hostHomeDir || '').trim()) {
    return String(options.hostHomeDir).trim();
  }
  const platform = String(options.platform || process.platform);
  if (hasHostHomeHint(baseEnv, platform)) {
    return resolveHostHomeDir({
      env: baseEnv,
      platform,
      os: options.os
    });
  }
  return resolveHostHomeDirFromProfileDir(profileDir, pathImpl)
    || resolveHostHomeDir({
      env: baseEnv,
      platform,
      os: options.os
    });
}

function buildHostScopedBaseEnv(baseEnv, hostHomeDir, pathImpl) {
  const env = { ...(baseEnv || {}) };

  for (const key of PROVIDER_HOME_KEYS) {
    delete env[key];
  }

  if (hostHomeDir) {
    env.HOME = hostHomeDir;
    env.USERPROFILE = hostHomeDir;
    for (const [key, relative] of Object.entries(XDG_DEFAULTS)) {
      if (isNestedAiHomeProfilePath(env[key])) {
        env[key] = pathImpl.join(hostHomeDir, relative);
      }
    }
  }

  return env;
}

function normalizeProxyEnv(envObj) {
  const env = { ...(envObj || {}) };
  const pairs = [
    ['http_proxy', 'HTTP_PROXY'],
    ['https_proxy', 'HTTPS_PROXY'],
    ['all_proxy', 'ALL_PROXY'],
    ['no_proxy', 'NO_PROXY']
  ];
  pairs.forEach(([lower, upper]) => {
    const lowerValue = String(env[lower] || '').trim();
    const upperValue = String(env[upper] || '').trim();
    if (lowerValue && !upperValue) env[upper] = lowerValue;
    if (upperValue && !lowerValue) env[lower] = upperValue;
  });
  return env;
}

function buildProviderLaunchContext(provider, profileDir, baseEnv = {}, options = {}) {
  const pathImpl = options.path || nodePath;
  const normalizedProvider = normalizeProviderName(provider);
  const sandboxDir = String(profileDir || '').trim();
  const hostHomeDir = resolveRuntimeHostHome(sandboxDir, baseEnv, options);
  const codexConfigDir = options.codexConfigDir || pathImpl.join(sandboxDir, '.codex');
  const codexSqliteHome = Object.prototype.hasOwnProperty.call(options, 'codexSqliteHome')
    ? String(options.codexSqliteHome || '')
    : resolveCodexSqliteHome({
      path: pathImpl,
      profileDir: sandboxDir,
      aiHomeDir: options.aiHomeDir,
      hostHomeDir
    });

  return {
    cliName: normalizedProvider,
    sandboxDir,
    codexConfigDir,
    codexSqliteHome,
    hostHomeDir,
    path: pathImpl,
    fs: options.fs,
    baseEnv: baseEnv && typeof baseEnv === 'object' ? baseEnv : {}
  };
}

function buildProviderRuntimeEnv(provider, profileDir, baseEnv = {}, options = {}) {
  const pathImpl = options.path || nodePath;
  const launchCtx = buildProviderLaunchContext(provider, profileDir, baseEnv, options);
  const strategy = getProviderLaunchStrategy(launchCtx.cliName);
  const patch = strategy.buildEnvPatch(launchCtx);
  const env = buildHostScopedBaseEnv(baseEnv, launchCtx.hostHomeDir, pathImpl);

  Object.assign(env, patch.set || {});
  for (const key of patch.unset || []) {
    delete env[key];
  }
  Object.assign(env, options.extraEnv || {});

  return normalizeProxyEnv(normalizeUtf8LocaleEnv(env, { platform: options.platform }));
}

function prepareProviderRuntime(provider, profileDir, baseEnv = {}, options = {}) {
  const launchCtx = buildProviderLaunchContext(provider, profileDir, baseEnv, options);
  const strategy = getProviderLaunchStrategy(launchCtx.cliName);
  if (typeof strategy.prepare === 'function') {
    strategy.prepare(launchCtx);
  }
  return launchCtx;
}

module.exports = {
  buildProviderLaunchContext,
  buildProviderRuntimeEnv,
  prepareProviderRuntime,
  normalizeProxyEnv,
  normalizeUtf8LocaleEnv,
  isUtf8Locale,
  isNestedAiHomeProfilePath
};
