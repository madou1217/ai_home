'use strict';

const { createAppInstallJobManager } = require('./app-install-job-manager');
const { findDesktopClientRecord } = require('../cli/services/toolkit/app-manager');
const { getWebUiTaskHub } = require('./webui-task-hub');

const managersByState = new WeakMap();
let fallbackManager = null;

function createManagerFromContext(ctx = {}) {
  const deps = ctx.deps || {};
  const verifyDesktopInstall = typeof deps.verifyDesktopInstall === 'function'
    ? deps.verifyDesktopInstall
    : (provider, installOptions = {}) => findDesktopClientRecord(provider, {
      fs: ctx.fs || deps.fs,
      path: ctx.path || deps.path,
      env: ctx.env || deps.env,
      processObj: ctx.processObj || deps.processObj,
      spawnSync: ctx.spawnSync || deps.spawnSync,
      hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
      platform: installOptions.platform || ctx.platform || deps.platform
    });
  return createAppInstallJobManager({
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    env: ctx.env || deps.env,
    processObj: ctx.processObj || deps.processObj,
    spawn: ctx.spawn || deps.spawn,
    hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
    installCli: deps.installAppCli,
    runInstallPlan: deps.runInstallPlan,
    resolveDesktopInstallPlans: deps.resolveDesktopInstallPlans,
    taskHub: getWebUiTaskHub(ctx),
    verifyDesktopInstall
  });
}

function getAppInstallJobManager(ctx = {}) {
  const injected = ctx.deps && ctx.deps.appInstallJobManager;
  if (injected) return injected;
  if (ctx.state && typeof ctx.state === 'object') {
    const cached = managersByState.get(ctx.state);
    if (cached) return cached;
    const manager = createManagerFromContext(ctx);
    managersByState.set(ctx.state, manager);
    return manager;
  }
  if (!fallbackManager) fallbackManager = createManagerFromContext(ctx);
  return fallbackManager;
}

function startAppInstallJob(ctx, input = {}) {
  const manager = getAppInstallJobManager(ctx);
  if (!manager || typeof manager.start !== 'function') {
    return { ok: false, error: 'app_install_unavailable' };
  }
  const result = manager.start(input);
  return { ...result, manager };
}

function parseJobId(pathname) {
  const matches = String(pathname || '').match(/^\/v0\/webui\/app-install\/jobs\/([^/]+)(?:\/(watch|cancel))?$/);
  if (!matches) return null;
  try {
    return { jobId: decodeURIComponent(matches[1]), action: matches[2] || '' };
  } catch (_error) {
    return { invalid: true };
  }
}

function writeError(ctx, status, error, message) {
  ctx.writeJson(ctx.res, status, {
    ok: false,
    error,
    message: String(message || error)
  });
}

async function handleAppInstallJobRoutes(ctx) {
  const { method, pathname, req, res } = ctx;
  if (method === 'POST' && pathname === '/v0/webui/app-install') {
    const body = await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
      .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : {})
      .catch(() => null);
    if (!body) {
      writeError(ctx, 400, 'invalid_install_payload', '安装目标参数无效。');
      return true;
    }
    const started = startAppInstallJob(ctx, body);
    if (!started.ok) {
      writeError(ctx, 400, started.error, '无法创建安装任务。');
      return true;
    }
    ctx.writeJson(res, 202, {
      ok: true,
      accepted: true,
      alreadyRunning: Boolean(started.alreadyRunning),
      job: started.job
    });
    return true;
  }
  if (method === 'GET' && pathname === '/v0/webui/app-install/jobs') {
    const manager = getAppInstallJobManager(ctx);
    const jobs = typeof manager.listActiveJobs === 'function' ? manager.listActiveJobs() : [];
    ctx.writeJson(res, 200, { ok: true, jobs });
    return true;
  }
  const parsed = parseJobId(pathname);
  if (!parsed) return false;
  if (parsed.invalid) {
    writeError(ctx, 400, 'invalid_job_path', '安装任务路径无效。');
    return true;
  }
  const manager = getAppInstallJobManager(ctx);

  if (method === 'GET' && parsed.action === 'watch') {
    if (typeof manager.watchJob !== 'function' || !manager.watchJob(parsed.jobId, req, res)) {
      writeError(ctx, 404, 'job_not_found', '安装任务不存在或已清理。');
    }
    return true;
  }

  if (method === 'GET' && !parsed.action) {
    const job = typeof manager.getJob === 'function' ? manager.getJob(parsed.jobId) : null;
    if (!job) {
      writeError(ctx, 404, 'job_not_found', '安装任务不存在或已清理。');
      return true;
    }
    ctx.writeJson(res, 200, { ok: true, job });
    return true;
  }

  if (method === 'POST' && parsed.action === 'cancel') {
    const result = typeof manager.cancelJob === 'function'
      ? manager.cancelJob(parsed.jobId)
      : { ok: false, error: 'app_install_unavailable' };
    if (!result.ok) {
      writeError(ctx, result.error === 'job_not_found' ? 404 : 409, result.error, result.job && result.job.error);
      return true;
    }
    ctx.writeJson(res, 200, result);
    return true;
  }

  writeError(ctx, 405, 'method_not_allowed', '不支持的安装任务操作。');
  return true;
}

module.exports = {
  getAppInstallJobManager,
  handleAppInstallJobRoutes,
  startAppInstallJob
};
