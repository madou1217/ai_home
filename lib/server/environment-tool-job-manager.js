'use strict';

const crypto = require('node:crypto');
const { planEnvironmentToolAction } = require('../cli/services/toolkit/environment/lifecycle');
const { executeEnvironmentPlan } = require('../cli/services/toolkit/environment/plan-executor');
const { getEnvironmentToolAdapter } = require('../cli/services/toolkit/environment/tools');
const {
  attachSseWatcher,
  broadcastSseJson,
  openSseStream,
  writeSseJson
} = require('./webui-sse-broadcaster');

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const JOB_RETENTION_MS = 30 * 60 * 1000;

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());
}

function sanitizeAttempt(attempt = {}) {
  return {
    id: String(attempt.id || '').trim(),
    label: String(attempt.label || '').trim(),
    ok: Boolean(attempt.ok),
    error: String(attempt.error || '').trim().slice(0, 500)
  };
}

function serializeEnvironmentJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: String(job.id || ''),
    source: 'environment',
    taskName: String(job.taskName || ''),
    appId: String(job.toolId || ''),
    provider: String(job.toolId || ''),
    toolId: String(job.toolId || ''),
    kind: 'environment',
    platform: String(job.platform || ''),
    action: String(job.action || ''),
    status: String(job.status || ''),
    phase: String(job.phase || ''),
    progress: {
      percent: Math.max(0, Math.min(100, Number(job.progress && job.progress.percent) || 0)),
      label: String(job.progress && job.progress.label || '')
    },
    attempts: Array.isArray(job.attempts) ? job.attempts.map(sanitizeAttempt) : [],
    result: job.result && typeof job.result === 'object'
      ? {
          installed: Boolean(job.result.installed),
          executablePath: String(job.result.executablePath || ''),
          version: String(job.result.version || '')
        }
      : null,
    error: String(job.error || '').slice(0, 500),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null
  };
}

function desiredStateReached(action, observed) {
  return action === 'uninstall' ? !observed.installed : observed.installed;
}

