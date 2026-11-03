'use strict';

const nodePath = require('node:path');
const { getProviderLaunchStrategy } = require('./launch-profile');
const {
  buildProviderLaunchContext,
  buildProviderRuntimeEnv
} = require('./provider-runtime-env');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathState(fsImpl, target) {
  const filePath = normalizeString(target);
  if (!filePath || !fsImpl || typeof fsImpl.existsSync !== 'function') {
    return { path: filePath, state: filePath ? 'unknown' : 'n/a', target: '' };
  }
  if (!fsImpl.existsSync(filePath)) {
    return { path: filePath, state: 'missing', target: '' };
  }
  try {
    const stat = fsImpl.lstatSync(filePath);
    if (stat && stat.isSymbolicLink && stat.isSymbolicLink()) {
      return {
        path: filePath,
        state: 'symlink',
        target: fsImpl.readlinkSync(filePath)
      };
    }
    if (stat && stat.isDirectory && stat.isDirectory()) {
      return { path: filePath, state: 'dir', target: '' };
    }
    if (stat && stat.isFile && stat.isFile()) {
      return { path: filePath, state: 'file', target: '' };
    }
  } catch (_error) {
    return { path: filePath, state: 'unknown', target: '' };
  }
  return { path: filePath, state: 'exists', target: '' };
}

function addPath(paths, label, fsImpl, target) {
  paths.push({
    label,
    ...pathState(fsImpl, target)
  });
}

function buildProviderPaths(provider, ctx, env, fsImpl, pathImpl) {
  const paths = [];
  const hostHome = ctx.hostHomeDir;
  const profileDir = ctx.sandboxDir;
  const providerName = normalizeString(provider).toLowerCase();

  addPath(paths, 'profile', fsImpl, profileDir);

  if (providerName === 'codex') {
    addPath(paths, 'codex config dir', fsImpl, env.CODEX_HOME);
    addPath(paths, 'codex auth.json', fsImpl, pathImpl.join(env.CODEX_HOME || '', 'auth.json'));
    addPath(paths, 'codex config.toml', fsImpl, pathImpl.join(env.CODEX_HOME || '', 'config.toml'));
    addPath(paths, 'shared codex sqlite home', fsImpl, env.CODEX_SQLITE_HOME);
    addPath(paths, 'shared codex sessions', fsImpl, pathImpl.join(env.CODEX_SQLITE_HOME || '', 'sessions'));
    return paths;
  }

  if (providerName === 'claude') {
    addPath(paths, 'claude config dir', fsImpl, env.CLAUDE_CONFIG_DIR);
    addPath(paths, 'claude credentials', fsImpl, pathImpl.join(env.CLAUDE_CONFIG_DIR || '', '.credentials.json'));
    addPath(paths, 'shared claude projects', fsImpl, pathImpl.join(hostHome || '', '.claude', 'projects'));
    addPath(paths, 'shared claude history', fsImpl, pathImpl.join(hostHome || '', '.claude', 'history.jsonl'));
    return paths;
  }

  if (providerName === 'gemini') {
    addPath(paths, 'gemini cli home', fsImpl, env.GEMINI_CLI_HOME);
    addPath(paths, 'gemini oauth creds', fsImpl, pathImpl.join(env.GEMINI_CLI_HOME || '', 'oauth_creds.json'));
    addPath(paths, 'gemini accounts', fsImpl, pathImpl.join(env.GEMINI_CLI_HOME || '', 'google_accounts.json'));
    addPath(paths, 'gemini settings', fsImpl, env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
    addPath(paths, 'shared gemini history', fsImpl, pathImpl.join(hostHome || '', '.gemini', 'history'));
    return paths;
  }

  if (providerName === 'agy') {
    addPath(paths, 'agy fake home', fsImpl, env.HOME);
    addPath(paths, 'agy oauth dir', fsImpl, pathImpl.join(profileDir, '.gemini', 'antigravity-cli'));
    addPath(paths, 'shared cache home', fsImpl, env.XDG_CACHE_HOME);
    return paths;
  }

  addPath(paths, 'claude config dir', fsImpl, env.CLAUDE_CONFIG_DIR);
  addPath(paths, 'codex config dir', fsImpl, env.CODEX_HOME);
  addPath(paths, 'gemini settings', fsImpl, env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
  return paths;
}

function pickEnv(env) {
  const keys = [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'GEMINI_CLI_HOME',
    'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
    'GEMINI_CLI_TRUST_WORKSPACE',
    'CARGO_HOME',
    'GOPATH',
    'GOMODCACHE',
    'GOCACHE',
    'npm_config_cache'
  ];
  return keys
    .filter((key) => Object.prototype.hasOwnProperty.call(env, key))
    .map((key) => ({ key, value: String(env[key] || '') }));
}

function buildProviderHomeDiagnostics(provider, profileDir, baseEnv = {}, options = {}) {
  const pathImpl = options.path || nodePath;
  const fsImpl = options.fs;
  const ctx = buildProviderLaunchContext(provider, profileDir, baseEnv, {
    path: pathImpl,
    fs: fsImpl,
    hostHomeDir: options.hostHomeDir,
    aiHomeDir: options.aiHomeDir
  });
  const env = buildProviderRuntimeEnv(provider, profileDir, baseEnv, {
    path: pathImpl,
    fs: fsImpl,
    hostHomeDir: ctx.hostHomeDir,
    aiHomeDir: options.aiHomeDir,
    accountEnv: options.accountEnv
  });
  const strategy = getProviderLaunchStrategy(ctx.cliName);

  return {
    provider: ctx.cliName,
    cliAccountId: normalizeString(options.cliAccountId),
    strategy: strategy.name,
    profileDir: ctx.sandboxDir,
    profileExists: fsImpl && typeof fsImpl.existsSync === 'function'
      ? fsImpl.existsSync(ctx.sandboxDir)
      : null,
    hostHomeDir: ctx.hostHomeDir,
    env: pickEnv(env),
    paths: buildProviderPaths(ctx.cliName, ctx, env, fsImpl, pathImpl)
  };
}

function formatPathState(item) {
  const suffix = item.target ? ` -> ${item.target}` : '';
  return `${item.path || '(empty)'} [${item.state}]${suffix}`;
}

function formatProviderHomeDiagnostics(diag) {
  const lines = [];
  lines.push(`AIH home diagnostics: ${diag.provider}${diag.cliAccountId ? ` #${diag.cliAccountId}` : ''}`);
  lines.push(`strategy: ${diag.strategy}`);
  lines.push(`profile: ${diag.profileDir} [${diag.profileExists === false ? 'missing' : 'exists'}]`);
  lines.push(`hostHome: ${diag.hostHomeDir || '(unknown)'}`);
  lines.push('env:');
  for (const item of diag.env) {
    lines.push(`  ${item.key}=${item.value}`);
  }
  lines.push('paths:');
  for (const item of diag.paths) {
    lines.push(`  ${item.label}: ${formatPathState(item)}`);
  }
  return lines.join('\n');
}

module.exports = {
  buildProviderHomeDiagnostics,
  formatProviderHomeDiagnostics
};
