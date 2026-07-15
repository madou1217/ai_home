'use strict';

const {
  attachSseWatcher,
  broadcastSseJson,
  openSseStream,
  writeSseJson
} = require('./webui-sse-broadcaster');

const MAX_USAGE_SCAN_JOBS = 20;

function getUsageLiveState(state) {
  if (!state.usageLive || typeof state.usageLive !== 'object') {
    state.usageLive = {
      watchers: new Set(),
      jobs: new Map(),
      nextJobSeq: 0
    };
  }
  return state.usageLive;
}

function normalizeProviderFilter(provider) {
  return String(provider || '').trim().toLowerCase();
}

function serializeUsageScanJob(job) {
  return {
    id: String(job && job.id || ''),
    status: String(job && job.status || 'queued'),
    provider: String(job && job.provider || ''),
    startedAt: Number(job && job.startedAt) || 0,
    finishedAt: Number(job && job.finishedAt) || 0,
    result: job && job.result || null,
    error: String(job && job.error || '')
  };
}

function broadcastUsageScanJob(liveState, job) {
  const payload = {
    type: 'usage-scan-job',
    job: serializeUsageScanJob(job)
  };
  broadcastSseJson(liveState.watchers, payload);
  return payload;
}

function trimFinishedJobs(liveState) {
  const jobs = [...liveState.jobs.values()];
  if (jobs.length <= MAX_USAGE_SCAN_JOBS) return;
  jobs
    .filter((job) => job.status !== 'running' && job.status !== 'queued')
    .sort((a, b) => (Number(a.finishedAt) || Number(a.startedAt) || 0) - (Number(b.finishedAt) || Number(b.startedAt) || 0))
    .slice(0, Math.max(0, jobs.length - MAX_USAGE_SCAN_JOBS))
    .forEach((job) => liveState.jobs.delete(job.id));
}

async function runUsageScanJob(liveState, job, modelUsageService) {
  job.status = 'running';
  job.startedAt = Date.now();
  broadcastUsageScanJob(liveState, job);

  try {
    if (typeof modelUsageService.syncPricingIfStale === 'function') {
      await modelUsageService.syncPricingIfStale();
    }
    job.result = await Promise.resolve(modelUsageService.scan({ provider: job.provider }));
    job.status = 'succeeded';
  } catch (error) {
    job.status = 'failed';
    job.error = String((error && error.message) || error || 'usage_scan_failed');
  } finally {
    job.finishedAt = Date.now();
    broadcastUsageScanJob(liveState, job);
    trimFinishedJobs(liveState);
  }
}

function startUsageScanJob(state, modelUsageService, options = {}) {
  const liveState = getUsageLiveState(state);
  const running = [...liveState.jobs.values()].find((job) => (
    (job.status === 'queued' || job.status === 'running')
    && normalizeProviderFilter(job.provider) === normalizeProviderFilter(options.provider)
  ));
  if (running) {
    return {
      accepted: false,
      alreadyRunning: true,
      job: serializeUsageScanJob(running)
    };
  }

  liveState.nextJobSeq += 1;
  const job = {
    id: `usage-scan-${Date.now()}-${liveState.nextJobSeq}`,
    status: 'queued',
    provider: normalizeProviderFilter(options.provider),
    startedAt: 0,
    finishedAt: 0,
    result: null,
    error: ''
  };
  liveState.jobs.set(job.id, job);
  broadcastUsageScanJob(liveState, job);

  Promise.resolve()
    .then(() => runUsageScanJob(liveState, job, modelUsageService))
    .catch(() => {});

  return {
    accepted: true,
    alreadyRunning: false,
    job: serializeUsageScanJob(job)
  };
}

function handleUsageScanWatchRequest(ctx) {
  const { req, res, state } = ctx;
  const liveState = getUsageLiveState(state);
  openSseStream(res);
  writeSseJson(res, { type: 'connected' });
  attachSseWatcher(liveState.watchers, req, res);
  writeSseJson(res, {
    type: 'usage-scan-snapshot',
    jobs: [...liveState.jobs.values()].map(serializeUsageScanJob)
  });
  return true;
}

module.exports = {
  getUsageLiveState,
  handleUsageScanWatchRequest,
  startUsageScanJob,
  serializeUsageScanJob,
  __private: {
    normalizeProviderFilter
  }
};