function createEnvironmentToolJobManager(options = {}) {
  const jobs = new Map();
  const activeByTool = new Map();
  const watchersByJob = new Map();
  const taskHub = options.taskHub && typeof options.taskHub.publish === 'function'
    ? options.taskHub
    : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const planAction = typeof options.planAction === 'function'
    ? options.planAction
    : planEnvironmentToolAction;
  const runPlan = typeof options.runPlan === 'function'
    ? options.runPlan
    : executeEnvironmentPlan;
  const probeTool = typeof options.probeTool === 'function'
    ? options.probeTool
    : (toolId) => getEnvironmentToolAdapter(toolId)?.detect(options)
      || { installed: false, version: '', executablePath: '', managedVersions: [] };

  function prune() {
    const cutoff = now() - JOB_RETENTION_MS;
    for (const [id, job] of jobs) {
      if (!isTerminalStatus(job.status) || Number(job.finishedAt || 0) > cutoff) continue;
      jobs.delete(id);
    }
  }

  function notify(job) {
    const serialized = serializeEnvironmentJob(job);
    try { options.onJobChanged?.(serialized); } catch (_error) {}
    taskHub?.publish(serialized);
    const watchers = watchersByJob.get(job.id);
    if (!watchers || watchers.size === 0) return;
    broadcastSseJson(watchers, { type: 'environment-job', job: serialized }, {
      onWatcherRemoved: (watcher) => watchers.delete(watcher)
    });
  }

  function setProgress(job, percent, label, phase = job.phase) {
    job.progress = {
      percent: Math.max(0, Math.min(100, Number(percent) || 0)),
      label: String(label || job.progress.label || '')
    };
    job.phase = String(phase || job.phase || 'running');
    job.updatedAt = now();
    notify(job);
  }

  function verifyPlanResult(job, plan, outcome) {
    if (!outcome || !outcome.ok) {
      return {
        attempt: sanitizeAttempt({
          id: plan.id,
          label: plan.label,
          ok: false,
          error: outcome && (outcome.message || outcome.error || outcome.stderr) || 'environment_action_failed'
        }),
        observed: null
      };
    }
    try {
      const observed = probeTool(job.toolId, { ...options, plan, outcome });
      const ok = Boolean(observed && desiredStateReached(job.action, observed));
      return {
        attempt: sanitizeAttempt({
          id: plan.id,
          label: plan.label,
          ok,
          error: ok ? '' : `${plan.label} 已执行，但工具状态校验未达到预期。`
        }),
        observed
      };
    } catch (error) {
      return {
        attempt: sanitizeAttempt({
          id: plan.id,
          label: plan.label,
          ok: false,
          error: `${plan.label} 已执行，但工具状态校验失败：${String(error && error.message || error)}`
        }),
        observed: null
      };
    }
  }

  async function run(job) {
    job.status = 'running';
    setProgress(job, 5, `${job.taskName}已开始`, 'executing');
    try {
      for (let index = 0; index < job.plans.length; index += 1) {
        const plan = job.plans[index];
        const percent = 10 + Math.round((index / Math.max(job.plans.length, 1)) * 70);
        setProgress(job, percent, plan.label || job.taskName, 'executing');
        const outcome = await runPlan(plan, {
          ...options,
          onOutput: (chunk, stream) => options.onOutput?.(chunk, stream, plan, job)
        });
        const verified = verifyPlanResult(job, plan, outcome);
        job.attempts.push(verified.attempt);
        if (!verified.attempt.ok) continue;
        job.status = 'succeeded';
        job.phase = 'completed';
        job.result = {
          installed: job.action !== 'uninstall',
          executablePath: String(verified.observed && verified.observed.executablePath || ''),
          version: String(verified.observed && verified.observed.version || '')
        };
        job.error = '';
        break;
      }
      if (job.status !== 'succeeded') {
        job.status = 'failed';
        job.phase = 'failed';
        job.error = job.attempts.map((attempt) => attempt.error).filter(Boolean).join('; ') || '运行环境操作失败。';
      }
    } catch (error) {
      job.status = 'failed';
      job.phase = 'failed';
      job.error = String(error && error.message || error || '运行环境操作失败。').slice(0, 500);
    } finally {
      job.progress = {
        percent: job.status === 'succeeded' ? 100 : job.progress.percent,
        label: job.status === 'succeeded' ? `${job.taskName}完成` : (job.error || `${job.taskName}失败`)
      };
      job.updatedAt = now();
      job.finishedAt = now();
      activeByTool.delete(job.toolId);
      notify(job);
    }
  }

  function start(input = {}) {
    prune();
    if (input.confirmed !== true) return { ok: false, error: 'confirmation_required' };
    const planned = planAction(input, options);
    if (!planned.ok) return planned;
    const toolId = String(planned.tool && planned.tool.id || input.toolId || '').trim().toLowerCase();
    const activeId = activeByTool.get(toolId);
    if (activeId) {
      const active = jobs.get(activeId);
      if (active && !isTerminalStatus(active.status)) {
        return { ok: true, accepted: true, alreadyRunning: true, job: serializeEnvironmentJob(active) };
      }
      activeByTool.delete(toolId);
    }

    const timestamp = now();
    const job = {
      id: `environment-action-${crypto.randomUUID()}`,
      source: 'environment',
      taskName: String(planned.label || `${planned.action} ${planned.tool.name}`),
      toolId,
      action: planned.action,
      platform: planned.platform,
      plans: planned.plans.map((plan) => ({ ...plan, args: [...plan.args], env: { ...plan.env } })),
      status: 'queued',
      phase: 'queued',
      progress: { percent: 0, label: '等待运行环境操作开始' },
      attempts: [],
      result: null,
      error: '',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: 0
    };
    jobs.set(job.id, job);
    activeByTool.set(toolId, job.id);
    notify(job);
    const timer = setImmediate(() => run(job).catch(() => {}));
    if (typeof timer.unref === 'function') timer.unref();
    return { ok: true, accepted: true, alreadyRunning: false, job: serializeEnvironmentJob(job) };
  }

  function getJob(jobId) {
    prune();
    return serializeEnvironmentJob(jobs.get(String(jobId || '').trim()) || null);
  }

  function listActiveJobs() {
    prune();
    return [...jobs.values()]
      .filter((job) => !isTerminalStatus(job.status))
      .map(serializeEnvironmentJob)
      .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  }

  function cancelJob(jobId) {
    const job = jobs.get(String(jobId || '').trim());
    if (!job) return { ok: false, error: 'job_not_found', job: null };
    if (job.status !== 'queued') return { ok: false, error: 'job_not_cancellable', job: serializeEnvironmentJob(job) };
    job.status = 'cancelled';
    job.phase = 'cancelled';
    job.error = '运行环境任务已取消。';
    job.finishedAt = now();
    job.updatedAt = job.finishedAt;
    activeByTool.delete(job.toolId);
    notify(job);
    return { ok: true, job: serializeEnvironmentJob(job) };
  }

  function watchJob(jobId, req, res) {
    const normalizedId = String(jobId || '').trim();
    const job = jobs.get(normalizedId);
    if (!job) return false;
    openSseStream(res);
    writeSseJson(res, { type: 'connected', job: serializeEnvironmentJob(job) });
    const watchers = watchersByJob.get(normalizedId) || new Set();
    watchersByJob.set(normalizedId, watchers);
    attachSseWatcher(watchers, req, res, {
      heartbeatMs: 30_000,
      onWatcherRemoved: (watcher) => {
        watchers.delete(watcher);
        if (watchers.size === 0) watchersByJob.delete(normalizedId);
      }
    });
    writeSseJson(res, { type: 'environment-job', job: serializeEnvironmentJob(job) });
    return true;
  }

  taskHub?.registerSource('environment', listActiveJobs);

  return {
    cancelJob,
    getJob,
    isTerminalJobStatus: isTerminalStatus,
    listActiveJobs,
    serializeJob: serializeEnvironmentJob,
    start,
    watchJob
  };
}

module.exports = {
  createEnvironmentToolJobManager,
  desiredStateReached,
  isTerminalStatus,
  serializeEnvironmentJob
};
