'use strict';

// 账号活动的异步执行器：WebUI 领取请求只负责“开始”，真正的签到 / 领套餐在后台队列里跑。
//
// 为什么必须是后台任务：ZCode 每个账号都要过一次无痕验证码（约 10–20s），账号一多，
// 一个同步 HTTP 请求会轻易越过浏览器 / 代理的超时；即使没超时，页面也只能干等。
// 这里把「开始」与「查询」拆开：POST 立即返回 job，页面轮询 progress 与最终 results。
//
// 队列是**全局串行**的：同一时间只跑一个活动任务（验证码会启动本机 Chrome，账号出口
// 也可能共用），其它任务排队。同一个 (actionId + providers) 正在跑时复用现有任务，
// 避免用户连点造成同一批账号重复领取。
//
// 这个模块不持有任何账号 / 网络依赖：`start()` 接收已经快照好的 targets 与 execute，
// 因此路由层仍是唯一知道 provider 描述符与账号仓库的地方。

const crypto = require('node:crypto');
const {
  summarizeActivityResults,
  dominantActivityErrorCode,
  activityErrorCodeOf
} = require('../account/activity-claim/outcomes');

const TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed']);
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());
}

// 汇总只有一份实现（lib/account/activity-claim/outcomes.js）：状态词汇表与错误码
// 归一都在那里，这里只做转发，避免「job 一套、计划任务一套」再次漂移。
const summarizeResults = summarizeActivityResults;

function serializeJob(job) {
  if (!job || typeof job !== 'object') return null;
  const total = Math.max(0, Number(job.progress && job.progress.total) || 0);
  const completed = Math.max(0, Math.min(total, Number(job.progress && job.progress.completed) || 0));
  return {
    id: String(job.id || ''),
    providers: [...job.providers],
    actionId: String(job.actionId || ''),
    actionLabel: String(job.actionLabel || ''),
    status: String(job.status || ''),
    phase: String(job.phase || ''),
    progress: {
      total,
      completed,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
      currentProvider: String(job.progress && job.progress.currentProvider || ''),
      currentAccountRef: String(job.progress && job.progress.currentAccountRef || '')
    },
    results: [...job.results],
    summary: job.summary ? { ...job.summary } : null,
    error: String(job.error || ''),
    // 结构化失败归因：`error` 仍是机器码（前端与历史记录在读），
    // 旁边这三项回答「到底为什么」「哪些账号」。
    errorCode: String(job.errorCode || ''),
    errorSummary: String(job.errorSummary || ''),
    failures: job.failures ? {
      total: Number(job.failures.total) || 0,
      byCode: [...(job.failures.byCode || [])],
      byAccount: [...(job.failures.byAccount || [])]
    } : null,
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null
  };
}

