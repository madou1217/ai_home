'use strict';

const {
  isSupportedProvider,
  listEnabledProviders
} = require('./providers');
const {
  readJsonValue,
  writeJsonValue
} = require('./app-state-store');
const { isAccountRef } = require('./account-ref-store');

const MODEL_CATALOG_SETTINGS_DB_KEY = 'model-catalog-settings';
// v5 adds account-scoped default model selection.
// 账号自定义价格（customPricing，每百万 token 美元）复用 v5 记录形状，只加字段不改版本：
// 旧版本读取方忽略未知字段，无需迁移。
const SETTINGS_VERSION = 5;

function normalizeModelId(value) {
  return String(value || '').trim();
}

function getModelKey(modelId) {
  return normalizeModelId(modelId).toLowerCase();
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return isSupportedProvider(provider) ? provider : '';
}

function normalizeAccountRef(value) {
  const accountRef = String(value || '').trim();
  return isAccountRef(accountRef) ? accountRef : '';
}

function normalizeTimestamp(value, fallback = 0) {
  const timestamp = Number(value || fallback || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}

const CUSTOM_PRICING_KEYS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
const CUSTOM_PRICING_LEGACY_KEYS = Object.freeze({
  cacheRead: 'cache_read',
  cacheWrite: 'cache_write'
});

function readCustomPricingNumber(value, key) {
  const legacyKey = CUSTOM_PRICING_LEGACY_KEYS[key];
  const raw = value[key] !== undefined ? value[key] : legacyKey !== undefined ? value[legacyKey] : undefined;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// 规范化账号自定义价格：只保留 4 个已知键的非负有限数；没有任何有效值时返回 undefined
// （语义＝未设置），避免把“没有自定义价”持久化成空对象。
function normalizeCustomPricing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  let hasValue = false;
  CUSTOM_PRICING_KEYS.forEach((key) => {
    const number = readCustomPricingNumber(value, key);
    if (number !== null) {
      out[key] = number;
      hasValue = true;
    }
  });
  return hasValue ? out : undefined;
}

function normalizeLegacyModelSettingRecord(value, fallback = {}) {
  const source = {
    ...(fallback || {}),
    ...(value || {})
  };
  const id = normalizeModelId(source.id || source.model || source.modelId);
  if (!id) return null;
  return {
    id,
    provider: normalizeProvider(source.provider),
    enabled: source.enabled !== false,
    manual: source.manual === true,
    description: String(source.description || '').trim(),
    createdAt: normalizeTimestamp(source.createdAt || source.created_at, fallback.createdAt),
    updatedAt: normalizeTimestamp(source.updatedAt || source.updated_at)
  };
}

const UNSUPPORTED_ACCOUNT_SCOPE_FIELDS = ['account' + 'Key', 'accountId', 'uniqueKey'];

function hasUnsupportedAccountScopeMarker(value) {
  if (!value) return false;
  if (value.accountRef) return true;
  return UNSUPPORTED_ACCOUNT_SCOPE_FIELDS.some((field) => Boolean(value[field]));
}

function normalizeAccountModelSettingRecord(value) {
  const source = value || {};
  const id = normalizeModelId(source.id || source.model || source.modelId);
  if (!id) return null;

  const accountRef = normalizeAccountRef(source.accountRef);
  if (!accountRef) return null;

  const customPricing = normalizeCustomPricing(source.customPricing);
  return {
    id,
    provider: normalizeProvider(source.provider),
    accountRef,
    enabled: source.enabled !== false,
    manual: source.manual === true,
    defaultModel: source.defaultModel === true || source.default === true,
    description: String(source.description || '').trim(),
    // 无自定义价时不落空键：DB 是 JSON，undefined 键本来也会在序列化时消失，
    // 提前保持内存形状与落盘形状一致。
    ...(customPricing ? { customPricing } : {}),
    createdAt: normalizeTimestamp(source.createdAt || source.created_at),
    updatedAt: normalizeTimestamp(source.updatedAt || source.updated_at)
  };
}

function accountRecordMatches(record, target) {
  if (!record || !target) return false;
  const recordRef = normalizeAccountRef(record.accountRef);
  const targetRef = normalizeAccountRef(target.accountRef);
  return Boolean(recordRef && targetRef && recordRef === targetRef);
}

function getAccountModelSettingIdentity(record) {
  return normalizeAccountRef(record && record.accountRef);
}

function getAccountModelSettingKey(record) {
  const normalized = normalizeAccountModelSettingRecord(record);
  return normalized ? `${getAccountModelSettingIdentity(normalized)}\u0000${getModelKey(normalized.id)}` : '';
}

function getLegacyModelSettingKey(record) {
  const normalized = normalizeLegacyModelSettingRecord(record);
  return normalized ? `${normalized.provider}\u0000${getModelKey(normalized.id)}` : '';
}

function normalizeModelCatalogSettings(data) {
  const sourceAccountModels = Array.isArray(data && data.accountModels) ? data.accountModels : [];
  const sourceModels = Array.isArray(data && data.models) ? data.models : [];
  const accountModelsByKey = new Map();
  const legacyModelsByKey = new Map();

  sourceAccountModels.forEach((item) => {
    const normalized = normalizeAccountModelSettingRecord(item);
    if (!normalized) return;
    accountModelsByKey.set(getAccountModelSettingKey(normalized), normalized);
  });

  sourceModels.forEach((item) => {
    const normalizedAccountModel = normalizeAccountModelSettingRecord(item);
    if (normalizedAccountModel) {
      accountModelsByKey.set(getAccountModelSettingKey(normalizedAccountModel), normalizedAccountModel);
      return;
    }
    if (hasUnsupportedAccountScopeMarker(item)) return;
    const legacy = normalizeLegacyModelSettingRecord(item);
    if (!legacy) return;
    legacyModelsByKey.set(getLegacyModelSettingKey(legacy), legacy);
  });

  const bySortKey = (left, right) => (
    left.provider.localeCompare(right.provider)
    || String(left.accountRef || '').localeCompare(String(right.accountRef || ''))
    || left.id.localeCompare(right.id)
  );

  return {
    version: SETTINGS_VERSION,
    accountModels: Array.from(accountModelsByKey.values()).sort(bySortKey),
    legacyModels: Array.from(legacyModelsByKey.values()).sort(bySortKey),
    updatedAt: Number(data && data.updatedAt || 0) || 0
  };
}

// 同步读取入口：底层 app-state 读取本身就是同步的。用量计价链（resolver.resolve）
// 是同步函数，不能 await，因此必须提供同步变体；异步入口保留给既有调用方。
function readModelCatalogSettings(fs, aiHomeDir, options = {}) {
  if (!fs || !aiHomeDir) return normalizeModelCatalogSettings(null);
  return normalizeModelCatalogSettings(readJsonValue(fs, aiHomeDir, MODEL_CATALOG_SETTINGS_DB_KEY, options));
}

async function loadModelCatalogSettings(fs, aiHomeDir, options = {}) {
  return readModelCatalogSettings(fs, aiHomeDir, options);
}

async function saveModelCatalogSettings(fs, aiHomeDir, data) {
  const normalized = normalizeModelCatalogSettings({
    ...(data || {}),
    updatedAt: Date.now()
  });
  writeJsonValue(fs, aiHomeDir, MODEL_CATALOG_SETTINGS_DB_KEY, normalized);
  return normalized;
}

function findLegacyModelSetting(settings, modelId, provider = '') {
  const key = getModelKey(modelId);
  if (!key) return null;
  const normalizedProvider = normalizeProvider(provider);
  const current = normalizeModelCatalogSettings(settings);
  return current.legacyModels.find((item) => (
    getModelKey(item && item.id) === key
    && (!normalizedProvider || !item.provider || item.provider === normalizedProvider)
  )) || null;
}

function findAccountModelSetting(settings, input) {
  const target = normalizeAccountModelSettingRecord(input);
  if (!target) return null;
  const targetModelKey = getModelKey(target.id);
  const records = normalizeModelCatalogSettings(settings).accountModels;
  return records.find((item) => (
    getModelKey(item.id) === targetModelKey && accountRecordMatches(item, target)
  )) || null;
}

function findDefaultAccountModelSetting(settings, input) {
  const target = normalizeAccountScopeInput(input);
  if (!target) return null;
  const records = normalizeModelCatalogSettings(settings).accountModels;
  return records.find((item) => (
    item.defaultModel === true
    && item.enabled !== false
    && accountRecordMatches(item, target)
  )) || null;
}

function normalizeAccountScopeInput(input) {
  if (typeof input === 'string') {
    const accountRef = normalizeAccountRef(input);
    return accountRef ? { accountRef } : null;
  }
  const accountRef = normalizeAccountRef(input && input.accountRef);
  return accountRef ? { accountRef } : null;
}

function findModelSetting(settings, modelId) {
  const key = getModelKey(modelId);
  if (!key) return null;
  const current = normalizeModelCatalogSettings(settings);
  return current.legacyModels.find((item) => getModelKey(item && item.id) === key)
    || current.accountModels.find((item) => getModelKey(item && item.id) === key)
    || null;
}

function isModelEnabled(settings, modelId, provider = '') {
  const record = findLegacyModelSetting(settings, modelId, provider);
  return !record || record.enabled !== false;
}

function isAccountModelEnabled(settings, input) {
  const target = normalizeAccountModelSettingRecord(input);
  if (!target) return isModelEnabled(settings, input && (input.id || input.model || input.modelId), input && input.provider);
  const record = findAccountModelSetting(settings, target);
  if (record) return record.enabled !== false;
  return isModelEnabled(settings, target.id, target.provider);
}

function upsertAccountModelSetting(settings, input) {
  const current = normalizeModelCatalogSettings(settings);
  const existing = findAccountModelSetting(current, input);
  const normalized = normalizeAccountModelSettingRecord(input);
  if (!normalized) {
    const error = new Error('invalid_account_model');
    error.code = 'invalid_account_model';
    throw error;
  }
  // customPricing 合并语义只看原始 input：normalize 会把「无值 / 非法值」规范成
  // 「键不存在」，无法区分「未提交」与「显式清空」。
  // - 未提交（键缺席）：继承 existing.customPricing（新建则无）。
  // - 显式提交 null / 非法值：normalize 后视为无值，即清空。
  const nextCustomPricing = input && typeof input === 'object'
    && Object.prototype.hasOwnProperty.call(input, 'customPricing')
    ? normalized.customPricing
    : (existing ? existing.customPricing : undefined);
  const normalizedModelKey = getModelKey(normalized.id);
  const nextDefaultModel = normalized.enabled !== false && normalized.defaultModel === true;
  const nextAccountModels = current.accountModels
    .filter((item) => !(
      getModelKey(item.id) === normalizedModelKey && accountRecordMatches(item, normalized)
    ))
    .map((item) => (
      nextDefaultModel && accountRecordMatches(item, normalized)
        ? { ...item, defaultModel: false }
        : item
    ));
  nextAccountModels.push({
    ...normalized,
    ...(nextCustomPricing ? { customPricing: nextCustomPricing } : {}),
    defaultModel: nextDefaultModel,
    createdAt: existing ? existing.createdAt : normalized.createdAt,
    updatedAt: Date.now()
  });
  return normalizeModelCatalogSettings({
    ...current,
    accountModels: nextAccountModels,
    updatedAt: Date.now()
  });
}

function upsertLegacyModelSetting(settings, input, fallback = {}) {
  const current = normalizeModelCatalogSettings(settings);
  const existing = findLegacyModelSetting(current, input && (input.id || input.model || input.modelId), input && input.provider);
  const normalized = normalizeLegacyModelSettingRecord(input, existing || fallback);
  if (!normalized) {
    const error = new Error('invalid_model_id');
    error.code = 'invalid_model_id';
    throw error;
  }
  const key = getLegacyModelSettingKey(normalized);
  const nextLegacyModels = current.legacyModels.filter((item) => getLegacyModelSettingKey(item) !== key);
  nextLegacyModels.push({
    ...normalized,
    createdAt: existing ? existing.createdAt : normalized.createdAt,
    updatedAt: Date.now()
  });
  return normalizeModelCatalogSettings({
    ...current,
    legacyModels: nextLegacyModels,
    updatedAt: Date.now()
  });
}

function upsertModelSetting(settings, input, fallback = {}) {
  if (normalizeAccountModelSettingRecord(input)) {
    return upsertAccountModelSetting(settings, input);
  }
  if (hasUnsupportedAccountScopeMarker(input)) {
    return upsertAccountModelSetting(settings, input);
  }
  return upsertLegacyModelSetting(settings, input, fallback);
}

function removeAccountModelSetting(settings, input) {
  const current = normalizeModelCatalogSettings(settings);
  const normalized = normalizeAccountModelSettingRecord(input);
  if (!normalized) return current;
  const normalizedModelKey = getModelKey(normalized.id);
  return normalizeModelCatalogSettings({
    ...current,
    accountModels: current.accountModels.filter((item) => !(
      getModelKey(item.id) === normalizedModelKey && accountRecordMatches(item, normalized)
    )),
    updatedAt: Date.now()
  });
}

function removeModelSetting(settings, input) {
  const current = normalizeModelCatalogSettings(settings);
  const normalizedAccount = normalizeAccountModelSettingRecord(input);
  if (normalizedAccount) return removeAccountModelSetting(current, normalizedAccount);
  if (hasUnsupportedAccountScopeMarker(input)) return current;
  const modelId = typeof input === 'string' ? input : input && (input.id || input.model || input.modelId);
  const key = getModelKey(modelId);
  return normalizeModelCatalogSettings({
    ...current,
    legacyModels: current.legacyModels.filter((item) => getModelKey(item.id) !== key),
    accountModels: current.accountModels.filter((item) => getModelKey(item.id) !== key),
    updatedAt: Date.now()
  });
}

function providerMatchesMode(provider, providerMode) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return true;
  return listEnabledProviders(providerMode || 'auto').includes(normalizedProvider);
}

