'use strict';

const { getEnvironmentsSummary } = require('../cli/services/toolkit/environment/resource-manager');
const { buildEnvironmentGuide } = require('../cli/services/toolkit/environment/guide-builder');
const { planEnvironmentToolAction } = require('../cli/services/toolkit/environment/lifecycle');
const {
  executeEnvironmentAction,
  planEnvironmentAction
} = require('../cli/services/toolkit/environment/version-action-manager');
const { createEnvironmentToolJobManager } = require('./environment-tool-job-manager');
const { getWebUiTaskHub } = require('./webui-task-hub');

const managersByState = new WeakMap();
let fallbackManager = null;

function buildEnvironmentOptions(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    os: ctx.os || deps.os,
    env: ctx.env || deps.env,
    processObj: ctx.processObj || deps.processObj,
    spawnSync: ctx.spawnSync || deps.spawnSync,
    spawn: ctx.spawn || deps.spawn,
    hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
    platform: ctx.platform || deps.platform,
    cwd: ctx.cwd || deps.cwd,
    actionTimeoutMs: ctx.actionTimeoutMs || deps.actionTimeoutMs,
    maxOutputBytes: ctx.maxOutputBytes || deps.maxOutputBytes
  };
}

function createManagerFromContext(ctx = {}) {
  const deps = ctx.deps || {};
  return createEnvironmentToolJobManager({
    ...buildEnvironmentOptions(ctx),
    taskHub: getWebUiTaskHub(ctx),
    planAction: deps.planEnvironmentToolAction,
    runPlan: deps.runEnvironmentToolPlan,
    probeTool: deps.probeEnvironmentTool,
    onOutput: deps.onEnvironmentToolOutput,
    onJobChanged: deps.onEnvironmentToolJobChanged
  });
}

function getEnvironmentToolJobManager(ctx = {}) {
  const injected = ctx.deps && ctx.deps.environmentToolJobManager;
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
      if (size > maxBytes) {
        reject(new Error('environment_payload_too_large'));
        return;
      }
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
  if (error === 'environment_tool_not_found' || error === 'job_not_found') return 404;
  if (error === 'environment_tool_already_installed' || error === 'environment_tool_not_installed' || error === 'job_not_cancellable') return 409;
  if (error === 'environment_action_timeout') return 504;
  if (error === 'environment_action_failed' || error === 'environment_action_spawn_failed') return 502;
  if (error.startsWith('invalid_') || error.startsWith('unsupported_') || error === 'environment_tool_action_unavailable') return 400;
  return 500;
}

function writeResult(ctx, result, successStatus = 200) {
  ctx.writeJson(ctx.res, result && result.ok ? successStatus : resultStatus(result), result);
}

function parseJobPath(pathname) {
  const matches = String(pathname || '').match(/^\/v0\/webui\/toolkit\/environments\/jobs\/([^/]+)(?:\/(watch|cancel))?$/);
  if (!matches) return null;
  try {
    return { jobId: decodeURIComponent(matches[1]), action: matches[2] || '' };
  } catch (_error) {
    return { invalid: true };
  }
}

async function handleEnvironmentPlan(ctx) {
  const body = await readJsonBody(ctx);
  if (!body) {
    writeResult(ctx, { ok: false, error: 'invalid_environment_payload', message: '运行环境参数无效。' });
    return true;
  }
  const options = buildEnvironmentOptions(ctx);
  const result = String(body.toolId || '').trim()
    ? planEnvironmentToolAction(body, options)
    : planEnvironmentAction(body, options);
  writeResult(ctx, result);
  return true;
}

async function handleEnvironmentExecute(ctx) {
  const body = await readJsonBody(ctx);
  if (!body) {
    writeResult(ctx, { ok: false, error: 'invalid_environment_payload', message: '运行环境参数无效。' });
    return true;
  }
  if (String(body.toolId || '').trim()) {
    const result = getEnvironmentToolJobManager(ctx).start(body);
    writeResult(ctx, result, 202);
    return true;
  }
  const result = await executeEnvironmentAction(body, buildEnvironmentOptions(ctx));
  writeResult(ctx, result);
  return true;
}

async function handleEnvironmentJobRoute(ctx, parsed) {
  if (parsed.invalid) {
    writeResult(ctx, { ok: false, error: 'invalid_job_path', message: '运行环境任务路径无效。' });
    return true;
  }
  const manager = getEnvironmentToolJobManager(ctx);
  if (ctx.method === 'GET' && parsed.action === 'watch') {
    if (!manager.watchJob?.(parsed.jobId, ctx.req, ctx.res)) {
      writeResult(ctx, { ok: false, error: 'job_not_found', message: '运行环境任务不存在或已清理。' });
    }
    return true;
  }
  if (ctx.method === 'GET' && !parsed.action) {
    const job = manager.getJob?.(parsed.jobId) || null;
    writeResult(ctx, job
      ? { ok: true, job }
      : { ok: false, error: 'job_not_found', message: '运行环境任务不存在或已清理。' });
    return true;
  }
  if (ctx.method === 'POST' && parsed.action === 'cancel') {
    writeResult(ctx, manager.cancelJob?.(parsed.jobId) || { ok: false, error: 'job_not_cancellable' });
    return true;
  }
  writeResult(ctx, { ok: false, error: 'unsupported_environment_job_action', message: '不支持的运行环境任务操作。' });
  return true;
}

async function handleWebUiEnvironmentRoutes(ctx = {}) {
  const { method, pathname, url, res } = ctx;
  if (method === 'GET' && pathname === '/v0/webui/toolkit/environments') {
    ctx.writeJson(res, 200, getEnvironmentsSummary(buildEnvironmentOptions(ctx)));
    return true;
  }
  if (method === 'GET' && pathname === '/v0/webui/toolkit/environments/guide') {
    const guidePlatform = String(url && url.searchParams && url.searchParams.get('platform') || '').trim();
    ctx.writeJson(res, 200, buildEnvironmentGuide({
      ...buildEnvironmentOptions(ctx),
      guidePlatform
    }));
    return true;
  }
  if (method === 'POST' && pathname === '/v0/webui/toolkit/environments/plan') {
    return handleEnvironmentPlan(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/toolkit/environments/execute') {
    return handleEnvironmentExecute(ctx);
  }
  if (method === 'GET' && pathname === '/v0/webui/toolkit/environments/jobs') {
    const jobs = getEnvironmentToolJobManager(ctx).listActiveJobs?.() || [];
    ctx.writeJson(res, 200, { ok: true, jobs });
    return true;
  }
  const parsed = parseJobPath(pathname);
  if (parsed) return handleEnvironmentJobRoute(ctx, parsed);
  return false;
}

module.exports = {
  buildEnvironmentOptions,
  getEnvironmentToolJobManager,
  handleWebUiEnvironmentRoutes,
  parseJobPath,
  resultStatus
};
