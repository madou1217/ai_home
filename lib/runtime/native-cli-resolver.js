'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveCliPath } = require('./platform-runtime');

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function executableNames(commandName, platform) {
  const normalized = normalizeText(commandName);
  if (!normalized) return [];
  if (platform !== 'win32') return [normalized];
  if (path.extname(normalized)) return [normalized];
  return [normalized, `${normalized}.exe`, `${normalized}.cmd`, `${normalized}.bat`];
}

function isExecutableFile(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    fsImpl.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function defaultAppRoot() {
  return path.resolve(__dirname, '..', '..');
}

function uniquePaths(paths = []) {
  const seen = new Set();
  const out = [];
  paths.forEach((item) => {
    const normalized = normalizeText(item);
    if (!normalized) return;
    const resolved = path.resolve(normalized);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  });
  return out;
}

function collectProjectCliCandidates(commandName, options = {}) {
  const env = options.env || process.env || {};
  const roots = uniquePaths([
    options.appRoot,
    options.cwd,
    process.cwd(),
    defaultAppRoot()
  ]);
  const runtimeToolsDir = normalizeText(options.runtimeToolsDir || env.AIH_RUNTIME_TOOLS_DIR);
  const candidateDirs = [];
  if (runtimeToolsDir) candidateDirs.push(runtimeToolsDir);
  roots.forEach((root) => {
    candidateDirs.push(path.join(root, '.runtime-tools', 'bin'));
    candidateDirs.push(path.join(root, 'node_modules', '.bin'));
  });
  const platform = options.platform || process.platform;
  const names = executableNames(commandName, platform);
  const candidates = [];
  uniquePaths(candidateDirs).forEach((dir) => {
    names.forEach((name) => {
      candidates.push(path.join(dir, name));
    });
  });
  return candidates;
}

function resolveProjectCliPath(commandName, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  for (const candidate of collectProjectCliCandidates(commandName, options)) {
    if (isExecutableFile(candidate, { fs: fsImpl, platform })) return candidate;
  }
  return '';
}

function resolveNativeCliPath(commandName, options = {}) {
  const env = options.env || process.env || {};
  const pathResolved = resolveCliPath(commandName, {
    ...options,
    env
  });
  if (pathResolved) return pathResolved;
  if (options.projectFallback === false || String(env.AIH_NATIVE_CLI_PROJECT_FALLBACK || '') === '0') {
    return '';
  }
  return resolveProjectCliPath(commandName, options);
}

module.exports = {
  collectProjectCliCandidates,
  resolveNativeCliPath,
  resolveProjectCliPath
};
