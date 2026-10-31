'use strict';

const { attachModelMetadata } = require('../server/models-dev-metadata');

const DEFAULT_CATALOG_TIMEOUT_MS = 15000;

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeModalities(value) {
  if (!value || typeof value !== 'object') return null;
  const input = Array.isArray(value.input)
    ? value.input.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const output = Array.isArray(value.output)
    ? value.output.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return { input, output };
}

async function fetchGatewayModelCatalog(input = {}) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = String(input.apiKey || '').trim();
  if (!baseUrl) throw new Error('gateway_base_url_missing');
  if (!apiKey) throw new Error('gateway_api_key_missing');
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_CATALOG_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    // 钉选账号启动的 harness 要的是这个账号能用的模型（/v1/models 按 x-account-ref 收窄），
    // 而不是全局池——否则 harness 里会出现选了也路由不到该账号的模型。
    const accountRef = String(input.accountRef || '').trim();
    const response = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        ...(/^acct_[a-f0-9]{20}$/.test(accountRef) ? { 'x-account-ref': accountRef } : {})
      },
      signal: controller ? controller.signal : undefined
    });
    if (!response || !response.ok) {
      throw new Error(`gateway_models_http_${response && response.status ? response.status : 'unknown'}`);
    }
    const payload = await response.json();
    const rows = Array.isArray(payload && payload.data) ? payload.data : [];
    const byId = new Map();
    for (const row of rows) {
      const id = String(row && row.id || '').trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        modalities: normalizeModalities(row.aih_modalities || row.modalities),
        // 档位原样透传（网关发布的 aih_reasoning_efforts）：下游 buildHarnessModelEntry
        // 据此写 pi 的 thinkingLevelMap。丢掉它 = harness 退回自己的默认上限（只到 high）。
        ...(Array.isArray(row.aih_reasoning_efforts) && row.aih_reasoning_efforts.length > 0
          ? { reasoningEfforts: row.aih_reasoning_efforts }
          : {})
      });
    }
    return {
      baseUrl,
      fetchedAt: Date.now(),
      models: Array.from(byId.values())
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withModelMetadata(catalog, provider) {
  const models = Array.isArray(catalog && catalog.models) ? catalog.models : [];
  const providerId = String(provider || '').trim().toLowerCase();
  const enriched = attachModelMetadata(models.map((entry) => ({
    id: entry.id,
    provider: providerId,
    aih_modalities: entry.modalities || undefined
  })));
  const effortsById = new Map(models
    .filter((entry) => Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length > 0)
    .map((entry) => [entry.id, entry.reasoningEfforts]));
  return {
    ...(catalog || {}),
    models: enriched.map((entry, index) => ({
      id: entry.id,
      modalities: entry.aih_modalities || models[index]?.modalities || null,
      metadata: entry.metadata,
      ...(effortsById.has(entry.id) ? { reasoningEfforts: effortsById.get(entry.id) } : {})
    }))
  };
}

function ensureRequestedModel(catalog, modelId, provider) {
  const id = String(modelId || '').trim();
  if (!id) return catalog;
  const models = Array.isArray(catalog && catalog.models) ? catalog.models : [];
  if (models.some((entry) => entry.id === id)) return catalog;
  // 模型目录可能因为账号刷新滞后而暂时没有这个 id；用户已显式选择时保留一项，
  // 由网关在真正请求时给出权威结论，而不是在启动器里静默丢弃。
  const enriched = attachModelMetadata([{ id, provider: String(provider || '').trim().toLowerCase() }]);
  return {
    ...(catalog || {}),
    models: [
      ...models,
      {
        id,
        modalities: null,
        metadata: enriched[0].metadata
      }
    ]
  };
}

module.exports = {
  DEFAULT_CATALOG_TIMEOUT_MS,
  ensureRequestedModel,
  fetchGatewayModelCatalog,
  normalizeModalities,
  withModelMetadata
};
