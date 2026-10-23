'use strict';

// 工具启动权限设置的唯一持久化入口。
//
// 默认值：新会话默认授予最大权限（用户明确要求），因此没有记录时 `maxPermission=true`。
// 设置属于本机行为配置，写入 app-state 的 `toolkit:tool-permission-settings`；CLI 启动时
// 直接读同一份记录，不依赖常驻 server（离线/单命令场景同样生效）。

const { readJsonValue, writeJsonValue } = require('../../../server/app-state-store');
const { normalizeProviderId } = require('../../../provider-catalog');

const TOOL_PERMISSION_SETTINGS_KEY = 'toolkit:tool-permission-settings';
const TOOL_PERMISSION_SETTINGS_VERSION = 1;

const DEFAULT_APP_PERMISSION_SETTINGS = Object.freeze({
  maxPermission: true,
  applyToHost: false,
  // WebUI 逐旗标选择的权限参数（`[]` = 用合同推导的默认最大权限）。
  // 只有用户在界面上显式挑过参数时才非空，且保存前已校验过互斥。
  permissionArgs: Object.freeze([]),
  updatedAt: 0
});

function normalizePermissionArgs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item === undefined || item === null ? '' : item).trim())
    .filter((item) => item.length > 0);
}

function normalizeRecord(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    maxPermission: source.maxPermission !== false,
    applyToHost: source.applyToHost === true,
    permissionArgs: normalizePermissionArgs(source.permissionArgs),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0
  };
}

function normalizeStore(value) {
  const source = value && typeof value === 'object' ? value : {};
  const apps = source.apps && typeof source.apps === 'object' ? source.apps : {};
  const normalizedApps = {};
  for (const [provider, record] of Object.entries(apps)) {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider) continue;
    normalizedApps[normalizedProvider] = normalizeRecord(record);
  }
  return {
    version: TOOL_PERMISSION_SETTINGS_VERSION,
    apps: normalizedApps
  };
}

function readToolPermissionSettings(fs, aiHomeDir, deps = {}) {
  const value = readJsonValue(fs, aiHomeDir, TOOL_PERMISSION_SETTINGS_KEY, {
    ...deps,
    bestEffort: true
  });
  return normalizeStore(value);
}

function getToolPermissionSettings(providerRaw, fs, aiHomeDir, deps = {}) {
  const provider = normalizeProviderId(providerRaw);
  const store = readToolPermissionSettings(fs, aiHomeDir, deps);
  const record = provider ? store.apps[provider] : null;
  return {
    ...DEFAULT_APP_PERMISSION_SETTINGS,
    ...(record || {})
  };
}

function saveToolPermissionSettings(providerRaw, patch, fs, aiHomeDir, deps = {}) {
  const provider = normalizeProviderId(providerRaw);
  if (!provider) throw new Error('invalid_provider');
  const store = readToolPermissionSettings(fs, aiHomeDir, deps);
  const current = {
    ...DEFAULT_APP_PERMISSION_SETTINGS,
    ...(store.apps[provider] || {})
  };
  const next = normalizeRecord({
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
    updatedAt: Date.now()
  });
  store.apps[provider] = next;
  const written = writeJsonValue(fs, aiHomeDir, TOOL_PERMISSION_SETTINGS_KEY, store, {
    ...deps,
    bestEffort: false
  });
  if (!written) throw new Error('tool_permission_settings_write_failed');
  return next;
}

module.exports = {
  DEFAULT_APP_PERMISSION_SETTINGS,
  TOOL_PERMISSION_SETTINGS_KEY,
  TOOL_PERMISSION_SETTINGS_VERSION,
  getToolPermissionSettings,
  normalizeStore,
  readToolPermissionSettings,
  saveToolPermissionSettings
};
