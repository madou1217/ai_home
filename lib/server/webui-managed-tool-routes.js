'use strict';

const { planManagedToolAction } = require('../cli/services/toolkit/tool-manager');
const { createManagedToolJobManager } = require('./managed-tool-job-manager');
const { getWebUiTaskHub } = require('./webui-task-hub');

const managersByState = new WeakMap();
let fallbackManager = null;

function buildManagedToolOptions(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    ...ctx,
    ...deps,
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    os: ctx.os || deps.os,
    env: ctx.env || deps.env,
    processObj: ctx.processObj || deps.processObj,
    spawnSync: ctx.spawnSync || deps.spawnSync,
    spawn: ctx.spawn || deps.spawn,
    hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
    platform: ctx.platform || deps.platform,
    arch: ctx.arch || deps.arch,
    networkRuntime: ctx.networkRuntime || deps.networkRuntime,
    resolveCommandPath: ctx.resolveCommandPath || deps.resolveCommandPath,
    actionTimeoutMs: ctx.actionTimeoutMs || deps.actionTimeoutMs,
    maxOutputBytes: ctx.maxOutputBytes || deps.maxOutputBytes
  };
}

function createManagerFromContext(ctx = {}) {
  const deps = ctx.deps || {};
  return createManagedToolJobManager({
    ...buildManagedToolOptions(ctx),
    taskHub: getWebUiTaskHub(ctx),
    planAction: deps.planManagedToolAction,
    runPlan: deps.runManagedToolPlan,
    probeTool: deps.probeManagedTool,
    onOutput: deps.onManagedToolOutput,
    onJobChanged: deps.onManagedToolJobChanged
  });
}

function getManagedToolJobManager(ctx = {}) {
  const injected = ctx.deps && ctx.deps.managedToolJobManager;
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

function readRequestStream(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) return reject(new Error('managed_tool_payload_too_large'));
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(ctx) {
  try {
    const maxBytes = 64 * 1024;
    const injected = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes })
      : null;
    const buffer = injected == null ? await readRequestStream(ctx.req, maxBytes) : injected;
    return buffer ? JSON.parse(buffer.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function resultStatus(result) {
  if (result && result.ok) return 200;
  const error = String(result && result.error || '');
  if (error === 'confirmation_required') return 428;
  if (error === 'managed_tool_not_found' || error === 'job_not_found') return 404;
  if (error === 'managed_tool_already_installed' || error === 'managed_tool_not_installed'
    || error === 'managed_tool_action_unavailable' || error === 'job_not_cancellable') return 409;
  if (error === 'managed_tool_action_timeout') return 504;
  if (error === 'managed_tool_action_failed' || error === 'managed_tool_action_spawn_failed') return 502;
  if (error.startsWith('invalid_') || error.startsWith('unsupported_')) return 400;
  return 500;
}

function writeResult(ctx, result, successStatus = 200) {
  const status = result && result.ok ? successStatus : resultStatus(result);
  if (typeof ctx.writeJson === 'function') ctx.writeJson(ctx.res, status, result);
  else {
    ctx.res.writeHead(status, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify(result));
  }
}

function parseJobPath(pathname) {
  const matches = String(pathname || '').match(/^\/v0\/webui\/toolkit\/tools\/jobs\/([^/]+)(?:\/(watch|cancel))?$/);
  if (!matches) return null;
  try {
    return { jobId: decodeURIComponent(matches[1]), action: matches[2] || '' };
  } catch (_error) {
    return { invalid: true };
  }
}

async function handleJobRoute(ctx, parsed) {
  if (parsed.invalid) {
    writeResult(ctx, { ok: false, error: 'invalid_job_path', message: '网络工具任务路径无效。' });
    return true;
  }
  const manager = getManagedToolJobManager(ctx);
  if (ctx.method === 'GET' && parsed.action === 'watch') {
    if (!manager.watchJob?.(parsed.jobId, ctx.req, ctx.res)) {
      writeResult(ctx, { ok: false, error: 'job_not_found', message: '网络工具任务不存在或已清理。' });
    }
    return true;
  }
  if (ctx.method === 'GET' && !parsed.action) {
    const job = manager.getJob?.(parsed.jobId) || null;
    writeResult(ctx, job
      ? { ok: true, job }
      : { ok: false, error: 'job_not_found', message: '网络工具任务不存在或已清理。' });
    return true;
  }
  if (ctx.method === 'POST' && parsed.action === 'cancel') {
    writeResult(ctx, manager.cancelJob?.(parsed.jobId) || { ok: false, error: 'job_not_cancellable' });
    return true;
  }
  writeResult(ctx, { ok: false, error: 'unsupported_managed_tool_job_action', message: '不支持的网络工具任务操作。' });
  return true;
}

async function handleWebUiManagedToolRoutes(req, res, method, pathname, ctx = {}) {
  const routeCtx = { ...ctx, req, res, method, pathname };
  if (method === 'POST' && pathname === '/v0/webui/toolkit/tools/plan') {
    const body = await readJsonBody(routeCtx);
    if (!body) {
      writeResult(routeCtx, { ok: false, error: 'invalid_managed_tool_payload', message: '网络工具参数无效。' });
      return true;
    }
    const planner = ctx.deps && typeof ctx.deps.planManagedToolAction === 'function'
      ? ctx.deps.planManagedToolAction
      : planManagedToolAction;
    writeResult(routeCtx, planner(body, buildManagedToolOptions(ctx)));
    return true;
  }
  if (method === 'POST' && pathname === '/v0/webui/toolkit/tools/execute') {
    const body = await readJsonBody(routeCtx);
    if (!body) {
      writeResult(routeCtx, { ok: false, error: 'invalid_managed_tool_payload', message: '网络工具参数无效。' });
      return true;
    }
    writeResult(routeCtx, getManagedToolJobManager(ctx).start(body), 202);
    return true;
  }
  if (method === 'GET' && pathname === '/v0/webui/toolkit/tools/jobs') {
    const jobs = getManagedToolJobManager(ctx).listActiveJobs?.() || [];
    writeResult(routeCtx, { ok: true, jobs });
    return true;
  }
  const parsed = parseJobPath(pathname);
  if (parsed) return handleJobRoute(routeCtx, parsed);
  return false;
}

module.exports = {
  buildManagedToolOptions,
  getManagedToolJobManager,
  handleWebUiManagedToolRoutes,
  parseJobPath,
  resultStatus
};
