'use strict';

const { listProvidersByCapability } = require('../provider-catalog');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { refreshLiveAccountRecord } = require('./webui-account-live');
const { detectStoredApiKeyMode } = require('./webui-account-routes-state');
const { accountExists, parseAccountRoute } = require('./webui-account-routes-utils');
const { startModelCatalogRefreshJob } = require('./webui-openai-model-routes');
const {
  accountRefreshJobs,
  emitAccountRefreshJobEvent,
  findActiveAccountRefreshJob,
  makeAccountRefreshJobId,
  serializeAccountRefreshJob
} = require('./webui-account-routes-refresh');

const MODEL_CATALOG_PROVIDERS = new Set(listProvidersByCapability('modelCatalog'));
const BRANCH_LABELS = { status: '状态', models: '模型', usage: '额度' };

async function refreshAccountRecord(ctx, job, options) {
  const account = await refreshLiveAccountRecord(ctx, job.provider, job.accountRef, options);
  if (!account) throw new Error('account_not_found');
}

function createRefreshBranches(ctx, job, apiKeyMode) {
  return {
    status: () => refreshAccountRecord(ctx, job, { skipUsageRefresh: true }),
    models: async () => {
      if (!MODEL_CATALOG_PROVIDERS.has(job.provider)) return 'skipped';
      const started = startModelCatalogRefreshJob(ctx, { accountRef: job.accountRef });
      await started.job.completion;
      const error = started.job.error || started.job.catalog?.errorsByAccountRef?.[job.accountRef];
      if (started.job.status === 'failed' || error) throw new Error(error || 'model_catalog_refresh_failed');
    },
    usage: async () => {
      if (apiKeyMode) return 'skipped';
      await refreshAccountRecord(ctx, job, { skipRuntimeReload: true });
      const probe = typeof ctx.getLastUsageProbeState === 'function'
        ? ctx.getLastUsageProbeState(job.provider, job.accountRef)
        : null;
      if (probe && Number(probe.checkedAt) >= job.createdAt && probe.error) {
        throw new Error(String(probe.error));
      }
    }
  };
}

async function runAccountRefresh(ctx, job, apiKeyMode) {
  job.status = 'running';
  job.updatedAt = Date.now();
  Object.values(job.branches).forEach((branch) => { branch.status = 'running'; });
  emitAccountRefreshJobEvent(ctx, job);
  // 先排入全部分支，再等待结果；单分支失败不取消其他刷新。
  await Promise.allSettled(Object.entries(createRefreshBranches(ctx, job, apiKeyMode)).map(async ([name, refresh]) => {
    try {
      const result = await Promise.resolve().then(refresh);
      job.branches[name].status = result === 'skipped' ? 'skipped' : 'succeeded';
    } catch (error) {
      job.branches[name].status = 'failed';
      job.branches[name].error = String(error?.message || error || 'unknown').slice(0, 500);
    }
    job.updatedAt = Date.now();
    emitAccountRefreshJobEvent(ctx, job);
  }));
  const failures = Object.entries(job.branches).filter(([, branch]) => branch.status === 'failed');
  job.status = failures.length ? 'failed' : 'succeeded';
  job.error = failures.map(([name, branch]) => `${BRANCH_LABELS[name]}：${branch.error}`).join('；');
  job.finishedAt = Date.now();
  job.updatedAt = job.finishedAt;
  emitAccountRefreshJobEvent(ctx, job);
}

function startAccountRefresh(ctx, provider, accountRef) {
  const active = findActiveAccountRefreshJob(provider, accountRef, 'account');
  if (active) return { job: active, alreadyRunning: true };

  const stateRow = ctx.accountStateIndex?.getAccountState(accountRef);
  const apiKeyMode = detectStoredApiKeyMode(ctx, provider, accountRef, stateRow);
  const now = Date.now();
  const job = {
    id: makeAccountRefreshJobId(provider, accountRef),
    provider,
    accountRef,
    scope: 'account',
    status: 'queued',
    branches: Object.fromEntries(Object.keys(BRANCH_LABELS).map((name) => [name, { status: 'queued', error: '' }])),
    createdAt: now,
    updatedAt: now,
    finishedAt: 0,
    error: ''
  };
  accountRefreshJobs.set(job.id, job);
  emitAccountRefreshJobEvent(ctx, job);
  const timer = setTimeout(() => {
    runAccountRefresh(ctx, job, apiKeyMode).catch(() => {});
  }, 0);
  timer.unref?.();
  return { job, alreadyRunning: false };
}

function handleRefreshAccountRequest(ctx) {
  const parsed = parseAccountRoute(ctx.pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/refresh$/);
  if (!parsed || !SUPPORTED_SERVER_PROVIDERS.includes(parsed.provider)) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: parsed ? 'unsupported_provider' : 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!accountExists(ctx, provider, accountRef)) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const started = startAccountRefresh(ctx, provider, accountRef);
  ctx.writeJson(ctx.res, 202, {
    ok: true,
    accepted: true,
    alreadyRunning: started.alreadyRunning,
    job: serializeAccountRefreshJob(started.job)
  });
  return true;
}

module.exports = { handleRefreshAccountRequest };
