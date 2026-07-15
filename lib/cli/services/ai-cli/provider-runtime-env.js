'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { getProviderLaunchStrategy } = require('./launch-profile');
const { resolveCodexSqliteHome } = require('../../../runtime/codex-home');
const { resolveHostHomeDir } = require('../../../runtime/host-home');
const { ensureProviderSkillInstalled } = require('./provider-skill-installer');
const { readServerConfig } = require('../../../server/server-config-store');
const { buildAihServerRootUrl } = require('../../../account/self-relay-account');
const { materializeProviderAuth } = require('../../../account/native-auth-projection');

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

const ACCOUNT_SCOPED_ENV_KEYS = Object.freeze([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AIH_CLAUDE_CREDENTIAL_TYPE',
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'AGY_ACCESS_TOKEN',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'OPENCODE_API_KEY',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME'
]);

const LOCAL_RUNTIME_TOOL_DIRS = Object.freeze([
  ['.runtime-tools', 'bin'],
  ['.runtime-tools', 'npm', 'node_modules', '.bin']
]);

const POSIX_UTF8_LOCALE_BY_PLATFORM = Object.freeze({
  darwin: 'en_US.UTF-8',
  linux: 'C.UTF-8',
  freebsd: 'C.UTF-8',
  openbsd: 'C.UTF-8'
});

const DARWIN_CJK_UTF8_LOCALE = 'zh_CN.UTF-8';

// Native OAuth/file credentials still require a process-local filesystem
// projection. Providers authenticated entirely through environment variables do
// not: their config/session state can stay on the shared host home.
const ENV_AUTH_KEYS_BY_PROVIDER = Object.freeze({
  claude: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
  codex: Object.freeze(['OPENAI_API_KEY']),
  gemini: Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY'])
});

function stripAccountScopedEnv(baseEnv) {
  const env = { ...(baseEnv || {}) };
  ACCOUNT_SCOPED_ENV_KEYS.forEach((key) => {
    delete env[key];
    delete env[key.toLowerCase()];
  });
  return env;
}

function buildAccountScopedEnv(baseEnv, accountEnv) {
  const env = stripAccountScopedEnv(baseEnv);
  if (accountEnv && typeof accountEnv === 'object' && !Array.isArray(accountEnv)) {
    Object.assign(env, accountEnv);
  }
  return env;
}

function normalizeProviderName(provider) {
  return String(provider || '').trim().toLowerCase();
}

function hasNonEmptyEnvValue(env, key) {
  return Boolean(String(env && env[key] || '').trim());
}

function requiresProviderAuthProjection(provider, accountEnv = {}, options = {}) {
  if (options.isLogin === true) return true;
  if (options.gateway === true) return false;
  if (options.authRelayed === true) return false;
  const keys = ENV_AUTH_KEYS_BY_PROVIDER[normalizeProviderName(provider)];
  if (!keys) return true;
  return !keys.some((key) => hasNonEmptyEnvValue(accountEnv, key));
}

