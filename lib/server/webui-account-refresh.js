'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const liveAccountSource = require('./webui-account-live');
const { parseAccountRoute } = require('./webui-account-routes-utils');
const {
  accountRefreshJobs,
  emitAccountRefreshJobEvent,
  findActiveAccountRefreshJob,
  makeAccountRefreshJobId,
  serializeAccountRefreshJob
} = require('./webui-account-routes-refresh');

const BRANCH_LABELS = { status: '状态', models: '模型', usage: '额度' };
const GO_REFRESH_POLL_INTERVAL_MS = 300;
const GO_REFRESH_POLL_TIMEOUT_MS = 30 * 1000;
const GO_REFRESH_UNAVAILABLE_CODES = new Set([
  'go_core_unavailable',
  'network_error',
  'http_404',
  'http_405',
  'http_501'
]);
const GO_REFRESH_TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

function isActiveJobStatus(status) {
  return status === 'queued' || status === 'running';
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function readGoRefreshHost(ctx) {
  const host = ctx && ctx.deps && ctx.deps.goCoreSync;
  if (!host || typeof host.refreshAccountWebUI !== 'function') return null;
  return host;
}

function readGoDomainError(result) {
  const data = result && result.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { code: '', message: '' };
  const raw = data.error;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      code: String(raw.code || raw.error || '').trim(),
      message: String(raw.message || '').trim()
    };
  }
  return {
    code: typeof raw === 'string' ? raw.trim() : String(data.code || '').trim(),
    message: String(data.message || '').trim()
  };
}

function isGoRefreshUnavailable(result) {
  if (!result) return true;
  const errorCode = String(result.errorCode || '');
  if (errorCode === 'timeout') return false;
  if (readGoDomainError(result).code) return false;
  if (GO_REFRESH_UNAVAILABLE_CODES.has(errorCode)) return true;
  const status = Number(result.status || 0);
  return status === 0 || status === 501 || status >= 500;
}

function applyGoJobSnapshot(job, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const status = String(snapshot.status || '');
  if (status) job.status = status;
  job.error = String(snapshot.error || '').slice(0, 500);
  if (Array.isArray(snapshot.failedBranches)) {
    job.failedBranches = snapshot.failedBranches.map((name) => String(name)).filter(Boolean);
  }
  if (snapshot.recovered === true) job.recovered = true;
  const branches = snapshot.branches;
  const localBranches = job.branches && typeof job.branches === 'object' ? job.branches : null;
  if (localBranches && branches && typeof branches === 'object') {
    for (const name of Object.keys(localBranches)) {
      const branch = branches[name];
      if (!branch || typeof branch !== 'object') continue;
      if (branch.status) localBranches[name].status = String(branch.status);
      localBranches[name].error = String(branch.error || '').slice(0, 500);
    }
  }
  if (Number(snapshot.finishedAt) > 0) job.finishedAt = Number(snapshot.finishedAt);
  if (Number(snapshot.updatedAt) > 0) job.updatedAt = Number(snapshot.updatedAt);
}

function failActiveBranches(job, error) {
  const branches = job.branches && typeof job.branches === 'object' ? job.branches : null;
  if (!branches) return [];
  const failed = [];
  for (const [name, branch] of Object.entries(branches)) {
    if (!isActiveJobStatus(branch.status)) continue;
    branch.status = 'failed';
    branch.error = String(error || '').slice(0, 500);
    failed.push(name);
  }
  return failed;
}

function failGoRefresh(ctx, job, message) {
  const now = Date.now();
  job.status = 'failed';
  job.error = String(message || '刷新失败').slice(0, 500);
  const failed = failActiveBranches(job, job.error);
  if (failed.length > 0 && !Array.isArray(job.failedBranches)) {
    job.failedBranches = failed;
  }
  job.finishedAt = now;
  job.updatedAt = now;
  emitAccountRefreshJobEvent(ctx, job);
}

function triggerCanonicalRefresh(ctx) {
  const livePrivate = liveAccountSource && liveAccountSource.__private;
  if (livePrivate && typeof livePrivate.refreshAccountsFromCanonicalSource === 'function') {
    livePrivate.refreshAccountsFromCanonicalSource(ctx, { force: true }).catch(() => {});
  }
}

