'use strict';

function normalizeModelId(modelRaw) {
  return String(modelRaw || '').trim().toLowerCase();
}

function isInternalModelEnumId(modelRaw) {
  return /^MODEL_[A-Z0-9_]+$/.test(String(modelRaw || '').trim().replace(/_vertex$/i, ''));
}

function isNonModelResourceId(modelRaw) {
  const id = String(modelRaw || '').trim();
  const normalized = id.toLowerCase();
  return /^chat_[a-z0-9]+$/i.test(id)
    || /^tab_[a-z0-9_]+$/i.test(id) // 编辑器 tab 补全内部资源,不是可请求模型
    || normalized.startsWith('models/')
    || normalized.includes('proactive-observer')
    || normalized.includes('placeholder');
}

function isRealProviderModelId(modelRaw) {
  const id = String(modelRaw || '').trim();
  return Boolean(id)
    && !id.includes('*')
    && !isInternalModelEnumId(id)
    && !isNonModelResourceId(id);
}

function isPublicCatalogModelId(modelRaw) {
  return isRealProviderModelId(modelRaw);
}

function normalizeModelVersionSeparators(modelRaw) {
  return String(modelRaw || '').trim().replace(/(\d)\.(?=\d)/g, '$1-');
}

function listModelIdLookupKeys(modelRaw) {
  const exact = normalizeModelId(modelRaw);
  if (!exact) return [];
  const versionNormalized = normalizeModelId(normalizeModelVersionSeparators(exact));
  return Array.from(new Set([exact, versionNormalized].filter(Boolean)));
}

function modelIdsMatch(left, right) {
  const leftKeys = new Set(listModelIdLookupKeys(left));
  if (leftKeys.size < 1) return false;
  return listModelIdLookupKeys(right).some((key) => leftKeys.has(key));
}

module.exports = {
  isInternalModelEnumId,
  isNonModelResourceId,
  isPublicCatalogModelId,
  isRealProviderModelId,
  listModelIdLookupKeys,
  modelIdsMatch,
  normalizeModelVersionSeparators,
  normalizeModelId
};
