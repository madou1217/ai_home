'use strict';

const { spawn } = require('node:child_process');

const NPM_REGISTRY = 'https://registry.npmjs.org';
const LATEST_VERSION_CACHE_MS = 10 * 60 * 1000;

const VERSION_SOURCE_TYPES = Object.freeze({
  NPM: 'npm',
  HOMEBREW_CASK: 'homebrew_cask',
  WINGET: 'winget'
});

function normalizePackageName(value) {
  const packageName = String(value || '').trim();
  return /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i.test(packageName)
    ? packageName
    : '';
}

function normalizeHomebrewCaskName(value) {
  const cask = String(value || '').trim();
  return /^[a-z0-9][a-z0-9+._@/-]*$/i.test(cask) ? cask : '';
}

function normalizeWingetId(value) {
  const packageId = String(value || '').trim();
  return /^[a-z0-9][a-z0-9._+/-]*$/i.test(packageId) ? packageId : '';
}

function normalizeVersionSource(source) {
  if (typeof source === 'string') {
    const packageName = normalizePackageName(source);
    return packageName ? { type: VERSION_SOURCE_TYPES.NPM, packageName } : null;
  }
  if (!source || typeof source !== 'object') return null;
  const type = String(source.type || source.kind || '').trim().toLowerCase();
  if (type === VERSION_SOURCE_TYPES.NPM) {
    const packageName = normalizePackageName(source.packageName || source.package || source.name);
    return packageName ? { type, packageName } : null;
  }
  if (type === VERSION_SOURCE_TYPES.HOMEBREW_CASK) {
    const cask = normalizeHomebrewCaskName(source.cask || source.name || source.id);
    return cask ? { type, cask } : null;
  }
  if (type === VERSION_SOURCE_TYPES.WINGET) {
    const packageId = normalizeWingetId(source.id || source.packageId || source.name);
    return packageId ? { type, id: packageId } : null;
  }
  return null;
}

function normalizeVersion(value) {
  const match = String(value || '').match(/(?:^|[^0-9])v?(\d+(?:\.\d+){1,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?=$|[^0-9A-Za-z])/);
  if (!match) return null;
  return {
    text: match[0].replace(/^[^0-9]*/, '').replace(/^v/, ''),
    parts: match[1].split('.').map((part) => Number(part)),
    prerelease: match[2] ? match[2].split('.') : []
  };
}

function compareVersions(left, right) {
  const leftVersion = normalizeVersion(left);
  const rightVersion = normalizeVersion(right);
  if (!leftVersion || !rightVersion) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftVersion.parts[index] || 0) - (rightVersion.parts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length); index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function captureCommand(command, args, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 8000, 500), 30000);
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnImpl(command, args, {
        encoding: 'utf8',
        windowsHide: true,
        env: options.env || (options.processObj && options.processObj.env) || undefined
      });
    } catch (error) {
      finish({ ok: false, stdout, stderr, error });
      return;
    }

    if (!child || typeof child.once !== 'function') {
      finish({ ok: false, stdout, stderr, error: new Error('command_process_unavailable') });
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.once('error', (error) => finish({ ok: false, stdout, stderr, error }));
    child.once('close', (code) => finish({ ok: code === 0, stdout, stderr, error: null }));
    timer = setTimeout(() => {
      try { child.kill?.(); } catch (_error) {}
      finish({ ok: false, stdout, stderr, error: new Error('latest_version_timeout') });
    }, timeoutMs);
    timer.unref?.();
  });
}

async function queryNpmLatestVersion(packageName, options = {}) {
  const normalizedPackage = normalizePackageName(packageName);
  if (!normalizedPackage) return { ok: false, error: 'unsupported_package' };
  const processObj = options.processObj || process;
  const isWindows = String(processObj.platform || process.platform) === 'win32';
  const command = isWindows ? 'npm.cmd' : 'npm';
  const userConfig = isWindows ? 'NUL' : '/dev/null';
  const result = await captureCommand(command, [
    'view', normalizedPackage, 'version',
    `--userconfig=${userConfig}`,
    `--registry=${NPM_REGISTRY}`
  ], options);
  const latestVersion = result.ok ? normalizeVersion(result.stdout)?.text : null;
  if (!latestVersion) {
    return {
      ok: false,
      error: result.error?.message || String(result.stderr || '').trim() || 'latest_version_unavailable'
    };
  }
  return { ok: true, packageName: normalizedPackage, latestVersion };
}

function parseHomebrewCaskVersion(output) {
  try {
    const parsed = JSON.parse(String(output || ''));
    const cask = Array.isArray(parsed && parsed.casks) ? parsed.casks[0] : null;
    return normalizeVersion(cask && cask.version)?.text || null;
  } catch (_error) {
    return null;
  }
}

async function queryHomebrewCaskLatestVersion(cask, options = {}) {
  const normalizedCask = normalizeHomebrewCaskName(cask);
  if (!normalizedCask) return { ok: false, error: 'unsupported_cask' };
  const result = await captureCommand('brew', [
    'info',
    '--cask',
    '--json=v2',
    normalizedCask
  ], options);
  const latestVersion = result.ok ? parseHomebrewCaskVersion(result.stdout) : null;
  if (!latestVersion) {
    return {
      ok: false,
      error: result.error?.message || String(result.stderr || '').trim() || 'latest_version_unavailable'
    };
  }
  return { ok: true, cask: normalizedCask, latestVersion };
}

function parseWingetLatestVersion(output) {
  const match = String(output || '').match(/^\s*(?:Version|版本)\s*:\s*(\S+)/im);
  return match ? normalizeVersion(match[1])?.text || null : null;
}

