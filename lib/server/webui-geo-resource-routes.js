'use strict';

// GeoIP 数据资源的 WebUI 路由（工具箱 → 网络 → GeoIP 数据）：
//   GET  /v0/webui/geo-resources                   资源列表（在不在、多大、什么时候下的）+ provider 可用性
//   POST /v0/webui/geo-resources/jobs              启动下载/更新/删除作业（body: resourceId, action）
//   GET  /v0/webui/geo-resources/jobs              进行中的作业
//   GET  /v0/webui/geo-resources/jobs/:id/watch    作业进度（SSE）
// 鉴权由 webui-auth-gate 统一负责（Management Key）。
//
// 为什么走作业而不是同步下载：DB-IP City Lite 是 60MB 压缩包，同步请求会超时且看不到进度；
// 作业形态与「托管工具」一致，前端复用同一套任务队列 UI。

const { getWebUiTaskHub } = require('./webui-task-hub');
const {
  createGeoResourceJobManager,
  listGeoResources
} = require('./geo-resource-job-manager');

const ROOT_PATH = '/v0/webui/geo-resources';
const JOB_PATH_PATTERN = /^\/v0\/webui\/geo-resources\/jobs\/([^/]+)(?:\/(watch|cancel))?$/;

const managersByState = new WeakMap();
let fallbackManager = null;

function createManagerFromContext(ctx = {}) {
  return createGeoResourceJobManager({
    fs: ctx.fs || (ctx.deps && ctx.deps.fs),
    aiHomeDir: String(ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir) || '').trim(),
    taskHub: getWebUiTaskHub(ctx)
  });
}

/** 每个 server state 一个管理器（与 app-install / managed-tool 同一模式）。 */
function getGeoResourceJobManager(ctx = {}) {
  const injected = ctx.deps && ctx.deps.geoResourceJobManager;
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

function matchGeoResourceRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'GET' && path === ROOT_PATH) return true;
  if ((verb === 'POST' || verb === 'GET') && path === `${ROOT_PATH}/jobs`) return true;
  return (verb === 'GET' || verb === 'POST') && JOB_PATH_PATTERN.test(path);
}

function resolveDependency(ctx, name, fallback) {
  const injected = ctx && ctx.deps && ctx.deps[name];
  return typeof injected === 'function' ? injected : fallback;
}

async function readJsonBody(ctx) {
  try {
    const raw = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes: 8 * 1024 })
      : null;
    const parsed = raw ? JSON.parse(raw.toString('utf8')) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return null;
  }
}

/** 数据来源现状（哪些 provider 可用、用的是哪个文件）—— 用户要看「现在到底用没用上本地库」。 */
function describeGeoProviders(ctx) {
  try {
    const { createGeoProviders } = require('../runtime/geo/providers');
    const { GeoLookupChain } = require('../runtime/geo/chain');
    const chain = new GeoLookupChain({
      providers: createGeoProviders({
        fs: ctx.fs,
        aiHomeDir: String(ctx.aiHomeDir || '').trim()
      })
    });
    return chain.availability();
  } catch (_error) {
    return [];
  }
}

async function handleGeoResourceRequest(ctx = {}) {
  const { writeJson, res, req } = ctx;
  const method = String(ctx.method || (req && req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');
  const listResources = resolveDependency(ctx, 'listGeoResources', listGeoResources);

  if (method === 'GET' && pathname === ROOT_PATH) {
    const manager = getGeoResourceJobManager(ctx);
    writeJson(res, 200, {
      ok: true,
      resources: listResources({ fs: ctx.fs, aiHomeDir: ctx.aiHomeDir }),
      providers: describeGeoProviders(ctx),
      jobs: typeof manager.listActiveJobs === 'function' ? manager.listActiveJobs() : []
    });
    return true;
  }

  if (pathname === `${ROOT_PATH}/jobs`) {
    const manager = getGeoResourceJobManager(ctx);
    if (method === 'GET') {
      writeJson(res, 200, { ok: true, jobs: typeof manager.listActiveJobs === 'function' ? manager.listActiveJobs() : [] });
      return true;
    }
    const body = await readJsonBody(ctx);
    if (!body) {
      writeJson(res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    const started = manager.start({
      resourceId: String(body.resourceId || '').trim(),
      action: String(body.action || 'install').trim(),
      // 通用 job manager 要求显式确认（与安装/更新一致）；这个接口本身就是「用户点了按钮」。
      confirmed: true
    });
    writeJson(res, started.ok === false ? 409 : 200, started);
    return true;
  }

  const match = JOB_PATH_PATTERN.exec(pathname);
  if (!match) return false;
  const jobId = decodeURIComponent(match[1]);
  const action = match[2] || '';
  const manager = getGeoResourceJobManager(ctx);
  if (method === 'GET' && action === 'watch') {
    if (typeof manager.watchJob !== 'function' || !manager.watchJob(jobId, req, res)) {
      writeJson(res, 404, { ok: false, error: 'job_not_found' });
    }
    return true;
  }
  if (method === 'POST' && action === 'cancel') {
    const cancelled = typeof manager.cancel === 'function' ? manager.cancel(jobId) : { ok: false, error: 'cancel_unsupported' };
    writeJson(res, cancelled.ok === false ? 409 : 200, cancelled);
    return true;
  }
  const job = typeof manager.getJob === 'function' ? manager.getJob(jobId) : null;
  if (!job) {
    writeJson(res, 404, { ok: false, error: 'job_not_found' });
    return true;
  }
  writeJson(res, 200, { ok: true, job });
  return true;
}

module.exports = {
  ROOT_PATH,
  getGeoResourceJobManager,
  handleGeoResourceRequest,
  matchGeoResourceRoute
};