function createAccountActivityJobManager(options = {}) {
  const jobs = new Map();
  const queue = [];
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const retentionMs = Number.isFinite(Number(options.retentionMs))
    ? Math.max(0, Number(options.retentionMs))
    : DEFAULT_RETENTION_MS;
  let draining = false;

  function notify(job) {
    try {
      options.onJobChanged?.(serializeJob(job));
    } catch (_error) {
      // 状态观察者失败不能影响领取任务本身。
    }
  }

  function prune() {
    const cutoff = now() - retentionMs;
    for (const [id, job] of jobs) {
      if (!isTerminalStatus(job.status) || Number(job.finishedAt || 0) > cutoff) continue;
      jobs.delete(id);
    }
  }

  function findActive(providers, actionId) {
    const targetKey = `${actionId}:${providers.join(',')}`;
    for (const job of jobs.values()) {
      if (isTerminalStatus(job.status)) continue;
      if (job.targetKey === targetKey) return job;
    }
    return null;
  }

  async function runJob(job) {
    job.status = 'running';
    job.phase = 'claiming';
    job.updatedAt = now();
    notify(job);
    try {
      for (const target of job.targets) {
        job.progress.currentProvider = target.provider;
        job.progress.currentAccountRef = target.record.accountRef;
        job.updatedAt = now();
        notify(job);
        let result;
        try {
          result = await job.execute(target);
        } catch (error) {
          result = {
            provider: target.provider,
            accountRef: target.record.accountRef,
            actionId: job.actionId,
            status: 'error',
            error: `activity_failed:${String(error && error.message || error).trim()}`
          };
        }
        const normalized = result && typeof result === 'object'
          ? result
          : {
            provider: target.provider,
            accountRef: target.record.accountRef,
            actionId: job.actionId,
            status: 'error',
            error: 'activity_empty_result'
          };
        // 每个结果都带上归一后的错误码，页面/记录据此分组，不用自己解析 error 字符串。
        const errorCode = activityErrorCodeOf(normalized);
        job.results.push(errorCode ? { ...normalized, errorCode } : normalized);
        job.progress.completed += 1;
        job.updatedAt = now();
        notify(job);
      }
      job.summary = summarizeResults(job.results);
      job.failures = job.summary.failures;
      job.errorSummary = job.summary.errorSummary;
      job.errorCode = dominantActivityErrorCode(job.summary);
      if (job.summary.failed === 0) {
        job.status = 'succeeded';
        job.phase = 'completed';
      } else if (job.summary.failed < job.summary.accounts) {
        job.status = 'partial';
        job.phase = 'completed';
      } else {
        job.status = 'failed';
        job.phase = 'failed';
        job.error = 'all_accounts_failed';
      }
    } catch (error) {
      job.summary = summarizeResults(job.results);
      job.failures = job.summary.failures;
      job.errorSummary = job.summary.errorSummary;
      job.errorCode = dominantActivityErrorCode(job.summary);
      job.status = 'failed';
      job.phase = 'failed';
      job.error = String(error && error.message || error || 'activity_job_failed').slice(0, 500);
    } finally {
      job.progress.currentProvider = '';
      job.progress.currentAccountRef = '';
      job.updatedAt = now();
      job.finishedAt = now();
      // 结果已经快照进 job，释放可能携带请求上下文的闭包。
      job.execute = null;
      job.targets = [];
      notify(job);
      // 结算回调：调用方用它释放跨路径运行权（防抖/唯一守卫，见 scheduled-run-guard）。
      // 必须放在 notify 之后、且自身失败不能影响 job 结果。
      const settled = job.onSettled;
      job.onSettled = null;
      if (typeof settled === 'function') {
        try { settled(job); } catch (_error) { /* 忽略 */ }
      }
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        await runJob(job);
      }
    } finally {
      draining = false;
    }
  }

  function start(input = {}) {
    const providers = [...new Set((input.providers || []).map((provider) => String(provider || '').trim().toLowerCase()).filter(Boolean))].sort();
    const actionId = String(input.actionId || '').trim().toLowerCase();
    const targets = Array.isArray(input.targets) ? input.targets : [];
    if (providers.length === 0 || !actionId || targets.length === 0) {
      return { ok: false, error: 'activity_selection_empty' };
    }
    prune();
    const active = findActive(providers, actionId);
    if (active) {
      return { ok: true, alreadyRunning: true, job: serializeJob(active) };
    }
    const timestamp = now();
    const job = {
      id: `activity-job-${crypto.randomUUID()}`,
      providers,
      actionId,
      actionLabel: String(input.actionLabel || actionId),
      targetKey: `${actionId}:${providers.join(',')}`,
      targets,
      execute: input.execute,
      status: 'queued',
      phase: 'queued',
      // 结算回调（调用方用来释放跨路径运行权；见 scheduled-run-guard）。
      onSettled: typeof input.onSettled === 'function' ? input.onSettled : null,
      progress: {
        total: targets.length,
        completed: 0,
        currentProvider: '',
        currentAccountRef: ''
      },
      results: [],
      summary: null,
      error: '',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: 0
    };
    jobs.set(job.id, job);
    queue.push(job);
    notify(job);
    // 后台任务本身就是有效工作，不 unref：进程只要还有任务在跑就应继续存活到它结束。
    setImmediate(() => { void drain(); });
    return { ok: true, alreadyRunning: false, job: serializeJob(job) };
  }

  function getJob(jobId) {
    prune();
    return serializeJob(jobs.get(String(jobId || '').trim()) || null);
  }

  function listJobs() {
    prune();
    return [...jobs.values()].map(serializeJob);
  }

  return {
    start,
    getJob,
    listJobs,
    serializeJob,
    isTerminalStatus
  };
}

module.exports = {
  createAccountActivityJobManager,
  isTerminalStatus,
  serializeJob,
  summarizeResults
};
