'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const {
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  normalizeClientPlatform
} = require('../client-platform');

function normalizeEnv(options = {}) {
  const processObj = options.processObj || process;
  const source = options.env || processObj.env || process.env || {};
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value)]));
}

function resolveContext(options = {}) {
  const processObj = options.processObj || process;
  const platform = normalizeClientPlatform(options.platform || processObj.platform || process.platform);
  const platformAdapter = getClientPlatformAdapter(platform);
  const pathImpl = options.path || platformAdapter && platformAdapter.path || nodePath;
  return {
    ...options,
    platform,
    processObj,
    path: pathImpl,
    fs: options.fs || nodeFs,
    env: normalizeEnv(options),
    platformAdapter
  };
}

// Store 应用别名是 reparse point；existsSync 可能因目标 ACL 返回 false。
function pathEntryExists(fs, candidate) {
  try {
    if (fs.existsSync(candidate)) return true;
  } catch (_error) {}
  try {
    if (typeof fs.accessSync === 'function') {
      fs.accessSync(candidate);
      return true;
    }
  } catch (_error) {}
  try {
    if (typeof fs.lstatSync === 'function') {
      return Boolean(fs.lstatSync(candidate, { throwIfNoEntry: false }));
    }
  } catch (_error) {}
  return false;
}

function findOnPath(names, context = {}) {
  const { env, fs, path, platform } = resolveContext(context);
  const candidates = (Array.isArray(names) ? names : [names])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const delimiter = platform === CLIENT_PLATFORMS.WINDOWS ? ';' : (path.delimiter || ':');
  const dirs = String(env.PATH || env.Path || env.path || '')
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (pathEntryExists(fs, candidate)) return candidate;
      if (platform === CLIENT_PLATFORMS.WINDOWS && !/\.[a-z0-9]+$/i.test(name)) {
        const executable = `${candidate}.exe`;
        if (pathEntryExists(fs, executable)) return executable;
      }
    }
  }
  return '';
}

function findFirstExisting(paths, fs) {
  for (const candidate of paths) {
    if (candidate && pathEntryExists(fs, candidate)) return candidate;
  }
  return '';
}

function readHostHome(context) {
  const { env, platform } = context;
  return String(context.hostHomeDir || (platform === CLIENT_PLATFORMS.WINDOWS
    ? env.USERPROFILE
    : env.HOME) || '').trim();
}

function escapeAppleScriptString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function shellQuote(value, platform) {
  const text = String(value == null ? '' : value);
  if (platform === CLIENT_PLATFORMS.WINDOWS) return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function resolveTerminalExecutable(definition, context = {}) {
  const resolved = resolveContext(context);
  const { env, fs, path, platform } = resolved;
  const platformConfig = definition.platforms && definition.platforms[platform];
  if (!platformConfig) return '';
  const hostHomeDir = readHostHome(resolved);
  const localAppData = String(env.LOCALAPPDATA || (hostHomeDir
    ? path.join(hostHomeDir, 'AppData', 'Local')
    : '')).trim();
  const expandPaths = (paths) => (paths || []).map((candidate) => {
    const expanded = String(candidate || '')
      .replaceAll('{hostHomeDir}', hostHomeDir)
      .replaceAll('{localAppData}', localAppData);
    return expanded ? path.normalize(expanded) : '';
  });
  const managedCandidate = findFirstExisting(expandPaths(platformConfig.managedPaths), fs);
  if (managedCandidate) return managedCandidate;
  const pathCandidate = findOnPath(platformConfig.binaryNames || [], resolved);
  if (pathCandidate) return pathCandidate;
  return findFirstExisting(expandPaths(platformConfig.paths), fs);
}

function resolveLifecycleExecutable(names, fallbackPaths, context = {}) {
  const resolved = resolveContext(context);
  return findOnPath(names, resolved) || findFirstExisting(fallbackPaths, resolved.fs);
}

function buildInteractiveShellCommand(context = {}) {
  const resolved = resolveContext(context);
  if (resolved.platform === CLIENT_PLATFORMS.WINDOWS) return 'echo AI Home terminal';
  const shell = String(
    resolved.env.SHELL
      || resolved.platformAdapter && resolved.platformAdapter.commands && resolved.platformAdapter.commands.shell
      || (resolved.platform === CLIENT_PLATFORMS.MACOS ? '/bin/zsh' : '/bin/bash')
  ).trim();
  return `exec ${shellQuote(shell, resolved.platform)} -l`;
}

module.exports = {
  buildInteractiveShellCommand,
  escapeAppleScriptString,
  findFirstExisting,
  findOnPath,
  pathEntryExists,
  readHostHome,
  resolveContext,
  resolveLifecycleExecutable,
  resolveTerminalExecutable,
  shellQuote
};
