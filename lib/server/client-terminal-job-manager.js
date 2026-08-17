'use strict';

const crypto = require('node:crypto');
const {
  executeTerminalPlan,
  resolveTerminalActionPlan
} = require('../runtime/client-terminal');

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const JOB_RETENTION_MS = 30 * 60 * 1000;

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());
}

function serializeTerminalJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: String(job.id || ''),
    source: 'terminal',
    taskName: String(job.taskName || ''),
    appId: String(job.appId || ''),
    provider: String(job.provider || ''),
    kind: 'terminal',
    action: String(job.action || ''),
    status: String(job.status || ''),
    phase: String(job.phase || ''),
    progress: {
      percent: Math.max(0, Math.min(100, Number(job.progress && job.progress.percent) || 0)),
      label: String(job.progress && job.progress.label || '')
    },
    attempts: [],
    result: job.result && typeof job.result === 'object'
      ? { installed: Boolean(job.result.ok), executablePath: '' }
      : null,
    error: String(job.error || '').slice(0, 500),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null
  };
}

function createClientTerminalJobManager(options = {}) {
  const jobs = new Map();
  const activeByTarget = new Map();
  const watchersByJob = new Map();
  const taskHub = options.taskHub && typeof options.taskHub.publish === 'function'
    ? options.taskHub
    : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  function prune() {
    const cutoff = now() - JOB_RETENTION_MS;
    for (const [id, job] of jobs) {
      if (!isTerminalStatus(job.status) || Number(job.finishedAt || 0) > cutoff) continue;
      jobs.delete(id);
    }
  }

  function notify(job) {
    const serialized = serializeTerminalJob(job);
    try { options.onJobChanged?.(serialized); } catch (_error) {}
    taskHub?.publish(serialized);
    const watchers = watchersByJob.get(job.id);
    if (watchers && watchers.size > 0) {
      const { broadcastSseJson } = require('./webui-sse-broadcaster');
      broadcastSseJson(watchers, { type: 'terminal-job', job: serialized }, {
        onWatcherRemoved: (watcher) => watchers.delete(watcher)
      });
    }
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

  function listActiveJobs() {
    prune();
    return [...jobs.values()]
      .filter((job) => !isTerminalStatus(job.status))
      .map(serializeTerminalJob)
      .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  }

  async function run(job) {
    job.status = 'running';
    job.phase = 'executing';
    job.updatedAt = now();
    setProgress(job, 10, '正在执行官方终端命令', 'executing');
    try {
      const result = await executeTerminalPlan(job.plan, options);
      if (!result || !result.ok) {
        job.status = 'failed';
        job.phase = 'failed';
        job.error = String(result && result.error || '终端命令执行失败').slice(0, 500);
      } else {
        job.status = 'succeeded';
        job.phase = 'completed';
        job.result = { ok: true };
        job.error = '';
      }
    } catch (error) {
      job.status = 'failed';
      job.phase = 'failed';
      job.error = String(error && error.message || error || '终端命令执行失败').slice(0, 500);
    } finally {
      job.progress = {
        percent: job.status === 'succeeded' ? 100 : job.progress.percent,
        label: job.status === 'succeeded' ? '终端操作完成' : (job.error || '终端操作失败')
      };
      job.updatedAt = now();
      job.finishedAt = now();
      activeByTarget.delete(`${job.terminalId}:${job.action}`);
      notify(job);
    }
  }

  function start(input = {}) {
    if (input.confirmed !== true) return { ok: false, error: 'confirmation_required' };
    const terminalId = String(input.terminalId || '').trim().toLowerCase();
    const action = String(input.action || '').trim().toLowerCase();
    const plan = resolveTerminalActionPlan({ terminalId, action }, options);
    if (!plan.ok) return plan;
    const targetKey = `${terminalId}:${action}`;
    const activeId = activeByTarget.get(targetKey);
    if (activeId) {
      const active = jobs.get(activeId);
      if (active && !isTerminalStatus(active.status)) {
        return { ok: true, accepted: true, alreadyRunning: true, job: serializeTerminalJob(active) };
      }
      activeByTarget.delete(targetKey);
    }
    const timestamp = now();
    const job = {
      id: `terminal-action-${crypto.randomUUID()}`,
      source: 'terminal',
      taskName: String(plan.label || `${action} ${terminalId}`),
      appId: terminalId,
      provider: terminalId,
      terminalId,
      action,
      kind: 'terminal',
      plan: { file: plan.file, args: [...(plan.args || [])] },
      status: 'queued',
      phase: 'queued',
      progress: { percent: 0, label: '等待终端操作开始' },
      result: null,
      error: '',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: 0
    };
    jobs.set(job.id, job);
    activeByTarget.set(targetKey, job.id);
    notify(job);
    const timer = setImmediate(() => run(job).catch(() => {}));
    if (typeof timer.unref === 'function') timer.unref();
    return { ok: true, accepted: true, alreadyRunning: false, job: serializeTerminalJob(job) };
  }

  function getJob(jobId) {
    prune();
    return serializeTerminalJob(jobs.get(String(jobId || '').trim()) || null);
  }

  function watchJob(jobId, req, res) {
    const normalizedId = String(jobId || '').trim();
    const job = jobs.get(normalizedId);
    if (!job) return false;
    const { openSseStream, writeSseJson, attachSseWatcher } = require('./webui-sse-broadcaster');
    openSseStream(res);
    writeSseJson(res, { type: 'connected', job: serializeTerminalJob(job) });
    const watchers = watchersByJob.get(normalizedId) || new Set();
    watchersByJob.set(normalizedId, watchers);
    attachSseWatcher(watchers, req, res, {
      heartbeatMs: 30_000,
      onWatcherRemoved: (watcher) => {
        watchers.delete(watcher);
        if (watchers.size === 0) watchersByJob.delete(normalizedId);
      }
    });
    writeSseJson(res, { type: 'terminal-job', job: serializeTerminalJob(job) });
    return true;
  }

  taskHub?.registerSource('terminal', listActiveJobs);

  return {
    start,
    getJob,
    listActiveJobs,
    watchJob,
    serializeJob: serializeTerminalJob,
    isTerminalJobStatus: isTerminalStatus
  };
}

module.exports = {
  createClientTerminalJobManager,
  isTerminalStatus,
  serializeTerminalJob
};
