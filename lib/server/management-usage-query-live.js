'use strict';

const {
  attachSseWatcher,
  broadcastSseJson,
  openSseStream,
  writeSseJson
} = require('./webui-sse-broadcaster');

const MAX_USAGE_DASHBOARD_QUERY_JOBS = 20;
const ACTIVE_QUERY_STATUSES = new Set(['queued', 'preparing', 'running']);

function getUsageDashboardQueryLiveState(state) {
  if (!state.usageDashboardQueryLive || typeof state.usageDashboardQueryLive !== 'object') {
    state.usageDashboardQueryLive = {
      watchers: new Set(),
      jobs: new Map(),
      nextJobSeq: 0
    };
  }
  return state.usageDashboardQueryLive;
}

function serializeUsageDashboardQueryJob(job) {
  return {
    id: String(job && job.id || ''),
    status: String(job && job.status || 'queued'),
    query: job && job.query || {},
    startedAt: Number(job && job.startedAt) || 0,
    finishedAt: Number(job && job.finishedAt) || 0,
    completedShards: Number(job && job.completedShards) || 0,
    totalShards: Number(job && job.totalShards) || 0,
    dashboard: job && job.dashboard || null,
    error: String(job && job.error || '')
  };
}

function broadcastUsageDashboardQueryJob(liveState, job) {
  const payload = {
    type: 'usage-dashboard-query-job',
    job: serializeUsageDashboardQueryJob(job)
  };
  broadcastSseJson(liveState.watchers, payload);
  return payload;
}

function trimFinishedJobs(liveState) {
  const jobs = [...liveState.jobs.values()];
  if (jobs.length <= MAX_USAGE_DASHBOARD_QUERY_JOBS) return;
  jobs
    .filter((job) => !ACTIVE_QUERY_STATUSES.has(job.status))
    .sort((left, right) => (
      (Number(left.finishedAt) || Number(left.startedAt) || 0)
      - (Number(right.finishedAt) || Number(right.startedAt) || 0)
    ))
    .slice(0, Math.max(0, jobs.length - MAX_USAGE_DASHBOARD_QUERY_JOBS))
    .forEach((job) => liveState.jobs.delete(job.id));
}

async function syncPricingBestEffort(modelUsageService) {
  if (typeof modelUsageService.syncPricingIfStale !== 'function') return;
  try {
    await modelUsageService.syncPricingIfStale();
  } catch (_error) {
    // A stale local catalog remains usable; querying usage must not fail here.
  }
}

async function runUsageDashboardQueryJob(liveState, job, modelUsageService) {
  job.status = 'preparing';
  job.startedAt = Date.now();
  broadcastUsageDashboardQueryJob(liveState, job);

  try {
    await syncPricingBestEffort(modelUsageService);
    if (job.controller.signal.aborted) return;
    const dashboard = await modelUsageService.getDashboardProgressive(job.query, {
      signal: job.controller.signal,
      onProgress: (progress) => {
        if (job.controller.signal.aborted || job.status === 'cancelled') return;
        job.status = 'running';
        job.completedShards = Number(progress && progress.completedShards) || 0;
        job.totalShards = Number(progress && progress.totalShards) || 0;
        job.dashboard = progress && progress.dashboard || null;
        broadcastUsageDashboardQueryJob(liveState, job);
      }
    });
    if (job.controller.signal.aborted || job.status === 'cancelled') return;
    job.dashboard = dashboard;
    job.completedShards = Math.max(job.completedShards, job.totalShards || 1);
    job.totalShards = Math.max(job.totalShards, job.completedShards);
    job.status = 'succeeded';
  } catch (error) {
    if (job.controller.signal.aborted || job.status === 'cancelled') return;
    job.status = 'failed';
    job.error = String((error && error.message) || error || 'model_usage_query_failed');
  } finally {
    if (job.status === 'cancelled') {
      trimFinishedJobs(liveState);
      return;
    }
    if (!ACTIVE_QUERY_STATUSES.has(job.status)) {
      job.finishedAt = Date.now();
      broadcastUsageDashboardQueryJob(liveState, job);
      trimFinishedJobs(liveState);
    }
  }
}

function startUsageDashboardQuery(state, modelUsageService, query) {
  if (!modelUsageService || typeof modelUsageService.getDashboardProgressive !== 'function') {
    const error = new Error('model_usage_progressive_query_unavailable');
    error.code = 'model_usage_progressive_query_unavailable';
    throw error;
  }
  const liveState = getUsageDashboardQueryLiveState(state);
  liveState.nextJobSeq += 1;
  const job = {
    id: `usage-dashboard-query-${Date.now()}-${liveState.nextJobSeq}`,
    status: 'queued',
    query: { ...query },
    startedAt: 0,
    finishedAt: 0,
    completedShards: 0,
    totalShards: 0,
    dashboard: null,
    error: '',
    controller: new AbortController()
  };
  liveState.jobs.set(job.id, job);
  broadcastUsageDashboardQueryJob(liveState, job);
  Promise.resolve()
    .then(() => runUsageDashboardQueryJob(liveState, job, modelUsageService))
    .catch(() => {});
  return serializeUsageDashboardQueryJob(job);
}

function cancelUsageDashboardQuery(state, jobId) {
  const liveState = getUsageDashboardQueryLiveState(state);
  const job = liveState.jobs.get(String(jobId || '').trim());
  if (!job) return null;
  if (!ACTIVE_QUERY_STATUSES.has(job.status)) {
    return { cancelled: false, job: serializeUsageDashboardQueryJob(job) };
  }
  job.status = 'cancelled';
  job.finishedAt = Date.now();
  job.controller.abort();
  broadcastUsageDashboardQueryJob(liveState, job);
  trimFinishedJobs(liveState);
  return { cancelled: true, job: serializeUsageDashboardQueryJob(job) };
}

function handleUsageDashboardQueryWatchRequest(ctx) {
  const { req, res, state } = ctx;
  const liveState = getUsageDashboardQueryLiveState(state);
  openSseStream(res);
  writeSseJson(res, { type: 'connected' });
  attachSseWatcher(liveState.watchers, req, res);
  writeSseJson(res, {
    type: 'usage-dashboard-query-snapshot',
    jobs: [...liveState.jobs.values()].map(serializeUsageDashboardQueryJob)
  });
  return true;
}

module.exports = {
  cancelUsageDashboardQuery,
  getUsageDashboardQueryLiveState,
  handleUsageDashboardQueryWatchRequest,
  serializeUsageDashboardQueryJob,
  startUsageDashboardQuery
};
