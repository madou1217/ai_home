'use strict';

const { readCacheJson, writeCacheJson } = require('./webui-cache-store');

// The in-memory model cache is intentionally fast, but a server restart should
// not make every client wait for every upstream /models request again.  This
// snapshot contains only the public model response and cache metadata; it does
// not contain credentials or account secrets.
const GATEWAY_MODEL_CACHE_FILE = 'gateway-models-snapshot.json';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function normalizeBody(value) {
  const body = typeof value === 'string' ? value : '';
  if (!body || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return '';
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) return '';
    return JSON.stringify(parsed);
  } catch (_error) {
    return '';
  }
}

// 模型 → 账号归属表：只保留「模型键 → 非空 accountRef 数组」，
// 用于重启后沿用上次快照时仍能按当前账号池收窄（见 model-catalog-visibility）。
function normalizeModelAccounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  let count = 0;
  Object.entries(value).forEach(([key, refs]) => {
    const modelKey = String(key || '').trim();
    if (!modelKey || !Array.isArray(refs)) return;
    const filtered = refs.map((ref) => String(ref || '').trim()).filter(Boolean);
    if (filtered.length === 0) return;
    out[modelKey] = filtered;
    count += 1;
  });
  return count > 0 ? out : null;
}

// 模型 → provider 绑定：provider 级目录的「归属到哪个 provider」，读取时按该 provider
// 当前是否还有启用账号收窄（见 model-catalog-visibility#isModelServableByVisibleAccount）。
function normalizeModelProviders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  let count = 0;
  Object.entries(value).forEach(([key, provider]) => {
    const modelKey = String(key || '').trim();
    const name = String(provider || '').trim().toLowerCase();
    if (!modelKey || !name) return;
    out[modelKey] = name;
    count += 1;
  });
  return count > 0 ? out : null;
}

function normalizeGatewayModelCache(value) {
  const source = value && typeof value === 'object' ? value : {};
  const body = normalizeBody(source.body);
  return {
    updatedAt: Number(source.updatedAt) > 0 ? Number(source.updatedAt) : 0,
    pluginGeneration: Number(source.pluginGeneration) >= 0 ? Number(source.pluginGeneration) : 0,
    signature: String(source.signature || '').trim(),
    body,
    modelAccounts: normalizeModelAccounts(source.modelAccounts),
    modelProviders: normalizeModelProviders(source.modelProviders),
    projection: source.projection && typeof source.projection === 'object'
      ? source.projection
      : null
  };
}

function readPersistedGatewayModelCache(deps = {}) {
  const reader = typeof deps.cacheReadJson === 'function' ? deps.cacheReadJson : readCacheJson;
  return normalizeGatewayModelCache(reader(deps, GATEWAY_MODEL_CACHE_FILE));
}

function writePersistedGatewayModelCache(deps = {}, value) {
  const normalized = normalizeGatewayModelCache(value);
  if (!normalized.body) return normalized;
  const writer = typeof deps.cacheWriteJson === 'function' ? deps.cacheWriteJson : writeCacheJson;
  writer(deps, GATEWAY_MODEL_CACHE_FILE, normalized);
  return normalized;
}

module.exports = {
  GATEWAY_MODEL_CACHE_FILE,
  normalizeGatewayModelCache,
  readPersistedGatewayModelCache,
  writePersistedGatewayModelCache
};