function resolveProviderRuntimeScope(provider, projectionDir, baseEnv = {}, options = {}) {
  const candidateDir = String(projectionDir || '').trim();
  const hostHomeDir = resolveRuntimeHostHome(candidateDir, baseEnv, options);
  const projectionRequired = requiresProviderAuthProjection(
    provider,
    options.accountEnv,
    options
  );
  return {
    hostHomeDir,
    projectionRequired,
    runtimeDir: projectionRequired ? candidateDir : hostHomeDir
  };
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

function resolveRuntimeHostHome(_runtimeDir, baseEnv, options = {}) {
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
  return resolveHostHomeDir({
    env: baseEnv,
    platform,
    os: options.os
  });
}

function buildHostScopedBaseEnv(baseEnv, hostHomeDir) {
  const env = { ...(baseEnv || {}) };

  for (const key of PROVIDER_HOME_KEYS) {
    delete env[key];
  }

  if (hostHomeDir) {
    env.HOME = hostHomeDir;
    env.USERPROFILE = hostHomeDir;
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

function isExecutableToolDir(fsImpl, dirPath) {
  try {
    return fsImpl.existsSync(dirPath) && fsImpl.statSync(dirPath).isDirectory();
  } catch (_error) {
    return false;
  }
}

function collectLocalRuntimePathEntries(options = {}) {
  const pathImpl = options.path || nodePath;
  const fsImpl = options.fs || nodeFs;
  const rootDir = String(options.runtimeRootDir || process.cwd()).trim();
  if (!rootDir || !fsImpl || typeof fsImpl.existsSync !== 'function' || typeof fsImpl.statSync !== 'function') return [];

  const entries = LOCAL_RUNTIME_TOOL_DIRS
    .map((parts) => pathImpl.join(rootDir, ...parts))
    .filter((dirPath) => isExecutableToolDir(fsImpl, dirPath));

  const nodeRuntimeRoot = pathImpl.join(rootDir, '.node-runtime');
  try {
    if (isExecutableToolDir(fsImpl, nodeRuntimeRoot) && typeof fsImpl.readdirSync === 'function') {
      fsImpl.readdirSync(nodeRuntimeRoot, { withFileTypes: true })
        .filter((entry) => entry && entry.isDirectory && entry.isDirectory())
        .map((entry) => pathImpl.join(nodeRuntimeRoot, entry.name, 'bin'))
        .filter((dirPath) => isExecutableToolDir(fsImpl, dirPath))
        .forEach((dirPath) => entries.push(dirPath));
    }
  } catch (_error) {}

  return entries;
}

function prependPathEntries(env, entries, options = {}) {
  const pathImpl = options.path || nodePath;
  const delimiter = pathImpl.delimiter || nodePath.delimiter;
  const current = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const seen = new Set();
  const next = [];
  [...entries, ...current].forEach((entry) => {
    const normalized = String(entry || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    next.push(normalized);
  });
  if (next.length > 0) env.PATH = next.join(delimiter);
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
    baseEnv: baseEnv && typeof baseEnv === 'object' ? baseEnv : {},
    isLogin: Boolean(options.isLogin)
  };
}

function buildProviderRuntimeEnv(provider, profileDir, baseEnv = {}, options = {}) {
  const pathImpl = options.path || nodePath;
  const scopedBaseEnv = buildAccountScopedEnv(baseEnv, options.accountEnv);
  const launchCtx = buildProviderLaunchContext(provider, profileDir, scopedBaseEnv, options);
  const strategy = getProviderLaunchStrategy(launchCtx.cliName);
  const patch = strategy.buildEnvPatch(launchCtx);
  const env = buildHostScopedBaseEnv(scopedBaseEnv, launchCtx.hostHomeDir);

  Object.assign(env, patch.set || {});
  for (const key of patch.unset || []) {
    delete env[key];
  }
  Object.assign(env, buildGatewayCollabEnv(launchCtx, options));
  Object.assign(env, options.extraEnv || {});
  prependPathEntries(env, collectLocalRuntimePathEntries({
    path: pathImpl,
    fs: options.fs,
    runtimeRootDir: options.runtimeRootDir
  }), { path: pathImpl });

  return normalizeProxyEnv(normalizeUtf8LocaleEnv(env, { platform: options.platform }));
}

// Cross-provider collaboration env: every provider session gets the local
// gateway address + key so the aih-collab skill can call other providers.
// Gateway key only (never upstream credentials); rides process env, not argv.
function buildGatewayCollabEnv(launchCtx, options = {}) {
  try {
    const fsImpl = options.fs || launchCtx.fs || nodeFs;
    const aiHomeDir = String(options.aiHomeDir || '').trim();
    const serverConfig = readServerConfig({ fs: fsImpl, aiHomeDir });
    const baseUrl = buildAihServerRootUrl(serverConfig);
    if (!baseUrl) return {};
    return {
      AIH_GATEWAY_BASE_URL: baseUrl,
      AIH_GATEWAY_API_KEY: String(serverConfig.apiKey || '').trim() || 'dummy'
    };
  } catch (_error) {
    return {};
  }
}

function prepareProviderRuntime(provider, profileDir, baseEnv = {}, options = {}) {
  const scopedBaseEnv = buildAccountScopedEnv(baseEnv, options.accountEnv);
  const launchCtx = buildProviderLaunchContext(provider, profileDir, scopedBaseEnv, options);
  const fsImpl = options.fs || launchCtx.fs || nodeFs;
  if (options.materializeAuth !== false) {
    const projection = materializeProviderAuth(fsImpl, profileDir, launchCtx.cliName, {
      path: launchCtx.path,
      aiHomeDir: options.aiHomeDir,
      accountRef: options.accountRef
    });
    if (options.requireNativeAuth === true && projection.missing) {
      throw new Error(`account_auth_projection_failed:${projection.reason || 'missing_credentials'}`);
    }
  }
  const strategy = getProviderLaunchStrategy(launchCtx.cliName);
  if (typeof strategy.prepare === 'function') {
    strategy.prepare(launchCtx);
  }
  // Built-in cross-provider collaboration skill (aih-collab): installed on
  // every interactive launch so the agent can borrow vision/image-generation
  // from other providers through the local gateway. Best-effort by design.
  if (!launchCtx.isLogin && options.installSkill !== false) {
    ensureProviderSkillInstalled(launchCtx, { env: launchCtx.baseEnv });
  }
  return launchCtx;
}

module.exports = {
  ACCOUNT_SCOPED_ENV_KEYS,
  buildAccountScopedEnv,
  buildProviderLaunchContext,
  buildProviderRuntimeEnv,
  collectLocalRuntimePathEntries,
  prepareProviderRuntime,
  normalizeProxyEnv,
  normalizeUtf8LocaleEnv,
  requiresProviderAuthProjection,
  resolveProviderRuntimeScope,
  isUtf8Locale,
  resolveRuntimeHostHome,
  stripAccountScopedEnv
};
