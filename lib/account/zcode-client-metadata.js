'use strict';

const nodePath = require('node:path');
const { resolveHostHomeDir } = require('../runtime/host-home');
const { resolveHostHomeDirFromAiHomeDir } = require('../runtime/codex-home');
const { resolveAccountRuntimeDir: defaultResolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { resolveZcodeAppVersionSync } = require('./zcode-app-version');
const crypto = require('node:crypto');

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

// 版本解析已收敛到 lib/account/zcode-app-version.js（本机安装版 → 缓存 →
// 官方最新版 → 种子）。这里保留同名薄封装，避免调用方跟着改。
function resolveZcodeAppVersion(fs, home, options = {}) {
  return resolveZcodeAppVersionSync({ ...options, fs, home });
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
  // X-Device-Mid 是 zcode 计费/活动接口的**必填参数**：缺它会得
  // 400 {"code":3001,"msg":"parameter error"}。读不到桌面端遗留文件时按账号派生稳定值。
  const explicitDeviceMid = input.deviceMid !== undefined ? String(input.deviceMid || '').trim() : '';
  const deviceMid = explicitDeviceMid
    || readZcodeDeviceMid(fs, input.aiHomeDir, input.accountRef, input)
    || deriveZcodeDeviceMid(input.aiHomeDir, input.accountRef);
  const language = String(input.clientLanguage || 'en-US').trim() || 'en-US';
  const timezone = String(input.clientTimezone || (() => {
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

// 桌面端的 deviceMid 本身就是随机 UUID（设备级标识，非密钥），
// 因此缺失时按账号派生一个稳定 UUID 是等价且可重复的。
function deriveZcodeDeviceMid(aiHomeDir, accountRef) {
  const seed = ['zcode-device-mid', String(aiHomeDir || ''), String(accountRef || '')].join(':');
  const hex = crypto.createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32)
  ].join('-');
}

module.exports = {
  DEFAULT_RELEASE_CHANNEL,
  deriveZcodeDeviceMid,
  appendZcodeAppVersion,
  buildZcodeClientRequestMetadata,
  normalizeOsCategory,
  readZcodeDeviceMid,
  resolveZcodeAppVersion
};