function listManualModelSettings(settings, options = {}) {
  const current = normalizeModelCatalogSettings(settings);
  const enabledOnly = options.enabledOnly !== false;
  const accountModels = current.accountModels
    .filter((record) => record.manual === true)
    .filter((record) => !enabledOnly || record.enabled !== false)
    .filter((record) => providerMatchesMode(record.provider, options.providerMode));
  const legacyModels = current.legacyModels
    .filter((record) => record.manual === true)
    .filter((record) => !enabledOnly || record.enabled !== false)
    .filter((record) => providerMatchesMode(record.provider, options.providerMode));
  return [...accountModels, ...legacyModels];
}

function normalizeGatewayEntry(entry) {
  if (typeof entry === 'string') {
    const id = normalizeModelId(entry);
    return id ? { id, provider: '', accountRef: '', source: '' } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const id = normalizeModelId(entry.id || entry.model || entry.modelId);
  if (!id) return null;
  return {
    id,
    provider: normalizeProvider(entry.provider),
    accountRef: normalizeAccountRef(entry.accountRef),
    origin: String(entry.origin || '').trim(),
    source: String(entry.source || '').trim(),
    manual: entry.manual === true,
    description: String(entry.description || '').trim()
  };
}

function applyModelCatalogSettingsToEntries(entries, settings, options = {}) {
  const merged = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const normalized = normalizeGatewayEntry(entry);
    if (!normalized) return;
    if (normalized.accountRef) {
      if (!isAccountModelEnabled(settings, normalized)) return;
    } else if (!isModelEnabled(settings, normalized.id, normalized.provider)) {
      return;
    }
    if (!providerMatchesMode(normalized.provider, options.providerMode)) return;
    if (!merged.has(normalized.id)) merged.set(normalized.id, normalized);
  });
  listManualModelSettings(settings, {
    providerMode: options.providerMode,
    enabledOnly: true
  }).forEach((record) => {
    if (merged.has(record.id)) return;
    merged.set(record.id, {
      id: record.id,
      provider: record.provider,
      accountRef: record.accountRef || '',
      source: 'manual',
      manual: true,
      description: record.description || ''
    });
  });
  return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = {
  MODEL_CATALOG_SETTINGS_DB_KEY,
  applyModelCatalogSettingsToEntries,
  findAccountModelSetting,
  findDefaultAccountModelSetting,
  findModelSetting,
  isAccountModelEnabled,
  isModelEnabled,
  listManualModelSettings,
  loadModelCatalogSettings,
  normalizeAccountModelSettingRecord,
  normalizeGatewayEntry,
  normalizeModelCatalogSettings,
  normalizeModelSettingRecord: normalizeAccountModelSettingRecord,
  readModelCatalogSettings,
  removeAccountModelSetting,
  removeModelSetting,
  saveModelCatalogSettings,
  upsertAccountModelSetting,
  upsertModelSetting
};
