'use strict';

const { buildEnvironmentsSummaryAsync, getEnvironmentsSummaryAsync } = require('../cli/services/toolkit/environment/resource-manager');
const { buildEnvironmentGuide } = require('../cli/services/toolkit/environment/guide-builder');
const { planEnvironmentToolAction, planEnvironmentToolActionAsync } = require('../cli/services/toolkit/environment/lifecycle');
const { ToolkitTargetError, listToolkitTargets, resolveToolkitTarget } = require('./toolkit-execution-target');
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
    maxOutputBytes: ctx.maxOutputBytes || deps.maxOutputBytes,
    aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir
  };
}

/**
 * 解析请求的执行目标：query `target`（GET）或 body.target（POST），缺省本机。
 * 返回 null 表示本机（走原有同步 / 缓存路径，行为不变）。
 */
function resolveRequestTarget(ctx, body) {
  const fromQuery = ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('target') : '';
  const raw = String((body && body.target) || fromQuery || '').trim();
  if (!raw || raw === 'local') return null;
  return resolveToolkitTarget(raw, {
    fs: ctx.fs || (ctx.deps && ctx.deps.fs) || require('node:fs'),
    aiHomeDir: ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir),
    baseOptions: buildEnvironmentOptions(ctx),
    remoteService: ctx.deps && ctx.deps.remoteWorkspaceService
  });
}

function writeTargetError(ctx, error) {
  if (!(error instanceof ToolkitTargetError)) throw error;
  ctx.writeJson(ctx.res, error.status, { ok: false, error: error.code, message: error.message });
  return true;
}

async function probeRemoteSummary(target) {
  const [summary, description] = await Promise.all([
    buildEnvironmentsSummaryAsync(await target.probeOptions()),
    target.describe()
  ]);
  return { ...summary, target: description, probedAt: Date.now() };
}

// 远端汇总缓存（按执行目标分区，stale-while-revalidate）：一次完整探测是 3~4 个远端往返，
// 慢链路上要 1~3s。有旧值先回旧值并后台刷新；refresh=1（「重新探测」、任务完成后）强制实时探测。
const REMOTE_SUMMARY_TTL_MS = 15 * 1000;
const remoteSummaryCache = new Map(); // targetKey → { at, value, inFlight }

function refreshRemoteSummary(target) {
  const entry = remoteSummaryCache.get(target.key) || {};
  if (entry.inFlight) return entry.inFlight;
  const inFlight = probeRemoteSummary(target)
    .then((value) => {
      remoteSummaryCache.set(target.key, { at: value.probedAt, value });
      return value;
    })
    .finally(() => {
      const current = remoteSummaryCache.get(target.key);
      if (current && current.inFlight === inFlight) delete current.inFlight;
    });
  remoteSummaryCache.set(target.key, { ...entry, inFlight });
  return inFlight;
}

async function remoteSummary(target, { refresh = false } = {}) {
  const cached = remoteSummaryCache.get(target.key);
  if (!refresh && cached && cached.value) {
    const stale = Date.now() - cached.at >= REMOTE_SUMMARY_TTL_MS;
    if (stale) refreshRemoteSummary(target).catch(() => {});
    return { ...cached.value, stale };
  }
  return refreshRemoteSummary(target);
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
  if (error === 'environment_tool_not_found' || error === 'job_not_found' || error === 'connection_not_found') return 404;
  if (error === 'remote_unreachable' || error === 'auth_failed' || error === 'host_key_mismatch') return 502;
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
  let target;
  try { target = resolveRequestTarget(ctx, body); } catch (error) { return writeTargetError(ctx, error); }
  if (target) {
    if (!String(body.toolId || '').trim()) {
      writeResult(ctx, { ok: false, error: 'unsupported_environment_tool_action', message: '远端只支持按工具安装 / 更新 / 卸载。' });
      return true;
    }
    try {
      writeResult(ctx, await planEnvironmentToolActionAsync(body, await target.probeOptions()));
    } catch (error) {
      return writeTargetError(ctx, error);
    }
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
  let target;
  try { target = resolveRequestTarget(ctx, body); } catch (error) { return writeTargetError(ctx, error); }
  if (String(body.toolId || '').trim()) {
    try {
      const result = await getEnvironmentToolJobManager(ctx).start(body, target);
      writeResult(ctx, result, 202);
    } catch (error) {
      return writeTargetError(ctx, error);
    }
    return true;
  }
  if (target) {
    writeResult(ctx, { ok: false, error: 'unsupported_environment_tool_action', message: '远端只支持按工具安装 / 更新 / 卸载。' });
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
    let target;
    try { target = resolveRequestTarget(ctx, null); } catch (error) { return writeTargetError(ctx, error); }
    if (target) {
      // 远端：探测打包成少数几次远端执行（见 remote-probe），结果按目标缓存。
      try {
        const refresh = String(url && url.searchParams && url.searchParams.get('refresh') || '') === '1';
        ctx.writeJson(res, 200, await remoteSummary(target, { refresh }));
      } catch (error) {
        return writeTargetError(ctx, error);
      }
      return true;
    }
    // 异步并发探测：14 个工具与各运行时同时跑，避免同步子进程阻塞主线程。
    ctx.writeJson(res, 200, await getEnvironmentsSummaryAsync(buildEnvironmentOptions(ctx)));
    return true;
  }
  if (method === 'GET' && pathname === '/v0/webui/toolkit/environments/targets') {
    ctx.writeJson(res, 200, {
      ok: true,
      targets: listToolkitTargets({ fs: ctx.fs || (ctx.deps && ctx.deps.fs) || require('node:fs'), aiHomeDir: ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir) })
    });
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
