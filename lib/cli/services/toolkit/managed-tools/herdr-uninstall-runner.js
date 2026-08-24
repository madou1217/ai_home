'use strict';

const nodeFs = require('node:fs');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const {
  resolveEnv,
  resolveHostHome,
  resolvePathApi,
  resolvePlatform,
  samePath
} = require('./shared');

function normalizeTargetPath(targetPath, options = {}) {
  const pathImpl = resolvePathApi(options);
  const candidate = String(targetPath || '').trim();
  if (!candidate || !pathImpl.isAbsolute(candidate)) return '';
  const normalized = pathImpl.normalize(candidate);
  const expectedName = resolvePlatform(options) === 'win32' ? 'herdr.exe' : 'herdr';
  return pathImpl.basename(normalized).toLowerCase() === expectedName ? normalized : '';
}

function pathInside(targetPath, directory, options = {}) {
  if (!targetPath || !directory) return false;
  const pathImpl = resolvePathApi(options);
  const normalize = (value) => pathImpl.normalize(String(value));
  const target = normalize(targetPath);
  const root = normalize(directory);
  const compareTarget = resolvePlatform(options) === 'win32' ? target.toLowerCase() : target;
  const compareRoot = resolvePlatform(options) === 'win32' ? root.toLowerCase() : root;
  return compareTarget === compareRoot || compareTarget.startsWith(`${compareRoot}${pathImpl.sep}`);
}

function resolveWindowsOfficialRoots(options = {}) {
  if (resolvePlatform(options) !== 'win32') return null;
  const pathImpl = resolvePathApi(options);
  const env = resolveEnv(options);
  const home = resolveHostHome(options);
  const localAppData = String(env.LOCALAPPDATA || env.LocalAppData || '').trim()
    || (home ? pathImpl.join(home, 'AppData', 'Local') : '');
  if (!home || !localAppData) return null;
  return {
    standaloneRoot: pathImpl.join(home, '.herdr', 'packages', 'standalone'),
    visibleBinDir: pathImpl.join(localAppData, 'Programs', 'Herdr', 'bin')
  };
}

function removePath(fsImpl, targetPath, recursive = false) {
  try {
    if (recursive && typeof fsImpl.rmSync === 'function') {
      fsImpl.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fsImpl.unlinkSync(targetPath);
    }
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeWindowsUserPathEntry(visibleBinDir, options = {}) {
  const spawnSync = options.spawnSync || systemSpawnSync;
  const script = [
    "$key = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$needle = $args[0].TrimEnd('\\')",
    "$parts = @($key -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $needle })",
    "[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')"
  ].join('; ');
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
      visibleBinDir
    ], { encoding: 'utf8', windowsHide: true });
    return Boolean(result && result.status === 0);
  } catch (_error) {
    return false;
  }
}

function executeHerdrUninstall(options = {}) {
  if (options.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  const targetPath = normalizeTargetPath(options.targetPath, options);
  if (!targetPath) return { ok: false, error: 'herdr_uninstall_target_unsafe' };
  const fsImpl = options.fs || nodeFs;
  try {
    const roots = resolveWindowsOfficialRoots(options);
    if (roots && (pathInside(targetPath, roots.standaloneRoot, options)
      || pathInside(targetPath, roots.visibleBinDir, options))) {
      const removedVisibleBin = removePath(fsImpl, roots.visibleBinDir, true);
      const removedStandalone = samePath(roots.visibleBinDir, roots.standaloneRoot, options)
        ? false
        : removePath(fsImpl, roots.standaloneRoot, true);
      const pathUpdated = removeWindowsUserPathEntry(roots.visibleBinDir, options);
      return {
        ok: true,
        installed: false,
        removed: removedVisibleBin || removedStandalone,
        executablePath: targetPath,
        pathUpdated
      };
    }
    const removed = removePath(fsImpl, targetPath, false);
    return { ok: true, installed: false, removed, executablePath: targetPath };
  } catch (error) {
    return {
      ok: false,
      error: 'herdr_uninstall_failed',
      message: String(error && error.message || error)
    };
  }
}

function main(argv = process.argv.slice(2)) {
  const targetFlagIndex = argv.indexOf('--target');
  const result = executeHerdrUninstall({
    confirmed: true,
    platform: process.platform,
    hostHomeDir: process.env.AIH_HOST_HOME || '',
    targetPath: targetFlagIndex >= 0 ? argv[targetFlagIndex + 1] || '' : '',
    env: process.env,
    processObj: process
  });
  (result.ok ? process.stdout : process.stderr).write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  executeHerdrUninstall,
  main,
  normalizeTargetPath,
  pathInside,
  resolveWindowsOfficialRoots
};
