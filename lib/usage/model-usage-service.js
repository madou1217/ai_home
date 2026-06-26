'use strict';

const { openModelUsageStore } = require('./model-usage-store');
const { scanModelUsageSources } = require('./model-usage-scanner');
const { buildApiUsageRecord } = require('./model-usage-api-record');
const { parseLiteLlmPricing } = require('./model-usage-pricing');
const {
  DEFAULT_MODELS_DEV_DIR,
  buildModelsDevPricingRecords
} = require('../server/models-dev-metadata');

const DEFAULT_PROVIDERS = Object.freeze(['codex', 'claude', 'gemini', 'agy', 'opencode']);
const DEFAULT_PRICING_SOURCE = 'models.dev';
const DEFAULT_PRICING_STALE_MS = 24 * 60 * 60 * 1000;

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return DEFAULT_PROVIDERS.includes(provider) ? provider : '';
}

function normalizeProviders(values) {
  const arr = Array.isArray(values) ? values : [];
  return Array.from(new Set(arr.map(normalizeProvider).filter(Boolean)));
}

function normalizeQueryOptions(options = {}) {
  return {
    fromMs: Number(options.fromMs) || 0,
    toMs: Number(options.toMs) || Date.now(),
    provider: normalizeProvider(options.provider || options.source),
    model: String(options.model || '').trim(),
    sessionId: String(options.sessionId || options.session_id || '').trim(),
    limit: Number(options.limit) || 50
  };
}

function createModelUsageService(options = {}) {
  const fs = options.fs || require('node:fs');
  const path = options.path || require('node:path');
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const aiHomeDir = String(options.aiHomeDir || (hostHomeDir ? path.join(hostHomeDir, '.ai_home') : '')).trim();
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const pricingUrl = String(options.pricingUrl || '').trim();
  const modelsDevDir = String(options.modelsDevDir || DEFAULT_MODELS_DEV_DIR).trim();
  const pricingSource = pricingUrl ? `url:${pricingUrl}` : DEFAULT_PRICING_SOURCE;
  const pricingStaleMs = Math.max(60_000, Number(options.pricingStaleMs) || DEFAULT_PRICING_STALE_MS);

  function withStore(work) {
    const storeOptions = {
      fs,
      path,
      aiHomeDir,
      dbPath: options.dbPath
    };
    if (options.DatabaseSync !== undefined) {
      storeOptions.DatabaseSync = options.DatabaseSync;
    }
    const store = openModelUsageStore(storeOptions);
    if (!store) {
      const error = new Error('model_usage_db_unavailable');
      error.code = 'model_usage_db_unavailable';
      throw error;
    }
    try {
      return work(store);
    } finally {
      store.close();
    }
  }

  function scan(scanOptions = {}) {
    const providers = normalizeProviders(scanOptions.providers || (scanOptions.provider ? [scanOptions.provider] : []));
    return withStore((store) => scanModelUsageSources({
      fs,
      path,
      store,
      hostHomeDir,
      providers
    }));
  }

  async function syncPricingIfStale(syncOptions = {}) {
    if (pricingUrl && typeof fetchImpl !== 'function') {
      return { ok: false, synced: false, reason: 'fetch_unavailable' };
    }
    let timer = null;
    try {
      const force = syncOptions.force === true;
      const lastUpdatedAt = withStore((store) => store.getPricingLastUpdatedAt(pricingSource));
      if (!force && lastUpdatedAt > 0 && Date.now() - lastUpdatedAt < pricingStaleMs) {
        return { ok: true, synced: false, reason: 'fresh', source: pricingSource, updatedAt: lastUpdatedAt };
      }

      let records = [];
      if (pricingUrl) {
        const timeoutMs = Math.max(1000, Math.min(30000, Number(syncOptions.timeoutMs) || 8000));
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const response = await fetchImpl(pricingUrl, {
          headers: { 'user-agent': 'aih-model-usage/1.0' },
          ...(controller ? { signal: controller.signal } : {})
        });
        if (!response || !response.ok) {
          return { ok: false, synced: false, source: pricingSource, reason: `http_${response ? response.status : 'unknown'}` };
        }
        const payload = await response.json();
        const pricing = parseLiteLlmPricing(payload);
        records = Object.values(pricing);
      } else {
        records = buildModelsDevPricingRecords({ fs, modelsDevDir });
      }
      if (records.length === 0) {
        return { ok: false, synced: false, source: pricingSource, reason: 'empty_pricing' };
      }
      return withStore((store) => {
        const upserted = store.upsertPricing(records, { source: pricingSource });
        const recalculated = store.recalculateCosts({ all: true });
        return { ok: true, synced: true, source: pricingSource, upserted, recalculated };
      });
    } catch (error) {
      return {
        ok: false,
        synced: false,
        reason: String((error && error.name) || (error && error.message) || error || 'pricing_sync_failed')
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function recordUsage(record = {}) {
    return withStore((store) => store.insertUsage(record));
  }

  function recordUsageBatch(records = []) {
    return withStore((store) => store.insertUsageBatch(records));
  }

  function recordApiUsage(input = {}) {
    const record = buildApiUsageRecord(input);
    if (!record) return 0;
    return recordUsage(record);
  }

  function getStats(query = {}) {
    return withStore((store) => store.queryStats(normalizeQueryOptions(query)));
  }

  function getCostByModel(query = {}) {
    return withStore((store) => store.queryCostByModel(normalizeQueryOptions(query)));
  }

  function getSessions(query = {}) {
    return withStore((store) => store.querySessions(normalizeQueryOptions(query)));
  }

  function getSessionDetail(query = {}) {
    return withStore((store) => store.querySessionDetail(normalizeQueryOptions(query)));
  }

  function query(command, queryOptions = {}) {
    const cmd = String(command || 'stats').trim().toLowerCase();
    const options = normalizeQueryOptions(queryOptions);
    if (queryOptions.scan !== false) {
      scan({ provider: options.provider });
    }
    if (cmd === 'stats' || cmd === 'summary') {
      return { command: 'stats', stats: getStats(options) };
    }
    if (cmd === 'models' || cmd === 'cost-by-model' || cmd === 'by-model') {
      return { command: 'models', models: getCostByModel(options) };
    }
    if (cmd === 'sessions') {
      return { command: 'sessions', sessions: getSessions(options) };
    }
    if (cmd === 'session' || cmd === 'session-detail') {
      return { command: 'session-detail', session: getSessionDetail(options) };
    }
    const error = new Error(`unknown_model_usage_command:${cmd}`);
    error.code = 'unknown_model_usage_command';
    throw error;
  }

  return {
    scan,
    syncPricingIfStale,
    recordUsage,
    recordUsageBatch,
    recordApiUsage,
    getStats,
    getCostByModel,
    getSessions,
    getSessionDetail,
    query
  };
}

module.exports = {
  DEFAULT_PROVIDERS,
  createModelUsageService,
  normalizeProvider,
  normalizeProviders,
  normalizeQueryOptions
};
