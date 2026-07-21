'use strict';

const {
  PRICING_CATALOG_STALE_EPOCH,
  openModelUsageStore
} = require('./model-usage-store');
const { scanModelUsageSources } = require('./model-usage-scanner');
const { buildApiUsageRecord } = require('./model-usage-api-record');
const {
  PRICING_CATALOG_FORMAT_VERSION,
  fingerprintPricingCatalog,
  parseLiteLlmPricing
} = require('./model-usage-pricing');
const {
  DEFAULT_MODELS_DEV_DIR,
  buildModelsDevPricingRecords
} = require('../server/models-dev-metadata');
const { createModelUsageQueryExecutor } = require('./model-usage-query-executor');

const DEFAULT_PROVIDERS = Object.freeze(['codex', 'claude', 'gemini', 'agy', 'opencode']);
const DEFAULT_PRICING_SOURCE = 'models.dev';
const DEFAULT_PRICING_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRICING_MAINTENANCE_BATCH_SIZE = 1_000;

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
  const yieldToEventLoop = typeof options.yieldToEventLoop === 'function'
    ? options.yieldToEventLoop
    : () => new Promise((resolve) => setImmediate(resolve));
  const hasInjectedQueryExecutor = Object.prototype.hasOwnProperty.call(options, 'queryExecutor');
  const ownsQueryExecutor = !hasInjectedQueryExecutor && options.enableAsyncQueries !== false;
  const queryExecutor = hasInjectedQueryExecutor
    ? options.queryExecutor
    : (ownsQueryExecutor ? createModelUsageQueryExecutor({
      ...(options.queryWorkerOptions || {}),
      serviceOptions: {
        aiHomeDir,
        hostHomeDir,
        modelsDevDir
      }
    }) : null);
  let bundledPricingSnapshot = null;

  function loadBundledPricingSnapshot(forceReload = false) {
    if (!bundledPricingSnapshot || forceReload) {
      const records = buildModelsDevPricingRecords({ fs, modelsDevDir });
      bundledPricingSnapshot = {
        records,
        fingerprint: fingerprintPricingCatalog(records)
      };
    }
    return bundledPricingSnapshot;
  }

  function openStore() {
    const storeOptions = {
      fs,
      path,
      aiHomeDir
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
    return store;
  }

  function withStore(work) {
    const store = openStore();
    try {
      return work(store);
    } finally {
      store.close();
    }
  }

  function isActivePricingCatalog(catalog) {
    return Boolean(
      catalog
      && String(catalog.source || '').trim()
      && String(catalog.sourceFamily || '').trim()
      && String(catalog.formatVersion || '').trim() === PRICING_CATALOG_FORMAT_VERSION
      && String(catalog.fingerprint || '').trim()
      && Number(catalog.epoch) > 0
      && Number(catalog.updatedAt) > 0
    );
  }

  function hasStructuredPricingCatalog(catalog) {
    return Boolean(
      catalog
      && typeof catalog === 'object'
      && String(catalog.source || '').trim()
    );
  }

  function isMaintenanceComplete(state, catalog) {
    return Boolean(
      state
      && state.status === 'completed'
      && String(state.source || '').trim() === String(catalog && catalog.source || '').trim()
      && Number(state.catalogEpoch) === Number(catalog && catalog.epoch)
    );
  }

  async function runPricingMaintenance(store, activeCatalog, syncOptions = {}) {
    const batchSize = Math.max(1, Number(syncOptions.batchSize) || DEFAULT_PRICING_MAINTENANCE_BATCH_SIZE);
    const onProgress = typeof syncOptions.onProgress === 'function' ? syncOptions.onProgress : null;

    while (true) {
      const batch = store.recalculatePricingMaintenanceBatch({
        expectedSource: activeCatalog.source,
        expectedEpoch: activeCatalog.epoch,
        batchSize
      });
      if (batch.stale) return batch;
      const state = batch.state;
      if (onProgress) await onProgress({ ...state });
      const currentActive = store.getActivePricingCatalog();
      if (
        String(currentActive && currentActive.source || '').trim() !== activeCatalog.source
        || Number(currentActive && currentActive.epoch) !== Number(activeCatalog.epoch)
      ) {
        return {
          stale: true,
          reason: PRICING_CATALOG_STALE_EPOCH,
          activeCatalog: currentActive,
          maintenance: store.getPricingMaintenanceState()
        };
      }
      if (state.status === 'completed') return { stale: false, state };
      await yieldToEventLoop();
    }
  }

  function scan(scanOptions = {}) {
    const providers = normalizeProviders(scanOptions.providers || (scanOptions.provider ? [scanOptions.provider] : []));
    return withStore((store) => scanModelUsageSources({
      fs,
      path,
      store,
      hostHomeDir,
      providers,
      reindexCodexForkHistory: scanOptions.reindexCodexForkHistory === true
    }));
  }

  async function syncPricingIfStale(syncOptions = {}) {
    let timer = null;
    let store = null;
    try {
      const force = syncOptions.force === true;
      const recalculateCosts = syncOptions.recalculateCosts === true;
      store = openStore();
      let activeCatalog = store.getActivePricingCatalog();
      let maintenance = store.getPricingMaintenanceState();
      const hasStoredActiveCatalog = hasStructuredPricingCatalog(activeCatalog);
      const hasActiveCatalog = isActivePricingCatalog(activeCatalog);
      if (hasStoredActiveCatalog && !hasActiveCatalog && !force && !recalculateCosts) {
        return {
          ok: false,
          synced: false,
          source: String(activeCatalog.sourceFamily || '').trim(),
          reason: 'pricing_catalog_incompatible',
          activeFormatVersion: String(activeCatalog.formatVersion || '').trim()
        };
      }
      let candidateRecords = null;
      let candidateFingerprint = '';

      if (pricingUrl) {
        const activeMatchesSource = hasActiveCatalog
          && String(activeCatalog.sourceFamily || '').trim() === pricingSource;
        const activeIsStale = activeMatchesSource
          && Date.now() - Number(activeCatalog.updatedAt) >= pricingStaleMs;
        const shouldFetch = !hasActiveCatalog
          || force
          || (recalculateCosts && (!activeMatchesSource || activeIsStale));
        if (shouldFetch) {
          if (typeof fetchImpl !== 'function') {
            return { ok: false, synced: false, reason: 'fetch_unavailable' };
          }
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
          candidateRecords = Object.values(pricing);
          candidateFingerprint = fingerprintPricingCatalog(candidateRecords);
        }
      } else if (!hasActiveCatalog || force || recalculateCosts) {
        const snapshot = loadBundledPricingSnapshot(force || recalculateCosts);
        candidateRecords = snapshot.records;
        candidateFingerprint = snapshot.fingerprint;
      }

      if (candidateRecords && (candidateRecords.length === 0 || !candidateFingerprint)) {
        return { ok: false, synced: false, source: pricingSource, reason: 'empty_pricing' };
      }

      let activation = null;
      if (candidateRecords) {
        const candidateSource = `${pricingSource}:${PRICING_CATALOG_FORMAT_VERSION}:${candidateFingerprint}`;
        activation = store.activatePricingCatalog(candidateRecords, {
          source: candidateSource,
          sourceFamily: pricingSource,
          formatVersion: PRICING_CATALOG_FORMAT_VERSION,
          fingerprint: candidateFingerprint,
          expectedActiveSource: String(activeCatalog && activeCatalog.source || '').trim(),
          expectedActiveEpoch: Number(activeCatalog && activeCatalog.epoch) || 0
        });
        activeCatalog = activation.activeCatalog;
        maintenance = activation.maintenance;
        if (activation.stale) {
          if (force || recalculateCosts) {
            return {
              ok: false,
              synced: false,
              source: String(activeCatalog && activeCatalog.sourceFamily || pricingSource).trim(),
              catalogFingerprint: String(activeCatalog && activeCatalog.fingerprint || '').trim(),
              reason: activation.reason || PRICING_CATALOG_STALE_EPOCH,
              maintenance
            };
          }
          activeCatalog = store.getActivePricingCatalog();
          maintenance = store.getPricingMaintenanceState();
        }
      }

      if (!isActivePricingCatalog(activeCatalog)) {
        return { ok: false, synced: false, source: pricingSource, reason: 'pricing_catalog_unavailable' };
      }
      if (
        !maintenance
        || String(maintenance.source || '').trim() !== String(activeCatalog.source || '').trim()
        || Number(maintenance.catalogEpoch) !== Number(activeCatalog.epoch)
      ) {
        return { ok: false, synced: false, source: activeCatalog.sourceFamily, reason: 'pricing_maintenance_state_invalid' };
      }

      const synced = Boolean(activation && activation.activated);
      const baseResult = {
        ok: true,
        synced,
        reason: synced ? undefined : 'fresh',
        source: activeCatalog.sourceFamily,
        catalogFingerprint: activeCatalog.fingerprint,
        updatedAt: activeCatalog.updatedAt,
        upserted: Number(activation && activation.upserted) || 0
      };
      if (!recalculateCosts) {
        return {
          ...baseResult,
          recalculated: 0,
          recalculationRequired: !isMaintenanceComplete(maintenance, activeCatalog),
          maintenance
        };
      }

      if (isMaintenanceComplete(maintenance, activeCatalog)) {
        return {
          ...baseResult,
          recalculated: 0,
          recalculationRequired: false,
          maintenance
        };
      }

      const maintenanceRun = await runPricingMaintenance(store, activeCatalog, syncOptions);
      if (maintenanceRun.stale) {
        return {
          ok: false,
          synced,
          source: activeCatalog.sourceFamily,
          catalogFingerprint: activeCatalog.fingerprint,
          reason: maintenanceRun.reason || PRICING_CATALOG_STALE_EPOCH,
          maintenance: maintenanceRun.maintenance || store.getPricingMaintenanceState()
        };
      }
      const state = maintenanceRun.state;
      return {
        ...baseResult,
        recalculated: state.recalculated,
        scanned: state.scanned,
        batches: state.batches,
        recalculationRequired: false,
        maintenance: state
      };
    } catch (error) {
      return {
        ok: false,
        synced: false,
        reason: String(
          (error && error.code)
          || (error && error.message)
          || (error && error.name)
          || error
          || 'pricing_sync_failed'
        )
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (store) store.close();
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

  function getDashboard(query = {}) {
    return withStore((store) => store.queryDashboard(normalizeQueryOptions(query)));
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

  function executeQueryAsync(method, query, fallback) {
    const normalized = normalizeQueryOptions(query);
    if (!queryExecutor || typeof queryExecutor.execute !== 'function') {
      return Promise.resolve().then(() => fallback(normalized));
    }
    return queryExecutor.execute(method, normalized);
  }

  function getStatsAsync(query = {}) {
    return executeQueryAsync('getStats', query, getStats);
  }

  function getDashboardAsync(query = {}) {
    return executeQueryAsync('getDashboard', query, getDashboard);
  }

  function getCostByModelAsync(query = {}) {
    return executeQueryAsync('getCostByModel', query, getCostByModel);
  }

  function getSessionsAsync(query = {}) {
    return executeQueryAsync('getSessions', query, getSessions);
  }

  function getSessionDetailAsync(query = {}) {
    return executeQueryAsync('getSessionDetail', query, getSessionDetail);
  }

  function close() {
    if (!ownsQueryExecutor || !queryExecutor || typeof queryExecutor.close !== 'function') {
      return Promise.resolve();
    }
    return queryExecutor.close();
  }

  // 某会话最近一次实际用的模型（服务端持久化的"上次使用"，跟随 server、能读历史真实用模）。
  function getLastSessionModel(provider, sessionId) {
    return withStore((store) => (
      typeof store.getLastSessionModel === 'function'
        ? store.getLastSessionModel(provider, sessionId)
        : ''
    )) || '';
  }

  function getNativeSessionModelTimeline(provider, sessionId) {
    return withStore((store) => (
      typeof store.getNativeSessionModelTimeline === 'function'
        ? store.getNativeSessionModelTimeline(provider, sessionId)
        : []
    )) || [];
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
    getDashboard,
    getDashboardAsync,
    getStats,
    getStatsAsync,
    getCostByModel,
    getCostByModelAsync,
    getSessions,
    getSessionsAsync,
    getSessionDetail,
    getSessionDetailAsync,
    getLastSessionModel,
    getNativeSessionModelTimeline,
    query,
    close
  };
}

module.exports = {
  DEFAULT_PROVIDERS,
  createModelUsageService,
  normalizeProvider,
  normalizeProviders,
  normalizeQueryOptions
};
