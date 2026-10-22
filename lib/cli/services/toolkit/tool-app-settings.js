'use strict';

// 工具启动权限设置的唯一持久化入口。
//
// 默认值：新会话默认授予最大权限（用户明确要求），因此没有记录时 `maxPermission=true`。
// 设置属于本机行为配置，写入 app-state 的 `toolkit:tool-permission-settings`；CLI 启动时
// 直接读同一份记录，不依赖常驻 server（离线/单命令场景同样生效）。
//
// 两级作用域（2026-10-23）：
//   * provider 级（`apps.<provider>`）：该 provider 下所有账号的默认值；
//   * 账户级（`accounts.<accountRef>`）：只作用于一个账号，**优先级更高** ——
//     账号 set-default 后打开 TUI / 桌面端时用账户级设置。
// 账户级只覆盖它**显式设过**的字段：没设的仍回落到 provider 级（而不是回落到默认值），
// 这样「只想给某个账号单独放开权限」不必把 provider 级也抄一遍。

const { readJsonValue, writeJsonValue } = require('../../../server/app-state-store');
const { normalizeProviderId } = require('../../../provider-catalog');
const { isAccountRef } = require('../../../account/public-account-ref');

const TOOL_PERMISSION_SETTINGS_KEY = 'toolkit:tool-permission-settings';
const TOOL_PERMISSION_SETTINGS_VERSION = 2;

const DEFAULT_APP_PERMISSION_SETTINGS = Object.freeze({
  maxPermission: true,
  applyToHost: false,
  // WebUI 逐旗标选择的权限参数（`[]` = 用合同推导的默认最大权限）。
  // 只有用户在界面上显式挑过参数时才非空，且保存前已校验过互斥。
  permissionArgs: Object.freeze([]),
  // 是否让 aih 接管该 CLI 的会话 Hook（「即时刷新」）。
  //
  // 默认 false：安装 Hook 会写用户的全局 CLI 配置（~/.claude/settings.json 等），
  // 启动时自动改用户配置这件事已经被移除过一次（见 provider-session-hook-autoinstall.js
  // 头注释），所以这里必须由用户显式打开。打开后 aih 会记住这个选择：
  //   - 自动升级前后发现 Hook 掉了会装回去（见 provider-cli-upgrade/hook-survival.js）
  //   - 用户不必在每次 CLI 重写配置后手动修复
  // 关闭时 aih 不写、不检查、不恢复。
  sessionHook: false,
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
    sessionHook: source.sessionHook === true,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0
  };
}

// 账户级记录允许「只设一部分」：没出现的键不写进结果，读取时再回落到 provider 级。
// 与 normalizeRecord 的区别是这里不做默认值填充 —— 填充会把「没设」变成「设成了默认值」，
// 于是账户级永远压过 provider 级，用户改 provider 级就对已存在的账号不再生效。
function normalizeAccountOverride(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = {};
  if (Object.prototype.hasOwnProperty.call(source, 'maxPermission')) {
    out.maxPermission = source.maxPermission !== false;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'applyToHost')) {
    out.applyToHost = source.applyToHost === true;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'permissionArgs')) {
    out.permissionArgs = normalizePermissionArgs(source.permissionArgs);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sessionHook')) {
    out.sessionHook = source.sessionHook === true;
  }
  out.updatedAt = Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0;
  return out;
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
  const accounts = source.accounts && typeof source.accounts === 'object' ? source.accounts : {};
  const normalizedAccounts = {};
  for (const [accountRef, record] of Object.entries(accounts)) {
    const normalizedRef = String(accountRef || '').trim();
    // 账户级键必须是合法 accountRef：写坏一个键不该让整份设置读不出来。
    if (!isAccountRef(normalizedRef)) continue;
    normalizedAccounts[normalizedRef] = normalizeAccountOverride(record);
  }
  return {
    version: TOOL_PERMISSION_SETTINGS_VERSION,
    apps: normalizedApps,
    accounts: normalizedAccounts
  };
}

function readToolPermissionSettings(fs, aiHomeDir, deps = {}) {
  const value = readJsonValue(fs, aiHomeDir, TOOL_PERMISSION_SETTINGS_KEY, {
    ...deps,
    bestEffort: true
  });
  return normalizeStore(value);
}

/**
 * 取生效的权限设置。
 *
 * 优先级：账户级（`deps.accountRef`，只覆盖它显式设过的字段）> provider 级 > 内置默认值。
 * 不传 accountRef 时行为与从前完全一致（只有 provider 级）。
 */
function getToolPermissionSettings(providerRaw, fs, aiHomeDir, deps = {}) {
  const provider = normalizeProviderId(providerRaw);
  const store = readToolPermissionSettings(fs, aiHomeDir, deps);
  const record = provider ? store.apps[provider] : null;
  const accountRef = String(deps.accountRef || '').trim();
  const accountRecord = isAccountRef(accountRef) ? store.accounts[accountRef] : null;
  return {
    ...DEFAULT_APP_PERMISSION_SETTINGS,
    ...(record || {}),
    // 账户级放最后：只覆盖它显式设过的键，其余字段保留 provider 级的值。
    ...(accountRecord ? omitUpdatedAt(accountRecord) : {})
  };
}

/** 去掉 updatedAt，便于作为「字段覆盖」展开（updatedAt 不是权限字段）。 */
function omitUpdatedAt(record) {
  const { updatedAt: _updatedAt, ...rest } = record || {};
  return rest;
}

/**
 * 保存权限设置。
 *
 * `deps.accountRef` 存在时写账户级（只记 patch 里出现过的字段，保留未设字段的「未设」语义）；
 * 否则写 provider 级（补齐默认值，与从前一致）。
 */
function saveToolPermissionSettings(providerRaw, patch, fs, aiHomeDir, deps = {}) {
  const provider = normalizeProviderId(providerRaw);
  if (!provider) throw new Error('invalid_provider');
  const store = readToolPermissionSettings(fs, aiHomeDir, deps);
  const input = patch && typeof patch === 'object' ? patch : {};
  const accountRef = String(deps.accountRef || '').trim();
  let saved;
  if (accountRef) {
    if (!isAccountRef(accountRef)) throw new Error('invalid_account_ref');
    const current = store.accounts[accountRef] || {};
    saved = normalizeAccountOverride({ ...current, ...input, updatedAt: Date.now() });
    store.accounts[accountRef] = saved;
  } else {
    const current = {
      ...DEFAULT_APP_PERMISSION_SETTINGS,
      ...(store.apps[provider] || {})
    };
    saved = normalizeRecord({ ...current, ...input, updatedAt: Date.now() });
    store.apps[provider] = saved;
  }
  const written = writeJsonValue(fs, aiHomeDir, TOOL_PERMISSION_SETTINGS_KEY, store, {
    ...deps,
    bestEffort: false
  });
  if (!written) throw new Error('tool_permission_settings_write_failed');
  return saved;
}

module.exports = {
  DEFAULT_APP_PERMISSION_SETTINGS,
  TOOL_PERMISSION_SETTINGS_KEY,
  TOOL_PERMISSION_SETTINGS_VERSION,
  getToolPermissionSettings,
  normalizeAccountOverride,
  normalizeStore,
  readToolPermissionSettings,
  saveToolPermissionSettings
};
