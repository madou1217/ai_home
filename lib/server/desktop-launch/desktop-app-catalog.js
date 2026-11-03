'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { execFileSync: nodeExecFileSync } = require('node:child_process');

// 桌面端应用目录：provider ↔ 已安装 .app 的唯一映射表。
//
// 为什么需要这张表：`aih desktop status` 要回答「canonical 是哪个版本、各账号实际跑的是哪个版本」，
// 而 manifest 只声明 `clients.desktop = true`，没有 bundle 名/bundle id。映射放在 desktop-launch 层
// （而不是 CLI 层）是为了让后面的统一升级通道复用同一份事实：新增 family 只改这张表。
//
// 一个 bundle 可能服务多个 provider（CodeBuddy.app 同时是 codebuddy / codebuddycn 的桌面端），
// 因此 providers 是数组而不是单值。
const DESKTOP_APPS = Object.freeze([
  Object.freeze({
    key: 'zcode',
    providers: Object.freeze(['zcode']),
    bundleNames: Object.freeze(['ZCode.app', 'ZCode Desktop.app']),
    bundleIds: Object.freeze(['dev.zcode.app']),
    shadowDirName: 'zcode-shadow'
  }),
  Object.freeze({
    key: 'codebuddy',
    providers: Object.freeze(['codebuddy', 'codebuddycn']),
    bundleNames: Object.freeze(['CodeBuddy.app']),
    bundleIds: Object.freeze(['com.tencent.codebuddy']),
    shadowDirName: ''
  }),
  Object.freeze({
    key: 'workbuddy',
    providers: Object.freeze(['workbuddy']),
    bundleNames: Object.freeze(['WorkBuddy AI.app']),
    bundleIds: Object.freeze(['com.workbuddy.workbuddy-ai']),
    shadowDirName: ''
  }),
  Object.freeze({
    key: 'workbuddy-cn',
    providers: Object.freeze(['workbuddycn']),
    bundleNames: Object.freeze(['WorkBuddy.app']),
    bundleIds: Object.freeze(['com.tencent.workbuddy.mac']),
    shadowDirName: ''
  }),
  Object.freeze({
    key: 'claude',
    providers: Object.freeze(['claude']),
    bundleNames: Object.freeze(['Claude.app']),
    bundleIds: Object.freeze(['com.anthropic.claudefordesktop']),
    shadowDirName: ''
  }),
  Object.freeze({
    key: 'codex',
    providers: Object.freeze(['codex']),
    bundleNames: Object.freeze(['ChatGPT.app']),
    bundleIds: Object.freeze(['com.openai.codex']),
    shadowDirName: ''
  }),
  Object.freeze({
    key: 'kiro',
    providers: Object.freeze(['kiro']),
    bundleNames: Object.freeze(['Kiro CLI.app']),
    bundleIds: Object.freeze(['com.amazon.codewhisperer']),
    shadowDirName: ''
  })
]);

// 二进制 plist（bplist00）读不了就交给 plutil 转一份 XML——只读，失败返回空串。
// Kiro / 部分 Electron 应用的 Info.plist 就是二进制格式（实测 Kiro CLI.app）。
function readPlistXml(fs, pathImpl, infoPath, execFileSyncImpl) {
  let raw = '';
  try {
    raw = String(fs.readFileSync(infoPath, 'utf8') || '');
  } catch (_error) {
    return '';
  }
  if (raw.includes('<plist')) return raw;
  const exec = execFileSyncImpl === undefined ? nodeExecFileSync : execFileSyncImpl;
  if (typeof exec !== 'function') return '';
  try {
    return String(exec('plutil', ['-convert', 'xml1', '-o', '-', infoPath], { encoding: 'utf8' }) || '');
  } catch (_error) {
    return '';
  }
}

function readPlistValue(xml, key) {
  const pattern = new RegExp('<key>' + key + '</key>\\s*<string>([^<]*)</string>');
  const match = pattern.exec(xml);
  return match ? String(match[1]).trim() : '';
}

/** 读 .app/Contents/Info.plist 的关键字段；二进制 plist 或读不到时返回空串（不抛）。 */
function readBundleInfo(fs, pathImpl, bundlePath, options = {}) {
  const infoPath = pathImpl.join(bundlePath, 'Contents', 'Info.plist');
  const xml = readPlistXml(fs, pathImpl, infoPath, options.execFileSync);
  if (!xml.includes('<plist')) return { version: '', bundleId: '' };
  return {
    version: readPlistValue(xml, 'CFBundleShortVersionString'),
    bundleId: readPlistValue(xml, 'CFBundleIdentifier')
  };
}

// process.platform 是 darwin，内部口径统一叫 macos（与 desktop-launch 其它模块一致）。
function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  return platform === 'darwin' ? 'macos' : platform;
}

function installRoots(platform, homeDir) {
  if (normalizePlatform(platform) !== 'macos') return [];
  return [
    '/Applications',
    homeDir ? nodePath.join(homeDir, 'Applications') : ''
  ].filter(Boolean);
}

/**
 * 解析某个桌面应用在本机的安装位置。返回第一个存在的候选项；都没有则 installed=false。
 * platform 非 macOS 时不猜路径（桌面端目前只在 macOS 有这套 shadow/投影语义）。
 */
function resolveInstalledApp(entry, options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const platform = String(options.platform || process.platform || '').trim().toLowerCase();
  const roots = installRoots(platform, String(options.homeDir || '').trim());
  for (const root of roots) {
    for (const bundleName of entry.bundleNames) {
      const candidate = pathImpl.join(root, bundleName);
      let stat = null;
      try { stat = fs.statSync(candidate); } catch (_error) { stat = null; }
      if (!stat || !stat.isDirectory()) continue;
      const info = readBundleInfo(fs, pathImpl, candidate, { execFileSync: options.execFileSync });
      return {
        key: entry.key,
        providers: entry.providers.slice(),
        installed: true,
        path: candidate,
        bundleId: info.bundleId || entry.bundleIds[0] || '',
        version: info.version
      };
    }
  }
  return {
    key: entry.key,
    providers: entry.providers.slice(),
    installed: false,
    path: '',
    bundleId: entry.bundleIds[0] || '',
    version: ''
  };
}

function listDesktopApps() {
  return DESKTOP_APPS.slice();
}

module.exports = {
  DESKTOP_APPS,
  normalizePlatform,
  listDesktopApps,
  readBundleInfo,
  resolveInstalledApp
};
