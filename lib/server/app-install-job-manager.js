'use strict';

const crypto = require('node:crypto');
const { runInstallPlanAsync, installNativeCliWithProgress } = require('../cli/services/ai-cli/ensure-native-cli');
const {
  buildDesktopInstallHint,
  resolveDesktopInstallPlans
} = require('../cli/services/ai-cli/desktop-install-strategies');
const { getAppInstaller } = require('./app-installers');
const {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const JOB_RETENTION_MS = 30 * 60 * 1000;

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return kind === 'desktop' || kind === 'cli' ? kind : '';
}

function resolveInstallTarget(input = {}) {
  const appId = String(input.appId || '').trim().toLowerCase();
  let provider = normalizeProvider(input.provider);
  let kind = normalizeKind(input.kind);

  if (appId) {
    if (appId.endsWith('-desktop')) {
      provider = provider || appId.slice(0, -'-desktop'.length);
      kind = kind || 'desktop';
    } else {
      provider = provider || appId;
      kind = kind || 'cli';
    }
  }

  if (!provider || !kind) return null;
  return {
    appId: appId || (kind === 'desktop' ? `${provider}-desktop` : provider),
    provider,
    kind,
    key: `${kind}:${provider}`
  };
}

function sanitizeAttempt(attempt = {}) {
  return {
    id: String(attempt.id || '').trim(),
    label: String(attempt.label || '').trim(),
    ok: Boolean(attempt.ok),
    error: String(attempt.error || '').trim().slice(0, 500)
  };
}

function serializeJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: String(job.id || ''),
    appId: String(job.appId || ''),
    provider: String(job.provider || ''),
    kind: String(job.kind || ''),
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
          cliPath: String(job.result.cliPath || ''),
          executablePath: String(job.result.executablePath || '')
        }
      : null,
    error: String(job.error || '').slice(0, 500),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null
  };
}

function isTerminalJobStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());
}

