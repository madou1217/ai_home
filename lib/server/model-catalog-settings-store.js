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
// v4 makes accountRef the only account-scoped model identity.
const SETTINGS_VERSION = 4;

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

  return {
    id,
    provider: normalizeProvider(source.provider),
    accountRef,
    enabled: source.enabled !== false,
    manual: source.manual === true,
    description: String(source.description || '').trim(),
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

async function loadModelCatalogSettings(fs, aiHomeDir, options = {}) {
  if (!fs || !aiHomeDir) return normalizeModelCatalogSettings(null);
  return normalizeModelCatalogSettings(readJsonValue(fs, aiHomeDir, MODEL_CATALOG_SETTINGS_DB_KEY, options));
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
  const normalizedModelKey = getModelKey(normalized.id);
  const nextAccountModels = current.accountModels.filter((item) => !(
    getModelKey(item.id) === normalizedModelKey && accountRecordMatches(item, normalized)
  ));
  nextAccountModels.push({
    ...normalized,
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
  findModelSetting,
  isAccountModelEnabled,
  isModelEnabled,
  listManualModelSettings,
  loadModelCatalogSettings,
  normalizeAccountModelSettingRecord,
  normalizeGatewayEntry,
  normalizeModelCatalogSettings,
  normalizeModelSettingRecord: normalizeAccountModelSettingRecord,
  removeAccountModelSetting,
  removeModelSetting,
  saveModelCatalogSettings,
  upsertAccountModelSetting,
  upsertModelSetting
};
