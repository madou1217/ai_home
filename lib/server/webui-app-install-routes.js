'use strict';

// 统一的 CLI/Desktop 安装任务路由 —— 全部任务状态机、执行与 SSE 流已迁至 Go Core（零回落）。
// 仅保留 getAppInstallJobManager 只读兼容导出，供尚未全量迁 Go 的 webui-account-routes.js 调用 canInstall()。

const { proxyWebuiGo } = require('./webui-go-proxy');
const {
  buildRouteCtx,
  pipeWebuiSseStream,
  readJsonBody
} = require('./webui-managed-tool-routes');
const { createAppInstallJobManager } = require('./app-install-job-manager');
const { resolveAiHomeDir } = require('./webui-account-routes-utils');

const APP_INSTALL_PASS_STATUSES = [400, 404, 405, 409, 413, 500];
const managersByState = new WeakMap();
let fallbackManager = null;

function createCanInstallCompatManager(ctx = {}) {
  const deps = ctx.deps || {};
  return createAppInstallJobManager({
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    env: ctx.env || deps.env,
    processObj: ctx.processObj || deps.processObj,
    hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
    aiHomeDir: resolveAiHomeDir(ctx)
  });
}

function getAppInstallJobManager(ctx = {}) {
  const injected = ctx.deps && ctx.deps.appInstallJobManager;
  if (injected) return injected;
  if (ctx.state && typeof ctx.state === 'object') {
    const cached = managersByState.get(ctx.state);
    if (cached) return cached;
    const manager = createCanInstallCompatManager(ctx);
    managersByState.set(ctx.state, manager);
    return manager;
  }
  if (!fallbackManager) fallbackManager = createCanInstallCompatManager(ctx);
  return fallbackManager;
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

async function handleAppInstallJobRoutes(ctx = {}) {
  const routeCtx = buildRouteCtx(ctx);
  const { method, pathname } = routeCtx;

  if (method === 'POST' && pathname === '/v0/webui/app-install') {
    const body = await readJsonBody(routeCtx, {
      invalidCode: 'invalid_install_payload',
      invalidMessage: '安装目标参数无效。'
    });
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/app-install',
      body,
      status: 202,
      passStatuses: APP_INSTALL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法创建安装任务'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/app-install/jobs') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: '/v1/management/webui/app-install/jobs',
      passStatuses: APP_INSTALL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取安装任务列表'
    });
  }

  const parsed = parseJobId(pathname);
  if (!parsed) return false;
  if (parsed.invalid) {
    routeCtx.writeJson(routeCtx.res, 400, {
      ok: false,
      error: 'invalid_job_path',
      message: '安装任务路径无效。'
    });
    return true;
  }

  const jobPath = `/v1/management/webui/app-install/jobs/${encodeURIComponent(parsed.jobId)}`;
  if (method === 'GET' && parsed.action === 'watch') {
    return pipeWebuiSseStream(routeCtx, `${jobPath}/watch`, 'Go Core 未就绪，安装任务事件流不可用');
  }
  if (method === 'GET' && !parsed.action) {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: jobPath,
      passStatuses: APP_INSTALL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取安装任务'
    });
  }
  if (method === 'POST' && parsed.action === 'cancel') {
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: `${jobPath}/cancel`,
      passStatuses: APP_INSTALL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法取消安装任务'
    });
  }

  routeCtx.writeJson(routeCtx.res, 405, {
    ok: false,
    error: 'method_not_allowed',
    message: '不支持的安装任务操作。'
  });
  return true;
}

module.exports = {
  getAppInstallJobManager,
  handleAppInstallJobRoutes
};