async function pollGoRefreshJob(ctx, goHost, job, goJobId) {
  let snapshot = { id: goJobId, status: job.status };
  const deadline = Date.now() + GO_REFRESH_POLL_TIMEOUT_MS;
  while (isActiveJobStatus(String(snapshot.status || ''))) {
    if (Date.now() >= deadline) {
      failGoRefresh(ctx, job, '刷新超时');
      return;
    }
    await delay(GO_REFRESH_POLL_INTERVAL_MS);
    if (typeof goHost.getRefreshJob !== 'function') {
      failGoRefresh(ctx, job, 'Go 未提供刷新进度查询');
      return;
    }
    let polled = null;
    try {
      polled = await goHost.getRefreshJob(String(goJobId || ''));
    } catch (_error) {
      polled = null;
    }
    if (polled && polled.ok && polled.data && polled.data.job) {
      snapshot = polled.data.job;
      continue;
    }
    if (Number((polled && polled.status) || 0) === 404) {
      failGoRefresh(ctx, job, '刷新作业已失效');
      return;
    }
  }
  applyGoJobSnapshot(job, snapshot);
  if (!GO_REFRESH_TERMINAL_STATUSES.has(job.status)) {
    job.status = 'failed';
    job.error = job.error || '刷新作业状态异常';
  }
  job.finishedAt = job.finishedAt || Date.now();
  job.updatedAt = job.updatedAt || job.finishedAt;
  triggerCanonicalRefresh(ctx);
  emitAccountRefreshJobEvent(ctx, job);
}

async function handleRefreshAccountRequest(ctx) {
  const parsed = parseAccountRoute(ctx.pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/refresh$/);
  if (!parsed || !SUPPORTED_SERVER_PROVIDERS.includes(parsed.provider)) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: parsed ? 'unsupported_provider' : 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  const goHost = readGoRefreshHost(ctx);
  if (!goHost) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 账号刷新服务不可用'
    });
    return true;
  }

  let started = null;
  try {
    started = await goHost.refreshAccountWebUI(provider, accountRef);
  } catch (_error) {
    started = null;
  }

  if (started && String(started.errorCode || '') === 'timeout') {
    ctx.writeJson(ctx.res, 504, {
      ok: false,
      error: 'refresh_timeout',
      message: '刷新请求超时'
    });
    return true;
  }
  if (isGoRefreshUnavailable(started)) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 账号刷新服务不可用'
    });
    return true;
  }
  if (!started.ok) {
    const domainError = readGoDomainError(started);
    const status = Number(started.status) >= 400 ? Number(started.status) : 500;
    ctx.writeJson(ctx.res, status, {
      ok: false,
      error: domainError.code || String(started.errorCode || 'account_refresh_failed'),
      ...(domainError.message ? { message: domainError.message } : {})
    });
    return true;
  }

  const snapshot = started.data && started.data.job;
  if (!snapshot || typeof snapshot !== 'object') {
    ctx.writeJson(ctx.res, 502, {
      ok: false,
      error: 'invalid_go_response',
      message: 'Go 未返回刷新作业快照'
    });
    return true;
  }

  const existing = findActiveAccountRefreshJob(provider, accountRef, 'account');
  if (existing) {
    applyGoJobSnapshot(existing, snapshot);
    emitAccountRefreshJobEvent(ctx, existing);
    ctx.writeJson(ctx.res, 202, {
      ok: true,
      accepted: true,
      alreadyRunning: true,
      job: serializeAccountRefreshJob(existing)
    });
    return true;
  }

  const now = Date.now();
  const job = {
    id: String(snapshot.id || makeAccountRefreshJobId(provider, accountRef)),
    provider,
    accountRef,
    scope: 'account',
    status: String(snapshot.status || 'queued'),
    branches: Object.fromEntries(Object.keys(BRANCH_LABELS).map((name) => [name, { status: 'queued', error: '' }])),
    createdAt: Number(snapshot.createdAt) || now,
    updatedAt: Number(snapshot.updatedAt) || now,
    finishedAt: Number(snapshot.finishedAt) || 0,
    error: String(snapshot.error || '')
  };
  applyGoJobSnapshot(job, snapshot);
  accountRefreshJobs.set(job.id, job);
  emitAccountRefreshJobEvent(ctx, job);
  ctx.writeJson(ctx.res, 202, {
    ok: true,
    accepted: true,
    alreadyRunning: Boolean(started.data.alreadyRunning),
    job: serializeAccountRefreshJob(job)
  });

  if (isActiveJobStatus(job.status)) {
    const timer = setTimeout(() => {
      pollGoRefreshJob(ctx, goHost, job, String(snapshot.id || job.id)).catch(() => {});
    }, 0);
    timer.unref?.();
  } else {
    triggerCanonicalRefresh(ctx);
  }
  return true;
}

module.exports = { handleRefreshAccountRequest };