async function queryWingetLatestVersion(packageId, options = {}) {
  const normalizedId = normalizeWingetId(packageId);
  if (!normalizedId) return { ok: false, error: 'unsupported_winget_id' };
  const processObj = options.processObj || process;
  const command = String(processObj.platform || process.platform) === 'win32' ? 'winget.exe' : 'winget';
  const result = await captureCommand(command, [
    'show',
    '--id', normalizedId,
    '--exact',
    '--source', 'winget',
    '--accept-source-agreements',
    '--disable-interactivity'
  ], options);
  const latestVersion = result.ok ? parseWingetLatestVersion(`${result.stdout}\n${result.stderr}`) : null;
  if (!latestVersion) {
    return {
      ok: false,
      error: result.error?.message || String(result.stderr || '').trim() || 'latest_version_unavailable'
    };
  }
  return { ok: true, id: normalizedId, latestVersion };
}

function versionSourceKey(source) {
  if (!source) return '';
  if (source.type === VERSION_SOURCE_TYPES.NPM) return `${source.type}:${source.packageName}`.toLowerCase();
  if (source.type === VERSION_SOURCE_TYPES.HOMEBREW_CASK) return `${source.type}:${source.cask}`.toLowerCase();
  if (source.type === VERSION_SOURCE_TYPES.WINGET) return `${source.type}:${source.id}`.toLowerCase();
  return '';
}

function createAppUpdateChecker(options = {}) {
  const latestCache = new Map();
  const latestInFlight = new Map();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const queryNpmVersion = typeof options.queryLatestVersion === 'function'
    ? options.queryLatestVersion
    : queryNpmLatestVersion;
  const queryCaskVersion = typeof options.queryHomebrewCaskLatestVersion === 'function'
    ? options.queryHomebrewCaskLatestVersion
    : queryHomebrewCaskLatestVersion;
  const queryWingetVersion = typeof options.queryWingetLatestVersion === 'function'
    ? options.queryWingetLatestVersion
    : queryWingetLatestVersion;

  function getLatestVersion(sourceInput, queryOptions = {}) {
    const source = normalizeVersionSource(sourceInput);
    if (!source) return Promise.resolve({ ok: false, error: 'unsupported_version_source' });
    const key = versionSourceKey(source);
    if (!key) return Promise.resolve({ ok: false, error: 'unsupported_version_source' });
    const cached = latestCache.get(key);
    if (cached && now() - cached.at < LATEST_VERSION_CACHE_MS) return Promise.resolve(cached.value);
    const pending = latestInFlight.get(key);
    if (pending) return pending;
    const query = source.type === VERSION_SOURCE_TYPES.NPM
      ? queryNpmVersion
      : source.type === VERSION_SOURCE_TYPES.HOMEBREW_CASK
        ? queryCaskVersion
        : queryWingetVersion;
    const queryValue = source.type === VERSION_SOURCE_TYPES.NPM
      ? source.packageName
      : source.type === VERSION_SOURCE_TYPES.HOMEBREW_CASK
        ? source.cask
        : source.id;
    const request = Promise.resolve(query(queryValue, {
      ...options,
      ...queryOptions
    })).then((value) => {
      const normalized = value && value.ok && normalizeVersion(value.latestVersion)?.text
        ? { ...value, latestVersion: normalizeVersion(value.latestVersion).text }
        : { ok: false, error: String(value && value.error || 'latest_version_unavailable') };
      latestCache.set(key, { at: now(), value: normalized });
      return normalized;
    }).catch((error) => {
      const value = { ok: false, error: String(error && error.message || error || 'latest_version_unavailable') };
      latestCache.set(key, { at: now(), value });
      return value;
    }).finally(() => {
      if (latestInFlight.get(key) === request) latestInFlight.delete(key);
    });
    latestInFlight.set(key, request);
    return request;
  }

  async function check(app, queryOptions = {}) {
    const currentVersion = normalizeVersion(app && app.version)?.text || null;
    const versionSource = normalizeVersionSource(app && app.versionSource)
      || normalizeVersionSource(app && app.pkg);
    const base = {
      ok: true,
      appId: String(app && app.id || ''),
      provider: String(app && app.provider || ''),
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      status: 'unavailable'
    };
    if (!versionSource) {
      return { ...base, error: 'latest_version_source_unavailable', message: '当前应用没有可验证的官方远程版本源。' };
    }
    const latest = await getLatestVersion(versionSource, queryOptions);
    if (!latest.ok) {
      return {
        ...base,
        ok: false,
        error: 'latest_version_unavailable',
        message: String(latest.error || '无法读取官方最新版')
      };
    }
    const comparison = compareVersions(currentVersion, latest.latestVersion);
    return {
      ...base,
      latestVersion: latest.latestVersion,
      updateAvailable: comparison !== null && comparison < 0,
      status: comparison === null ? 'unknown' : comparison < 0 ? 'available' : 'current'
    };
  }

  function invalidate() {
    latestCache.clear();
    latestInFlight.clear();
  }

  return { check, getLatestVersion, invalidate };
}

const defaultChecker = createAppUpdateChecker();

function checkManagedAppUpdate(app, options = {}) {
  if (options.updateChecker && typeof options.updateChecker.check === 'function') {
    return options.updateChecker.check(app, options);
  }
  return defaultChecker.check(app, options);
}

module.exports = {
  NPM_REGISTRY,
  compareVersions,
  createAppUpdateChecker,
  normalizeHomebrewCaskName,
  normalizePackageName,
  normalizeVersion,
  normalizeVersionSource,
  normalizeWingetId,
  parseHomebrewCaskVersion,
  parseWingetLatestVersion,
  queryHomebrewCaskLatestVersion,
  queryNpmLatestVersion,
  queryWingetLatestVersion,
  checkManagedAppUpdate
};
