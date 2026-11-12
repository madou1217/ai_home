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
  ACTIVITY_OUTCOMES,
  summarizeActivityResults,
  formatActivitySummary,
  dominantActivityErrorCode,
  activityErrorCodeOf
} = require('../account/activity-claim/outcomes');
const { stableFingerprint } = require('./stable-fingerprint');
const { ACCOUNT_ACTIVITY_PACING_MS } = require('../account/activity-claim/pacing');
const {
  MAX_EVENTS_PER_TASK,
  TASK_EVENT_PHASES,
  createTaskEvent
} = require('./webui-task-events');
const { primaryActivityAccountLabel } = require('./account-activity-identity');

const TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed']);
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;
// 批量领取的账号间隔：ZCode 的活动接口在连续请求下会回 429（2026-11-06 真机：
// 手动连点几个账号后出现 zcode_claim_failed:429）。值与 CLI 共用唯一口径。
const DEFAULT_TARGET_PACING_MS = ACCOUNT_ACTIVITY_PACING_MS;

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());
}

/**
 * 任务复用键 = 动作 + provider 集合 + **参数指纹**。
 * 不带参数时与历史键完全一致（`trial_plan:zcode`），老行为不变；
 * 带上账号子集/类型后是不同的键 —— 「8:00 领 A 号、9:00 领 B 号」互不顶掉。
 */
