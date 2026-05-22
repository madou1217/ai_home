'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveCommandPath } = require('./command-path');

const versionedPathCache = new Map();

function configureConsoleEncoding(options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  if (platform !== 'win32') return;

  try {
    spawnSyncImpl('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul'], { stdio: 'ignore' });
  } catch (_error) {
    // best effort only
  }

  try {
    if (stdout && typeof stdout.setDefaultEncoding === 'function') {
      stdout.setDefaultEncoding('utf8');
    }
    if (stderr && typeof stderr.setDefaultEncoding === 'function') {
      stderr.setDefaultEncoding('utf8');
    }
  } catch (_error) {
    // best effort only
  }
}

function parsePathEntries(platform, env) {
  const key = platform === 'win32' ? 'Path' : 'PATH';
  const raw = String((env && (env[key] || env.PATH || env.Path)) || '');
  if (!raw) return [];
  return raw.split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collectCommandCandidates(commandName, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const names = platform === 'win32'
    ? [commandName, `${commandName}.exe`, `${commandName}.cmd`, `${commandName}.bat`]
    : [commandName];
  const candidates = [];
  const seen = new Set();

  parsePathEntries(platform, env).forEach((dir) => {
    names.forEach((name) => {
      const candidate = path.join(dir, name);
      try {
        if (!fs.existsSync(candidate)) return;
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) return;
        if (platform !== 'win32' && (stat.mode & 0o111) === 0) return;
        const real = fs.realpathSync(candidate);
        const key = platform === 'win32' ? real.toLowerCase() : real;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(candidate);
      } catch (_error) {}
    });
  });

  return candidates;
}

function parseCliVersion(output) {
  const match = String(output || '').match(/(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/);
  if (!match) return null;
  return {
    major: Number(match[1]) || 0,
    minor: Number(match[2]) || 0,
    patch: Number(match[3]) || 0,
    raw: match[0]
  };
}

function compareCliVersions(left, right) {
  if (!left && !right) return 0;
  if (left && !right) return 1;
  if (!left && right) return -1;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function resolveHighestVersionedCommandPath(commandName, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return '';

  const env = options.env || process.env;
  const cacheKey = [
    commandName,
    platform,
    String(env.PATH || env.Path || '')
  ].join('\0');
  const shouldUseCache = !options.spawnSyncImpl;
  if (shouldUseCache && versionedPathCache.has(cacheKey)) return versionedPathCache.get(cacheKey);

  const candidates = collectCommandCandidates(commandName, options);
  if (candidates.length <= 1) {
    const only = candidates[0] || '';
    if (shouldUseCache) versionedPathCache.set(cacheKey, only);
    return only;
  }

  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  let best = null;
  candidates.forEach((candidate, index) => {
    try {
      const result = spawnSyncImpl(candidate, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2000
      });
      const version = parseCliVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
      const item = { path: candidate, version, index };
      if (!best) {
        best = item;
        return;
      }
      const versionOrder = compareCliVersions(item.version, best.version);
      if (versionOrder > 0 || (versionOrder === 0 && item.index < best.index)) {
        best = item;
      }
    } catch (_error) {}
  });

  const resolved = (best && best.path) || candidates[0] || '';
  if (shouldUseCache) versionedPathCache.set(cacheKey, resolved);
  return resolved;
}

function resolveCliPath(commandName, options = {}) {
  const normalized = String(commandName || '').trim();
  if (
    normalized === 'codex'
    && String((options.env || process.env).AIH_CODEX_RESOLVE_LATEST || '1') !== '0'
  ) {
    const latestCodexPath = resolveHighestVersionedCommandPath(normalized, options);
    if (latestCodexPath) return latestCodexPath;
  }
  return resolveCommandPath(normalized, options);
}

function commandExists(commandName, options = {}) {
  return Boolean(resolveCliPath(commandName, options));
}

module.exports = {
  commandExists,
  configureConsoleEncoding,
  collectCommandCandidates,
  parseCliVersion,
  compareCliVersions,
  resolveHighestVersionedCommandPath,
  resolveCliPath
};
