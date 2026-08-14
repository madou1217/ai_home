'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

function createProviderMetricBuckets() {
  return SUPPORTED_SERVER_PROVIDERS.reduce((acc, provider) => {
    acc[provider] = 0;
    return acc;
  }, {});
}

function initProxyMetrics() {
  return {
    startedAt: Date.now(),
    totalRequests: 0,
    totalSuccess: 0,
    totalFailures: 0,
    totalTimeouts: 0,
    routeCounts: {},
    providerCounts: createProviderMetricBuckets(),
    providerSuccess: createProviderMetricBuckets(),
    providerFailures: createProviderMetricBuckets(),
    lastErrors: []
  };
}

function normalizeMetricErrorInput(message) {
  if (!message || typeof message !== 'object') {
    const text = String(message || '').slice(0, 500);
    return {
      message: text,
      error: text
    };
  }
  const detail = String(message.message || message.error || message.detail || message.reason || '').slice(0, 500);
  const out = {
    ...message,
    message: detail,
    error: String(message.error || detail).slice(0, 500),
    detail: message.detail ? String(message.detail).slice(0, 500) : message.detail,
    reason: message.reason ? String(message.reason).slice(0, 500) : message.reason
  };

  const meta = (message.requestMeta && typeof message.requestMeta === 'object') ? message.requestMeta : null;
  if (meta) {
    if (meta.sessionId && !out.sessionId) out.sessionId = String(meta.sessionId).slice(0, 256);
    if (meta.sessionKey && !out.sessionKey) out.sessionKey = String(meta.sessionKey).slice(0, 256);
    if (meta.projectPath && !out.projectPath) out.projectPath = String(meta.projectPath).slice(0, 1024);
    if (meta.projectDirName && !out.projectDirName) out.projectDirName = String(meta.projectDirName).slice(0, 256);
    if (meta.model && !out.model) out.model = String(meta.model).slice(0, 256);
    if (meta.clientProtocol && !out.clientProtocol) out.clientProtocol = String(meta.clientProtocol).slice(0, 256);
    if (meta.familyProvider && !out.familyProvider) out.familyProvider = String(meta.familyProvider).slice(0, 256);
    if (meta.effectiveProvider && !out.effectiveProvider) out.effectiveProvider = String(meta.effectiveProvider).slice(0, 256);
  }

  const alias = ((message.aliasResolution && typeof message.aliasResolution === 'object')
    ? message.aliasResolution
    : (meta && meta.aliasResolution && typeof meta.aliasResolution === 'object' ? meta.aliasResolution : null));
  if (alias) {
    if (alias.requestedModel && !out.requestedModel) out.requestedModel = String(alias.requestedModel).slice(0, 256);
    if (alias.effectiveModel && !out.effectiveModel) out.effectiveModel = String(alias.effectiveModel).slice(0, 256);
    if (alias.aliasTarget && !out.aliasTarget) out.aliasTarget = String(alias.aliasTarget).slice(0, 256);
    if (alias.aliasMatched !== undefined && out.aliasMatched === undefined) out.aliasMatched = Boolean(alias.aliasMatched);
  }

  if (message.sessionId) out.sessionId = String(message.sessionId).slice(0, 256);
  if (message.sessionKey) out.sessionKey = String(message.sessionKey).slice(0, 256);
  if (message.projectPath) out.projectPath = String(message.projectPath).slice(0, 1024);
  if (message.projectDirName) out.projectDirName = String(message.projectDirName).slice(0, 256);
  if (message.model) out.model = String(message.model).slice(0, 256);
  if (message.requestedModel) out.requestedModel = String(message.requestedModel).slice(0, 256);
  if (message.effectiveModel) out.effectiveModel = String(message.effectiveModel).slice(0, 256);
  if (message.clientProtocol) out.clientProtocol = String(message.clientProtocol).slice(0, 256);
  if (message.familyProvider) out.familyProvider = String(message.familyProvider).slice(0, 256);
  if (message.effectiveProvider) out.effectiveProvider = String(message.effectiveProvider).slice(0, 256);
  if (message.aliasTarget) out.aliasTarget = String(message.aliasTarget).slice(0, 256);
  if (message.aliasMatched !== undefined) out.aliasMatched = Boolean(message.aliasMatched);
  if (message.accountLabel) out.accountLabel = String(message.accountLabel).slice(0, 256);
  delete out.requestMeta;
  delete out.aliasResolution;
  return out;
}

