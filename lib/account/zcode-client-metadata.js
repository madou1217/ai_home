'use strict';

const nodePath = require('node:path');
const { resolveHostHomeDir } = require('../runtime/host-home');
const { resolveHostHomeDirFromAiHomeDir } = require('../runtime/codex-home');
const { resolveAccountRuntimeDir: defaultResolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');

const DEFAULT_RELEASE_CHANNEL = 'stable';

function readPlistValue(fs, file, key) {
  if (!fs || typeof fs.readFileSync !== 'function') return '';
  try {
    const source = String(fs.readFileSync(file, 'utf8') || '');
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(source);
    return String(match && match[1] || '').trim();
  } catch (_) {
    return '';
  }
}

function resolveZcodeAppVersion(fs, home, options = {}) {
  const explicit = String(
    options.appVersion
      || (options.processObj && options.processObj.env && options.processObj.env.AIH_ZCODE_APP_VERSION)
      || ''
  ).trim();
  if (explicit) return explicit;
  const roots = [];
  if (home) roots.push(nodePath.join(home, 'Applications', 'ZCode.app', 'Contents', 'Info.plist'));
  if (home && options.allowSystemApplications === true
    && (String(options.platform || '').trim() === 'darwin' || !options.platform)) {
    roots.push('/Applications/ZCode.app/Contents/Info.plist');
  }
  for (const file of [...new Set(roots)]) {
    const version = readPlistValue(fs, file, 'CFBundleShortVersionString');
    if (version) return version;
  }
  return '';
}

function readZcodeDeviceMid(fs, aiHomeDir, accountRef, options = {}) {
  const resolveAccountRuntimeDir = typeof options.resolveAccountRuntimeDir === 'function'
    ? options.resolveAccountRuntimeDir
    : defaultResolveAccountRuntimeDir;
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'zcode', accountRef);
  const file = runtimeDir ? nodePath.join(runtimeDir, '.zcode', 'v2', 'telemetry-state.json') : '';
  if (!file) return '';
  try {
    const parsed = JSON.parse(String(fs.readFileSync(file, 'utf8') || ''));
    return String(parsed && parsed.deviceMid || '').trim();
  } catch (_) {
    return '';
  }
}

function normalizeOsCategory(platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

function buildZcodeClientRequestMetadata(fs, input = {}) {
  const processObj = input.processObj || process;
  const env = processObj.env || {};
  const platform = String(input.platform || processObj.platform || process.platform);
  const arch = String(input.arch || processObj.arch || process.arch);
  const explicitHome = String(input.home || input.hostHomeDir || '').trim();
  const hasHostEnv = [
    'AIH_HOST_HOME',
    'USERPROFILE',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH'
  ].some((key) => String(env[key] || '').trim());
  const home = explicitHome
    || (input.processObj && hasHostEnv
      ? resolveHostHomeDir({ env, platform, hostHomeDir: input.hostHomeDir })
      : resolveHostHomeDirFromAiHomeDir(input.aiHomeDir));
  const appVersion = resolveZcodeAppVersion(fs, home, {
    ...input,
    processObj,
    platform,
    allowSystemApplications: input.allowSystemApplications === true
      || Boolean(input.processObj || input.hostHomeDir)
  });
  const deviceMid = input.deviceMid !== undefined
    ? String(input.deviceMid || '').trim()
    : readZcodeDeviceMid(fs, input.aiHomeDir, input.accountRef, input);
  const language = String(input.clientLanguage || env.AIH_ZCODE_CLIENT_LANGUAGE || 'en-US').trim() || 'en-US';
  const timezone = String(input.clientTimezone || env.AIH_ZCODE_CLIENT_TIMEZONE || (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
  })()).trim() || 'UTC';
  const headers = {
    'User-Agent': `ZCode/${appVersion || 'unknown'}`,
    'HTTP-Referer': 'https://zcode.z.ai',
    'X-Title': 'Z Code@electron',
    'X-Platform': `${platform}-${arch}`,
    'X-Release-Channel': String(input.releaseChannel || DEFAULT_RELEASE_CHANNEL),
    'X-Client-Language': language,
    'X-Client-Timezone': timezone,
    'X-Os-Category': normalizeOsCategory(platform)
  };
  if (appVersion) headers['X-ZCode-App-Version'] = appVersion;
  if (deviceMid) headers['X-Device-Mid'] = deviceMid;
  return { appVersion, deviceMid, headers };
}

function appendZcodeAppVersion(url, appVersion) {
  const value = String(url || '').trim();
  const version = String(appVersion || '').trim();
  if (!value || !version) return value;
  try {
    const parsed = new URL(value);
    parsed.searchParams.set('app_version', version);
    return parsed.toString();
  } catch (_) {
    return value;
  }
}

module.exports = {
  DEFAULT_RELEASE_CHANNEL,
  appendZcodeAppVersion,
  buildZcodeClientRequestMetadata,
  normalizeOsCategory,
  readZcodeDeviceMid,
  resolveZcodeAppVersion
};