function targetKeyOf(actionId, providers, params) {
  const fingerprint = stableFingerprint(params);
  return `${actionId}:${providers.join(',')}${fingerprint ? `#${fingerprint}` : ''}`;
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
    params: job.params && typeof job.params === 'object' ? { ...job.params } : {},
    status: String(job.status || ''),
    phase: String(job.phase || ''),
    progress: {
      total,
      completed,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
      currentProvider: String(job.progress && job.progress.currentProvider || ''),
      currentAccountRef: String(job.progress && job.progress.currentAccountRef || ''),
      stage: String(job.progress && job.progress.stage || ''),
      label: String(job.progress && job.progress.label || ''),
      // 展示身份只给 displayNames / displayId / provider；currentAccountRef 仅作内部关联。
      account: job.progress && job.progress.account
        ? {
          provider: String(job.progress.account.provider || ''),
          displayId: String(job.progress.account.displayId || ''),
          displayNames: Array.isArray(job.progress.account.displayNames)
            ? job.progress.account.displayNames.map((entry) => ({ ...entry }))
            : []
        }
        : null
    },
    // 事件流是**增量**：任务详情页/SSE 重连时用最近事件还原「执行到哪里了」。
    events: Array.isArray(job.events) ? job.events.map((event) => ({ ...event })) : [],
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

  /**
   * 追加一条任务事件并广播。事件不是任务状态：job.status 仍由执行结果决定。
   * progress 只吸收事件的展示字段（stage/label/account），供任务快照使用。
   */
  function emitEvent(job, update = {}) {
    const account = update.account || job.progress.account || null;
    const event = createTaskEvent({
      taskId: job.id,
      seq: (job.eventSeq || 0) + 1,
      at: now(),
      phase: update.phase,
      tone: update.tone,
      message: update.message,
      account
    });
    if (!event) return null;
    job.eventSeq = event.seq;
    job.events.push(event);
    // 与 webui-task-events 的单任务上限一致；这里再兜一层，避免 job 快照无界。
    while (job.events.length > MAX_EVENTS_PER_TASK) job.events.shift();
    job.updatedAt = event.at;
    job.progress.stage = event.phase;
    const primary = primaryActivityAccountLabel(account);
    job.progress.label = [
      job.progress.total > 0 ? `${job.progress.completed}/${job.progress.total}` : '',
      primary
    ].filter(Boolean).join(' · ');
    notify(job);
    try {
      options.onTaskEvent?.(event);
    } catch (_error) {
      // 事件观察者失败不能影响领取任务本身。
    }
    return event;
  }

  function prune() {
    const cutoff = now() - retentionMs;
    for (const [id, job] of jobs) {
      if (!isTerminalStatus(job.status) || Number(job.finishedAt || 0) > cutoff) continue;
      jobs.delete(id);
    }
  }

  function findActive(providers, actionId, params) {
    const targetKey = targetKeyOf(actionId, providers, params);
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
      // 全局串行任务内部的账号间隔：连续领取是 429 的直接诱因（2026-11-06 真机）。
      // 可被 start({ pacingMs }) 覆盖；0 = 关闭（单测/离线执行）。
      const pacingMs = Math.max(0, Number(job.pacingMs) || 0);
      for (let index = 0; index < job.targets.length; index += 1) {
        if (index > 0 && pacingMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pacingMs));
        }
        const target = job.targets[index];
        job.progress.currentProvider = target.provider;
        job.progress.currentAccountRef = target.record.accountRef;
        job.progress.account = target.identity || null;
        job.updatedAt = now();
        const accountLabel = primaryActivityAccountLabel(job.progress.account);
        emitEvent(job, {
          phase: TASK_EVENT_PHASES.ACCOUNT_STARTED,
          tone: 'info',
          message: `开始处理 ${accountLabel || target.provider}（${index + 1}/${job.targets.length}）`,
          account: job.progress.account
        });
        let result;
        const report = (event = {}) => emitEvent(job, {
          ...event,
          account: event.account || job.progress.account
        });
        try {
          result = await job.execute(target, { report });
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
        const resultStatus = String(normalized.status || '').toLowerCase();
        const outcome = ACTIVITY_OUTCOMES[resultStatus];
        const resultMessage = errorCode
          ? `${outcome ? outcome.label : '失败'}：${errorCode}`
          : (outcome ? outcome.label : '已处理');
        emitEvent(job, {
          phase: errorCode ? TASK_EVENT_PHASES.FAILED : TASK_EVENT_PHASES.ACCOUNT_FINISHED,
          tone: errorCode ? 'error' : (resultStatus === 'claimed' ? 'success' : 'info'),
          message: resultMessage,
          account: job.progress.account
        });
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
      emitEvent(job, {
        phase: job.status === 'failed' ? TASK_EVENT_PHASES.FAILED : TASK_EVENT_PHASES.COMPLETED,
        tone: job.status === 'failed' ? 'error' : (job.status === 'partial' ? 'warning' : 'success'),
        message: job.summary ? formatActivitySummary(job.summary) : '任务结束',
        account: null
      });
    } catch (error) {
      job.summary = summarizeResults(job.results);
      job.failures = job.summary.failures;
      job.errorSummary = job.summary.errorSummary;
      job.errorCode = dominantActivityErrorCode(job.summary);
      job.status = 'failed';
      job.phase = 'failed';
      job.error = String(error && error.message || error || 'activity_job_failed').slice(0, 500);
      emitEvent(job, {
        phase: TASK_EVENT_PHASES.FAILED,
        tone: 'error',
        message: `任务失败：${job.error}`,
        account: null
      });
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
    const params = input.params && typeof input.params === 'object' ? input.params : {};
    const targets = Array.isArray(input.targets) ? input.targets : [];
    if (providers.length === 0 || !actionId || targets.length === 0) {
      return { ok: false, error: 'activity_selection_empty' };
    }
    prune();
    const active = findActive(providers, actionId, params);
    if (active) {
      return { ok: true, alreadyRunning: true, job: serializeJob(active) };
    }
    const timestamp = now();
    const job = {
      id: `activity-job-${crypto.randomUUID()}`,
      providers,
      actionId,
      actionLabel: String(input.actionLabel || actionId),
      params,
      targetKey: targetKeyOf(actionId, providers, params),
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
        currentAccountRef: '',
        stage: 'queued',
        label: '',
        account: null
      },
      results: [],
      events: [],
      eventSeq: 0,
      pacingMs: Math.max(0, Number(
        input.pacingMs === undefined
          ? (options.defaultPacingMs === undefined ? 0 : options.defaultPacingMs)
          : input.pacingMs
      ) || 0),
      summary: null,
      error: '',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: 0
    };
    jobs.set(job.id, job);
    queue.push(job);
    notify(job);
    emitEvent(job, {
      phase: TASK_EVENT_PHASES.QUEUED,
      tone: 'info',
      message: '已进入任务队列，等待执行',
      account: null
    });
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
  DEFAULT_TARGET_PACING_MS,
  createAccountActivityJobManager,
  isTerminalStatus,
  serializeJob,
  summarizeResults,
  targetKeyOf
};