function pushMetricError(metrics, route, provider, message, context = {}) {
  const ctx = (context && typeof context === 'object') ? context : {};
  const merged = (message && typeof message === 'object') ? { ...ctx, ...message } : { ...ctx, message };
  const payload = normalizeMetricErrorInput(merged);
  const item = {
    at: new Date().toISOString(),
    route,
    provider,
    ...payload
  };
  metrics.lastErrors.push(item);
  if (metrics.lastErrors.length > 20) {
    metrics.lastErrors = metrics.lastErrors.slice(-20);
  }
}

function parseRetryAtFromMessageMs(message) {
  const text = String(message || '');
  const m = text.match(/try again at\s+([^\n.]+)/i);
  if (!m) return 0;
  const parsed = Date.parse(String(m[1] || '').trim());
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function isLocalQuotaOrAuthError(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  if (m.includes('hit your usage limit')) return true;
  if (m.includes('upgrade to plus')) return true;
  if (m.includes('invalid api key')) return true;
  if (m.includes('unauthorized')) return true;
  if (m.includes('please run codex login')) return true;
  if (m.includes('authentication')) return true;
  if (m.includes('forbidden')) return true;
  return false;
}

function getLocalFailureCooldownMs(message, defaultCooldownMs) {
  const base = Math.max(1000, Number(defaultCooldownMs) || 60000);
  if (!isLocalQuotaOrAuthError(message)) return base;
  const retryAt = parseRetryAtFromMessageMs(message);
  if (retryAt > Date.now()) {
    const waitMs = retryAt - Date.now() + 60 * 1000;
    return Math.min(Math.max(base, waitMs), 7 * 24 * 60 * 60 * 1000);
  }
  return Math.max(base, 24 * 60 * 60 * 1000);
}

function isRetriableLocalError(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  if (isLocalQuotaOrAuthError(m)) return false;
  if (m.includes('queue_full')) return false;
  if (m.includes('unsupported')) return false;
  if (m.includes('timeout')) return true;
  if (m.includes('failed')) return true;
  if (m.includes('exit_')) return true;
  return false;
}

function createProviderExecutor(name, maxConcurrency, queueLimit) {
  const concurrencyLimit = Math.max(1, Math.floor(Number(maxConcurrency) || 1));
  const maxQueueSize = Math.max(1, Math.floor(Number(queueLimit) || 1));
  const queue = [];
  let running = 0;
  let totalScheduled = 0;
  let totalRejected = 0;

  const runNext = () => {
    if (running >= concurrencyLimit) return;
    const job = queue.shift();
    if (!job) return;
    running += 1;
    Promise.resolve()
      .then(job.fn)
      .then((result) => job.resolve(result))
      .catch((error) => job.reject(error))
      .finally(() => {
        running -= 1;
        runNext();
      });
  };

  const schedule = (fn) => new Promise((resolve, reject) => {
    if (queue.length >= maxQueueSize) {
      totalRejected += 1;
      reject(new Error(`${name}_queue_full`));
      return;
    }
    totalScheduled += 1;
    queue.push({ fn, resolve, reject });
    runNext();
  });

  const snapshot = () => ({
    name,
    running,
    queued: queue.length,
    maxConcurrency: concurrencyLimit,
    queueLimit: maxQueueSize,
    totalScheduled,
    totalRejected
  });

  return { schedule, snapshot };
}

module.exports = {
  initProxyMetrics,
  pushMetricError,
  normalizeMetricErrorInput,
  isLocalQuotaOrAuthError,
  getLocalFailureCooldownMs,
  isRetriableLocalError,
  createProviderExecutor
};
