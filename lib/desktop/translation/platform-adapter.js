'use strict';

const { buildMacTranslationHelper, buildMacTranslationApp } = require('./macos-build');
const {
  buildWindowsTranslationHelper,
  buildWindowsTranslationApp
} = require('./windows-build');

const PLATFORM_IDS = new Set(['darwin', 'win32', 'linux']);

const BASE_DESCRIPTORS = Object.freeze({
  darwin: Object.freeze({
    id: 'darwin',
    supported: true,
    captureModes: ['accessibility', 'services', 'shortcut'],
    permission: 'accessibility',
    shortcut: '⌘⌥T',
    environmentKeys: ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'],
    statusText: '在本机应用或网页中选词后点击「译」',
  }),
  win32: Object.freeze({
    id: 'win32',
    supported: true,
    captureModes: ['shortcut-clipboard'],
    permission: 'clipboard-shortcut',
    shortcut: 'Ctrl+Alt+T',
    environmentKeys: ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'LC_ALL'],
    statusText: '使用全局快捷键复制选区后翻译',
  }),
  linux: Object.freeze({
    id: 'linux',
    supported: false,
    captureModes: [],
    permission: 'none',
    shortcut: '',
    environmentKeys: ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL'],
    statusText: 'Linux 桌面版暂未提供；可继续使用 WebUI 划词翻译',
  }),
});

function normalizePlatform(value) {
  const platform = String(value || process.platform).trim().toLowerCase();
  return PLATFORM_IDS.has(platform) ? platform : platform || 'unknown';
}

function getTranslationPlatformAdapter(platform = process.platform, options = {}) {
  const id = normalizePlatform(platform);
  const base = BASE_DESCRIPTORS[id] || {
    id,
    supported: false,
    captureModes: [],
    permission: 'unknown',
    shortcut: '',
    environmentKeys: [],
    statusText: `当前平台（${id}）暂未提供桌面翻译 helper`,
  };
  const mode = options.mode === 'full-app' ? 'full-app' : 'helper';
  const injectedBuild = typeof options.build === 'function' ? options.build : null;
  const build = injectedBuild || (id === 'darwin'
    ? (mode === 'full-app' ? buildMacTranslationApp : buildMacTranslationHelper)
    : id === 'win32'
      ? (mode === 'full-app' ? buildWindowsTranslationApp : buildWindowsTranslationHelper)
      : null);
  return {
    ...base,
    mode,
    supported: Boolean(injectedBuild) || base.supported,
    build: Boolean(injectedBuild) || base.supported ? build : null,
    injected: Boolean(injectedBuild),
  };
}

module.exports = { getTranslationPlatformAdapter, normalizePlatform };
