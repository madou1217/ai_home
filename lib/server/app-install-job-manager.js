'use strict';

const crypto = require('node:crypto');
const { runInstallPlanAsync, installNativeCliWithProgress } = require('../cli/services/ai-cli/ensure-native-cli');
const {
  buildDesktopInstallHint,
  resolveDesktopInstallPlans
} = require('../cli/services/ai-cli/desktop-install-strategies');
const { getAppInstaller } = require('./app-installers');
const { getProviderDefinition } = require('../provider-catalog');
const {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const LIFECYCLE_ACTIONS = new Set(['install', 'update', 'uninstall']);
const JOB_RETENTION_MS = 30 * 60 * 1000;

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return kind === 'desktop' || kind === 'cli' ? kind : '';
}

function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return LIFECYCLE_ACTIONS.has(action) ? action : 'install';
}

function actionLabel(action) {
  return ({ install: '安装', update: '更新', uninstall: '卸载' })[normalizeAction(action)] || '安装';
}

function resolveInstallTarget(input = {}) {
  const appId = String(input.appId || '').trim().toLowerCase();
  let provider = normalizeProvider(input.provider);
  let kind = normalizeKind(input.kind);
  const action = normalizeAction(input.action);

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
    action,
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

function isCliInstallSupported(provider, installer = getAppInstaller(provider)) {
  const definition = getProviderDefinition(provider);
  const standalone = installer && installer.managedApp && installer.managedApp.type === 'cli';
  return Boolean((definition && definition.clients && definition.clients.cli || standalone)
    && installer && typeof installer.installCli === 'function');
}

function serializeJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: String(job.id || ''),
    source: String(job.source || 'app-install'),
    taskName: String(job.taskName || ''),
    appId: String(job.appId || ''),
    provider: String(job.provider || ''),
    kind: String(job.kind || ''),
    action: normalizeAction(job.action),
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
  const taskHub = options.taskHub && typeof options.taskHub.publish === 'function'
    ? options.taskHub
    : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const installCli = typeof options.installCli === 'function'
    ? options.installCli
    : installNativeCliWithProgress;
  const runPlan = typeof options.runInstallPlan === 'function'
    ? options.runInstallPlan
    : runInstallPlanAsync;
  const verifyDesktopInstall = typeof options.verifyDesktopInstall === 'function'
    ? options.verifyDesktopInstall
    : null;
  // 安装/更新/卸载会改变宿主机的"已安装"事实，作业收尾必须让入口检测缓存失效，
  // 否则 WebUI 最多要等一个缓存周期才认出新装好的 CLI/Desktop（按钮停在旧态）。
  // 作业管理器不认识检测器实现，只回调注入的失效钩子。
  const invalidateAppEntries = typeof options.invalidateAppEntries === 'function'
    ? options.invalidateAppEntries
    : null;
  const verifyCliLifecycle = typeof options.verifyCliLifecycle === 'function'
    ? options.verifyCliLifecycle
    : null;

  function notify(job) {
    const serialized = serializeJob(job);
    if (typeof options.onJobChanged === 'function') {
      try { options.onJobChanged(serialized); } catch (_error) {}
    }
    taskHub?.publish(serialized);
    const watchers = watchersByJob.get(job.id);
    if (watchers && watchers.size > 0) {
      broadcastSseJson(watchers, { type: 'install-job', job: serialized }, {
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
        setProgress(job, Math.max(5, job.progress.percent), String(plan && plan.label || `正在执行${actionLabel(job.action)}计划`), 'installing');
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

  function resolveLifecyclePlans(provider, kind, action, installOptions = {}) {
    if (kind === 'desktop' && action === 'install' && typeof options.resolveDesktopInstallPlans === 'function') {
      return options.resolveDesktopInstallPlans(provider, { ...options, ...installOptions }).filter(Boolean);
    }
    const installer = getAppInstaller(provider);
    if (installer && typeof installer.resolveLifecyclePlans === 'function') {
      return installer.resolveLifecyclePlans(action, {
        ...options,
        ...installOptions,
        provider,
        kind
      }).filter(Boolean);
    }
    if (kind === 'desktop' && action === 'install') {
      return resolveDesktopInstallPlans(provider, { ...options, ...installOptions });
    }
    return [];
  }

  async function runLifecyclePlans(provider, kind, action, installOptions = {}) {
    const plans = resolveLifecyclePlans(provider, kind, action, installOptions);
    if (plans.length === 0) {
      return {
        installed: false,
        installAttempts: [],
        error: action === 'install' && kind === 'desktop'
          ? buildDesktopInstallHint(provider, { ...options, ...installOptions })
          : `当前${kind === 'desktop' ? '桌面客户端' : 'CLI'}没有可用的${actionLabel(action)}计划。`
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
      let verification = null;
      if (attempt.ok && kind === 'desktop' && verifyDesktopInstall) {
        try {
          verification = await verifyDesktopInstall(provider, {
            ...options,
            ...installOptions,
            plan,
            outcome
          });
        } catch (error) {
          verification = null;
          attempt.error = `${actionLabel(action)}命令已完成，但应用校验异常：${String(error && error.message || error || 'unknown_error')}`;
        }
        if (action === 'uninstall') {
          if (verification && !attempt.error) attempt.error = '卸载命令已完成，但目标 Desktop 应用仍可被探测到。';
          attempt.ok = Boolean(attempt.ok && !verification);
        } else {
          if (!verification && !attempt.error) {
            attempt.error = `${actionLabel(action)}命令已完成，但未检测到目标 Desktop 应用。`;
          }
          attempt.ok = Boolean(attempt.ok && verification);
        }
      }
      if (attempt.ok && kind === 'cli' && verifyCliLifecycle) {
        try {
          const verified = await verifyCliLifecycle(provider, action, {
            ...options,
            ...installOptions,
            plan,
            outcome
          });
          if (!verified && action === 'uninstall') attempt.error = '卸载命令已完成，但 CLI 仍可被探测到。';
          if (!verified && action !== 'uninstall') attempt.error = `${actionLabel(action)}命令已完成，但 CLI 校验失败。`;
          attempt.ok = Boolean(attempt.ok && verified);
        } catch (error) {
          attempt.ok = false;
          attempt.error = `${actionLabel(action)}命令已完成，但 CLI 校验异常：${String(error && error.message || error || 'unknown_error')}`;
        }
      }
      attempts.push(attempt);
      installOptions.onPlanFinish?.(attempt, plan);
      if (attempt.ok) {
        return {
          installed: action !== 'uninstall',
          executablePath: String(
            installOptions.executablePath
              || verification && (verification.executablePath || verification.displayPath)
              || ''
          ),
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
    setProgress(job, 1, `${actionLabel(job.action)}任务已开始`, 'installing');
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
      if (job.kind === 'cli' && !isCliInstallSupported(job.provider, providerInstaller)) {
        throw new Error(`cli_not_supported:${job.provider}`);
      }
      const result = job.action === 'install'
        ? (job.kind === 'desktop'
          ? await runLifecyclePlans(job.provider, job.kind, job.action, installOptions)
          : await (typeof options.installCli === 'function'
            ? installCli(job.provider, installOptions)
            : providerInstaller.installCli(installOptions)))
        : await runLifecyclePlans(job.provider, job.kind, job.action, installOptions);
      const installed = job.action === 'uninstall'
        ? Boolean(result && result.installed === false && !result.error)
        : Boolean(result && (result.installed || result.cliPath || result.executablePath));
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
          installed: job.action !== 'uninstall',
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
        label: job.status === 'succeeded' ? `${actionLabel(job.action)}完成` : (job.error || `${actionLabel(job.action)}失败`)
      };
      job.updatedAt = now();
      job.finishedAt = now();
      activeByTarget.delete(`${job.kind}:${job.provider}`);
      // 失败/取消同样要失效：安装脚本可能已经落了一半文件，缓存里的旧结论不可信。
      if (invalidateAppEntries) {
        try {
          invalidateAppEntries({ provider: job.provider, kind: job.kind, action: job.action, status: job.status });
        } catch (_error) {
          // 缓存失效失败不影响作业本身的终态上报。
        }
      }
      notify(job);
    }
  }

  function start(input = {}) {
    prune();
    const target = resolveInstallTarget(input);
    if (!target) return { ok: false, error: 'invalid_install_target' };
    const installer = getAppInstaller(target.provider);
    if (target.kind === 'cli' && !isCliInstallSupported(target.provider, installer)) {
      return { ok: false, error: 'cli_not_supported' };
    }
    if (!canInstall(input)) return { ok: false, error: `${target.action}_not_supported` };
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
      source: 'app-install',
      taskName: `${target.provider} ${target.kind === 'desktop' ? 'Desktop' : 'CLI'} ${actionLabel(target.action)}`,
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

  function listActiveJobs() {
    prune();
    return [...jobs.values()]
      .filter((job) => !isTerminalJobStatus(job.status))
      .map(serializeJob)
      .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
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
      return resolveLifecyclePlans(target.provider, target.kind, target.action, { ...options, ...input }).length > 0;
    }
    if (!isCliInstallSupported(target.provider, installer)) return false;
    if (target.action === 'install') return true;
    return resolveLifecyclePlans(target.provider, target.kind, target.action, { ...options, ...input }).length > 0;
  }

  function plan(input = {}) {
    const target = resolveInstallTarget(input);
    if (!target) return { ok: false, error: 'invalid_install_target' };
    const installer = getAppInstaller(target.provider);
    if (!installer) return { ok: false, error: 'provider_installer_unavailable' };
    if (!canInstall(input)) return { ok: false, error: `${target.action}_not_supported` };
    const plans = target.action === 'install' && target.kind === 'cli'
      ? (typeof installer.resolveCliInstallPlans === 'function'
        ? installer.resolveCliInstallPlans({ ...options, ...input })
        : [])
      : resolveLifecyclePlans(target.provider, target.kind, target.action, { ...options, ...input });
    return {
      ok: true,
      ...target,
      label: `${target.provider} ${actionLabel(target.action)}`,
      plans: (plans || []).map((candidate) => ({
        id: String(candidate.id || ''),
        label: String(candidate.label || ''),
        command: String(candidate.command || ''),
        args: Array.isArray(candidate.args) ? candidate.args : []
      }))
    };
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

  taskHub?.registerSource('app-install', listActiveJobs);

  return {
    start,
    getJob,
    listActiveJobs,
    cancelJob,
    canInstall,
    plan,
    watchJob,
    serializeJob,
    isTerminalJobStatus
  };
}

module.exports = {
  createAppInstallJobManager,
  isTerminalJobStatus,
  normalizeAction,
  normalizeKind,
  normalizeProvider,
  resolveInstallTarget,
  serializeJob
};