function createAppInstallJobManager(options = {}) {
  const jobs = new Map();
  const activeByTarget = new Map();
  const watchersByJob = new Map();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const installCli = typeof options.installCli === 'function'
    ? options.installCli
    : installNativeCliWithProgress;
  const runPlan = typeof options.runInstallPlan === 'function'
    ? options.runInstallPlan
    : runInstallPlanAsync;

  function notify(job) {
    if (typeof options.onJobChanged === 'function') {
      try { options.onJobChanged(serializeJob(job)); } catch (_error) {}
    }
    const watchers = watchersByJob.get(job.id);
    if (watchers && watchers.size > 0) {
      broadcastSseJson(watchers, { type: 'install-job', job: serializeJob(job) }, {
        onWatcherRemoved: (watcher) => watchers.delete(watcher)
      });
    }
  }

  function setProgress(job, percent, label, phase) {
    job.progress = {
      percent: Math.max(0, Math.min(100, Number(percent) || 0)),
      label: String(label || job.progress.label || '')
    };
    if (phase) job.phase = String(phase);
    job.updatedAt = now();
    notify(job);
  }

  function prune() {
    const cutoff = now() - JOB_RETENTION_MS;
    for (const [id, job] of jobs) {
      if (!isTerminalJobStatus(job.status) || Number(job.finishedAt || 0) > cutoff) continue;
      jobs.delete(id);
    }
  }

  function resolveDefaultCliOptions(job, installOptions = {}) {
    return {
      ...options,
      ...installOptions,
      onPlanStart: (plan) => {
        setProgress(job, Math.max(5, job.progress.percent), String(plan && plan.label || '正在执行安装计划'), 'installing');
        installOptions.onPlanStart?.(plan);
      },
      onOutput: (chunk, stream, plan) => {
        installOptions.onOutput?.(chunk, stream, plan);
      },
      onPlanFinish: (attempt, plan) => {
        job.attempts.push(sanitizeAttempt(attempt));
        setProgress(job, attempt && attempt.ok ? 85 : 70, String(attempt && attempt.label || plan && plan.label || ''), 'installing');
        installOptions.onPlanFinish?.(attempt, plan);
      },
      onProgress: (progress) => {
        if (progress && typeof progress === 'object') {
          setProgress(job, progress.percent, progress.label, progress.phase || 'installing');
        }
        installOptions.onProgress?.(progress);
      }
    };
  }

  async function installDesktop(provider, installOptions = {}) {
    const plans = resolveDesktopInstallPlans(provider, {
      ...options,
      ...installOptions
    });
    if (plans.length === 0) {
      return {
        installed: false,
        installAttempts: [],
        error: buildDesktopInstallHint(provider, { ...options, ...installOptions })
      };
    }

    const attempts = [];
    for (const plan of plans) {
      installOptions.onPlanStart?.(plan);
      const outcome = await runPlan(plan, {
        ...options,
        ...installOptions,
        onOutput: installOptions.onOutput
      });
      const attempt = {
        id: plan.id,
        label: plan.label,
        ok: Boolean(outcome && outcome.ok),
        error: outcome && outcome.ok ? '' : String(outcome && (outcome.error || outcome.stderr) || `exit_${outcome && outcome.status}`)
      };
      attempts.push(attempt);
      installOptions.onPlanFinish?.(attempt, plan);
      if (attempt.ok) {
        return {
          installed: true,
          executablePath: String(installOptions.executablePath || ''),
          installAttempts: attempts
        };
      }
    }
    return { installed: false, installAttempts: attempts, error: attempts.map((item) => item.error).filter(Boolean).join('; ') };
  }

  async function run(job) {
    job.status = 'running';
    job.phase = 'installing';
    job.updatedAt = now();
    setProgress(job, 1, '安装任务已开始', 'installing');
    try {
      const installOptions = resolveDefaultCliOptions(job, {
        ...options,
        appId: job.appId,
        provider: job.provider,
        kind: job.kind
      });
      const providerInstaller = getAppInstaller(job.provider);
      if (!providerInstaller) {
        throw new Error(`provider_installer_unavailable:${job.provider}`);
      }
      const result = job.kind === 'desktop'
        ? await installDesktop(job.provider, installOptions)
        : await (typeof options.installCli === 'function'
          ? installCli(job.provider, installOptions)
          : providerInstaller.installCli(installOptions));
      const installed = Boolean(result && (result.installed || result.cliPath || result.executablePath));
      if (!installed) {
        job.status = 'failed';
        job.phase = 'failed';
        const attemptError = Array.isArray(result && result.installAttempts)
          ? result.installAttempts.map((attempt) => String(attempt && attempt.error || '').trim()).filter(Boolean).join('; ')
          : '';
        job.error = String(result && result.error || attemptError || '安装完成后未检测到目标应用。').slice(0, 500);
        if (Array.isArray(result && result.installAttempts)) {
          result.installAttempts.forEach((attempt) => {
            if (!job.attempts.some((item) => item.id === attempt.id && item.label === attempt.label)) {
              job.attempts.push(sanitizeAttempt(attempt));
            }
          });
        }
      } else {
        job.status = 'succeeded';
        job.phase = 'completed';
        job.result = {
          installed: true,
          cliPath: String(result.cliPath || ''),
          executablePath: String(result.executablePath || '')
        };
        job.error = '';
      }
    } catch (error) {
      job.status = 'failed';
      job.phase = 'failed';
      job.error = String(error && error.message || error || '安装失败').slice(0, 500);
    } finally {
      job.progress = {
        percent: job.status === 'succeeded' ? 100 : job.progress.percent,
        label: job.status === 'succeeded' ? '安装完成' : (job.error || '安装失败')
      };
      job.updatedAt = now();
      job.finishedAt = now();
      activeByTarget.delete(`${job.kind}:${job.provider}`);
      notify(job);
    }
  }

  function start(input = {}) {
    prune();
    const target = resolveInstallTarget(input);
    if (!target) return { ok: false, error: 'invalid_install_target' };
    const activeId = activeByTarget.get(target.key);
    if (activeId) {
      const active = jobs.get(activeId);
      if (active && !isTerminalJobStatus(active.status)) {
        return { ok: true, accepted: true, alreadyRunning: true, job: serializeJob(active) };
      }
      activeByTarget.delete(target.key);
    }

    const id = `app-install-${crypto.randomUUID()}`;
    const timestamp = now();
    const job = {
      id,
      ...target,
      status: 'queued',
      phase: 'queued',
      progress: { percent: 0, label: '等待安装任务开始' },
      attempts: [],
      result: null,
      error: '',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: 0
    };
    jobs.set(id, job);
    activeByTarget.set(target.key, id);
    notify(job);
    const timer = setImmediate(() => run(job).catch(() => {}));
    if (typeof timer.unref === 'function') timer.unref();
    return { ok: true, accepted: true, alreadyRunning: false, job: serializeJob(job) };
  }

  function getJob(jobId) {
    prune();
    return serializeJob(jobs.get(String(jobId || '').trim()) || null);
  }

  function cancelJob(jobId) {
    const job = jobs.get(String(jobId || '').trim());
    if (!job) return { ok: false, error: 'job_not_found', job: null };
    if (job.status !== 'queued') return { ok: false, error: 'job_not_cancellable', job: serializeJob(job) };
    job.status = 'cancelled';
    job.phase = 'cancelled';
    job.error = '安装任务已取消。';
    job.finishedAt = now();
    job.updatedAt = job.finishedAt;
    activeByTarget.delete(`${job.kind}:${job.provider}`);
    notify(job);
    return { ok: true, job: serializeJob(job) };
  }

  function canInstall(input = {}) {
    const target = resolveInstallTarget(input);
    if (!target) return false;
    const installer = getAppInstaller(target.provider);
    if (!installer) return false;
    if (target.kind === 'desktop') {
      return resolveDesktopInstallPlans(target.provider, {
        ...options,
        ...input
      }).length > 0;
    }
    return typeof installer.installCli === 'function';
  }

  function watchJob(jobId, req, res) {
    const normalizedId = String(jobId || '').trim();
    const job = jobs.get(normalizedId);
    if (!job) return false;
    openSseStream(res);
    writeSseJson(res, { type: 'connected', job: serializeJob(job) });
    const watchers = watchersByJob.get(normalizedId) || new Set();
    watchersByJob.set(normalizedId, watchers);
    attachSseWatcher(watchers, req, res, {
      heartbeatMs: 30_000,
      onWatcherRemoved: (watcher) => {
        watchers.delete(watcher);
        if (watchers.size === 0) watchersByJob.delete(normalizedId);
      }
    });
    writeSseJson(res, { type: 'install-job', job: serializeJob(job) });
    return true;
  }

  return {
    start,
    getJob,
    cancelJob,
    canInstall,
    watchJob,
    serializeJob,
    isTerminalJobStatus
  };
}

module.exports = {
  createAppInstallJobManager,
  isTerminalJobStatus,
  normalizeKind,
  normalizeProvider,
  resolveInstallTarget,
  serializeJob
};
