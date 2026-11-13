'use strict';
// 账号刷新作业的内存跟踪与 SSE 事件广播辅助。

const crypto = require('node:crypto');
const {
  emitAccountsLiveEvent
} = require('./webui-account-live');

const ACCOUNT_REFRESH_JOB_RETENTION_MS = 10 * 60 * 1000;
const ACCOUNT_REFRESH_JOB_MAX = 200;

const accountRefreshJobs = new Map();

function makeAccountRefreshJobId(provider, accountRef) {
  return [
    'acct-refresh',
    String(provider || '').trim().toLowerCase(),
    String(accountRef || '').trim(),
    Date.now().toString(36),
    crypto.randomBytes(4).toString('hex')
  ].filter(Boolean).join('-');
}

function isAccountRefreshJobActive(job) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function pruneAccountRefreshJobs() {
  const now = Date.now();
  for (const [jobId, job] of accountRefreshJobs.entries()) {
    if (!isAccountRefreshJobActive(job) && now - Number(job.updatedAt || 0) > ACCOUNT_REFRESH_JOB_RETENTION_MS) {
      accountRefreshJobs.delete(jobId);
    }
  }

  const removable = Array.from(accountRefreshJobs.values())
    .filter((job) => !isAccountRefreshJobActive(job))
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
  while (accountRefreshJobs.size > ACCOUNT_REFRESH_JOB_MAX && removable.length > 0) {
    const job = removable.shift();
    if (job && job.id) accountRefreshJobs.delete(job.id);
  }
}

function findActiveAccountRefreshJob(provider, accountRef, scope = 'usage') {
  pruneAccountRefreshJobs();
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedAccountRef = String(accountRef || '').trim();
  return Array.from(accountRefreshJobs.values()).find((job) => (
    isAccountRefreshJobActive(job)
    && job.provider === normalizedProvider
    && job.accountRef === normalizedAccountRef
    && (job.scope || 'usage') === scope
  )) || null;
}

function serializeAccountRefreshJob(job) {
  if (!job) return null;
  return {
    id: String(job.id || ''),
    provider: String(job.provider || ''),
    accountRef: String(job.accountRef || ''),
    status: String(job.status || 'queued'),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null,
    error: String(job.error || ''),
    // 轻探测成功并因此自动清掉了运行态阻塞（见 Go accountruntime）。
    ...(job.recovered === true ? { recovered: true } : {}),
    // 部分失败：作业整体仍算成功（其它面已刷新），但要如实告诉界面是哪几面失败，
    // 否则用户只看到「已刷新」而不知道模型/额度那一面其实没拿到。
    ...(Array.isArray(job.failedBranches) && job.failedBranches.length > 0
      ? { failedBranches: job.failedBranches.map((name) => String(name)) }
      : {}),
    ...(job.scope === 'account' ? {
      scope: 'account',
      branches: Object.fromEntries(Object.entries(job.branches).map(([key, branch]) => [key, {
        status: branch.status,
        error: String(branch.error || '')
      }]))
    } : {})
  };
}

function emitAccountRefreshJobEvent(ctx, job) {
  emitAccountsLiveEvent(ctx, {
    type: 'account-refresh-job',
    job: serializeAccountRefreshJob(job)
  });
}

module.exports = {
  ACCOUNT_REFRESH_JOB_RETENTION_MS,
  ACCOUNT_REFRESH_JOB_MAX,
  accountRefreshJobs,
  makeAccountRefreshJobId,
  isAccountRefreshJobActive,
  pruneAccountRefreshJobs,
  findActiveAccountRefreshJob,
  serializeAccountRefreshJob,
  emitAccountRefreshJobEvent
};
