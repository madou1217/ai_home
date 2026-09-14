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
  // .cjs covers node-script CLIs (zcode ships as zcode.cjs); buildPtyLaunch
  // executes them through node.
  return [normalized, `${normalized}.ps1`, `${normalized}.cmd`, `${normalized}.bat`, `${normalized}.exe`, `${normalized}.cjs`];
}

function parsePathEntries(platform, env) {
  const raw = String((env && (env.Path || env.PATH || env.path)) || '');
  if (!raw) return [];
  const separator = platform === 'win32' ? ';' : ':';
  return raw.split(separator).map((entry) => entry.trim()).filter(Boolean);
}

function isExecutableFile(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return false;
    if (platform === 'win32') return true;
    fsImpl.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function repairUnversionedShim(dir, commandName, targetPath, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  // Self-heal only on the real filesystem; injected fs doubles (tests) stay pure.
  if (platform !== 'win32' || fsImpl !== fs) return;
  const normalized = path.basename(normalizeText(commandName), path.extname(normalizeText(commandName)));
  if (!normalized || !dir || !targetPath) return;
  try {
    const shim = path.join(dir, `${normalized}.exe`);
    if (path.resolve(shim) === path.resolve(targetPath)) return;
    if (isExecutableFile(shim, { fs: fsImpl, platform })) {
      const shimStat = fsImpl.statSync(shim);
      const targetStat = fsImpl.statSync(targetPath);
      // Same inode (hardlink to the current target) → nothing to do. When inode
      // comparison is unavailable, leave a working shim untouched.
      if (!shimStat.ino || !targetStat.ino) return;
      if (shimStat.ino === targetStat.ino && shimStat.dev === targetStat.dev) return;
    }
    try { fsImpl.rmSync(shim, { force: true }); } catch (_error) { /* best effort */ }
    fsImpl.linkSync(targetPath, shim);
  } catch (_error) {
    // Hard-link repair is best-effort: resolution must never fail because of it.
  }
}

function resolveVersionedWindowsExecutable(commandName, dir, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return '';
  const normalized = path.basename(normalizeText(commandName), path.extname(normalizeText(commandName)));
  if (!normalized || !dir) return '';
  try {
    const prefix = `${normalized.toLowerCase()}-`;
    const candidates = fsImpl.readdirSync(dir)
      .filter((name) => name.toLowerCase().startsWith(prefix) && name.toLowerCase().endsWith('.exe'))
      .map((name) => path.join(dir, name))
      .filter((candidate) => isExecutableFile(candidate, { fs: fsImpl, platform }))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }));
    const resolved = candidates[0] || '';
    // Versioned installers (qodercli/qoderclicn) leave the unversioned <name>.exe
    // as a 0-byte placeholder, and upgrades move the real binary to a new
    // <name>-<ver>.exe. Re-point the shim at the resolved binary so manual
    // invocations of the bare command keep working across upgrades.
    if (resolved) repairUnversionedShim(dir, commandName, resolved, { fs: fsImpl, platform });
    return resolved;
  } catch (_error) {
    return '';
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

function resolveEnvCliPath(commandName, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  const env = options.env || process.env || {};
  const names = executableNames(commandName, platform);
  for (const dir of parsePathEntries(platform, env)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate, { fs: fsImpl, platform })) return candidate;
    }
    const versioned = resolveVersionedWindowsExecutable(commandName, dir, { fs: fsImpl, platform });
    if (versioned) return versioned;
  }
  return '';
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
  if (pathResolved && isExecutableFile(pathResolved, options)) return pathResolved;
  const envResolved = resolveEnvCliPath(commandName, options);
  if (envResolved) return envResolved;
  if (options.projectFallback === false || String(env.AIH_NATIVE_CLI_PROJECT_FALLBACK || '') === '0') {
    return '';
  }
  return resolveProjectCliPath(commandName, options);
}

module.exports = {
  collectProjectCliCandidates,
  repairUnversionedShim,
  resolveEnvCliPath,
  resolveNativeCliPath,
  resolveProjectCliPath,
  resolveVersionedWindowsExecutable
};
