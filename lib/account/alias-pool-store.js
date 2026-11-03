'use strict';

// 「账号是否进入别名自动选号池」的领域持久化层。
//
// 语义（与 WebUI 上的开关一致）：
//   participates = true   默认值。全局别名命中该模型时，这个账号可以参与自动选号。
//   participates = false  账号仍可被显式钉选（x-account-ref）或手动选择使用，但别名请求
//                         不会自动把它拉进候选池。
//
// 之所以是账号级而不是「每条别名带账号清单」：别名表保持全局（可带 provider 作用域），
// 账号只决定自己是否参与，新增别名时不必回头维护成员列表。
//
// 存储沿用 account:window-activation:<ref> / account:egress:<ref> 的命名惯例：
//   account:alias-pool:<ref>  { participates, updatedAt }

const {
  deleteJsonValue,
  readJsonValue,
  readJsonValuesByPrefix,
  writeJsonValue
} = require('../server/app-state-store');
const { isAccountRef, resolveAccountRef } = require('../server/account-ref-store');
const { isKnownProvider } = require('../provider-catalog');

const ALIAS_POOL_KEY_PREFIX = 'account:alias-pool:';

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return isAccountRef(value) ? value : '';
}

function buildAliasPoolConfigKey(accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  return normalizedRef ? `${ALIAS_POOL_KEY_PREFIX}${normalizedRef}` : '';
}

function normalizeAliasPoolConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const updatedAt = Number(raw.updatedAt);
  return {
    participates: raw.participates !== false,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : 0
  };
}

function readAliasPoolConfig(fs, aiHomeDir, accountRef) {
  const key = buildAliasPoolConfigKey(accountRef);
  if (!key) return null;
  const stored = readJsonValue(fs, aiHomeDir, key, { strict: true });
  if (stored === null) return null;
  const config = normalizeAliasPoolConfig(stored);
  if (!config) throw new Error('invalid_alias_pool_config_record');
  return config;
}

/**
 * 账号 → 是否参与别名自动选号。只返回显式写下过 `participates=false` 的账号；
 * 没有记录的账号一律按默认 true 处理（调用方用 Map.has 判定）。
 *
 * @returns {Map<string, boolean>} accountRef → participates
 */
function readAliasPoolParticipationMap(fs, aiHomeDir) {
  const stored = readJsonValuesByPrefix(fs, aiHomeDir, ALIAS_POOL_KEY_PREFIX);
  const result = new Map();
  for (const [key, value] of stored) {
    const accountRef = String(key).slice(ALIAS_POOL_KEY_PREFIX.length);
    if (!normalizeAccountRef(accountRef)) continue;
    const config = normalizeAliasPoolConfig(value);
    if (!config) continue;
    result.set(accountRef, config.participates);
  }
  return result;
}

/**
 * 写入配置；config 为 null 时删除（恢复默认「参与」）。
 *
 * @returns {boolean} true 表示已写入或已删除
 */
function writeAliasPoolConfig(fs, aiHomeDir, accountRef, config, now = Date.now()) {
  const normalizedRef = normalizeAccountRef(accountRef);
  const account = normalizedRef
    ? resolveAccountRef(fs, aiHomeDir, normalizedRef, { bestEffort: true })
    : null;
  if (!account || !isKnownProvider(account.provider)) {
    throw new Error('invalid_alias_pool_account');
  }
  const key = buildAliasPoolConfigKey(normalizedRef);
  if (config === null || config === undefined) {
    deleteJsonValue(fs, aiHomeDir, key);
    return true;
  }
  const normalized = normalizeAliasPoolConfig(config);
  if (!normalized) throw new Error('invalid_alias_pool_config');
  if (!writeJsonValue(fs, aiHomeDir, key, { ...normalized, updatedAt: now })) {
    throw new Error('alias_pool_config_write_failed');
  }
  return true;
}

module.exports = {
  ALIAS_POOL_KEY_PREFIX,
  buildAliasPoolConfigKey,
  normalizeAliasPoolConfig,
  readAliasPoolConfig,
  readAliasPoolParticipationMap,
  writeAliasPoolConfig
};
