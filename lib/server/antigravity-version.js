'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let cachedVersion = null;

function parseAntigravityVersion(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function readJsonFileVersion(filePath, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return parseAntigravityVersion(
      parsed && (parsed.version || parsed.productVersion || parsed.commit)
    );
  } catch (_error) {
    return '';
  }
}

function readInfoPlistVersion(appPath, deps = {}) {
  const fsImpl = deps.fs || fs;
  const execFileSyncImpl = deps.execFileSync || execFileSync;
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!fsImpl.existsSync(plistPath)) return '';

  try {
    const raw = execFileSyncImpl('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleShortVersionString',
      plistPath
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(250, Number(deps.timeoutMs) || 1000)
    });
    const version = parseAntigravityVersion(raw);
    if (version) return version;
  } catch (_error) {}

  try {
    const raw = fsImpl.readFileSync(plistPath, 'utf8');
    const match = raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return parseAntigravityVersion(match && match[1]);
  } catch (_error) {
    return '';
  }
}

function listCandidateAppPaths(options = {}) {
  const env = options.env || process.env || {};
  const home = String(env.HOME || '').trim();
  return [
    options.antigravityAppPath,
    env.AIH_ANTIGRAVITY_APP_PATH,
    '/Applications/Antigravity.app',
    home ? path.join(home, 'Applications', 'Antigravity.app') : ''
  ].map((item) => String(item || '').trim()).filter(Boolean);
}

function detectAntigravityClientVersion(options = {}, deps = {}) {
  const env = options.env || process.env || {};
  const configured = parseAntigravityVersion(
    options.antigravityVersion
    || env.AIH_ANTIGRAVITY_VERSION
    || env.AIH_AGY_CODE_ASSIST_CLIENT_VERSION
    || ''
  );
  if (configured) return configured;

  if (cachedVersion !== null && !options.noCache) return cachedVersion;

  const fsImpl = deps.fs || fs;
  for (const appPath of listCandidateAppPaths({ ...options, env })) {
    const infoVersion = readInfoPlistVersion(appPath, { ...deps, fs: fsImpl });
    if (infoVersion) {
      cachedVersion = infoVersion;
      return infoVersion;
    }

    const resourceDir = path.join(appPath, 'Contents', 'Resources');
    for (const relative of ['app/package.json', 'app/product.json', 'package.json', 'product.json']) {
      const version = readJsonFileVersion(path.join(resourceDir, relative), fsImpl);
      if (version) {
        cachedVersion = version;
        return version;
      }
    }
  }

  cachedVersion = '';
  return '';
}

function resetAntigravityClientVersionCacheForTest() {
  cachedVersion = null;
}

module.exports = {
  detectAntigravityClientVersion,
  parseAntigravityVersion,
  resetAntigravityClientVersionCacheForTest,
  __private: {
    listCandidateAppPaths,
    readInfoPlistVersion,
    readJsonFileVersion
  }
};
