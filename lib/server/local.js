'use strict';

function initProxyMetrics() {
  return {
    startedAt: Date.now(),
    totalRequests: 0,
    totalSuccess: 0,
    totalFailures: 0,
    totalTimeouts: 0,
    routeCounts: {},
    providerCounts: { codex: 0, gemini: 0, claude: 0 },
    providerSuccess: { codex: 0, gemini: 0, claude: 0 },
    providerFailures: { codex: 0, gemini: 0, claude: 0 },
    lastErrors: []
  };
}

function pushMetricError(metrics, route, provider, message) {
  const item = {
    at: new Date().toISOString(),
    route,
    provider,
    error: String(message || '').slice(0, 500)
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
  const queue = [];
  let running = 0;
  let totalScheduled = 0;
  let totalRejected = 0;

  const runNext = () => {
    if (running >= maxConcurrency) return;
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
    if (queue.length >= queueLimit) {
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
    maxConcurrency,
    queueLimit,
    totalScheduled,
    totalRejected
  });

  return { schedule, snapshot };
}

module.exports = {
  initProxyMetrics,
  pushMetricError,
  isLocalQuotaOrAuthError,
  getLocalFailureCooldownMs,
  isRetriableLocalError,
  createProviderExecutor
};
