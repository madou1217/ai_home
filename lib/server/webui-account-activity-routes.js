'use strict';

// WebUI 数据面：账号活动（签到 / 领臭鸡蛋）的执行入口。
//
// 动作清单来自 provider 描述符的 `activity` 能力（见 lib/providers/defs/*.js），
// 因此这里没有 provider 名单：新增 provider 只加描述符，前端只渲染服务端下发的
// `activityActions`。执行本身复用 CLI 同一条策略执行器（lib/account/activity-claim），
// 保证「CLI 能领的，WebUI 同一套逻辑领」。
//
// 三条路由：
//   POST /v0/webui/accounts/activity/run
//     —— 开始一个后台领取任务（202 + job）。请求体必须显式给出
//        `{ providers, actionId }`；每个 provider 都必须声明该动作，
//        绝不回退成“所有 provider 一起跑”，避免 Qoder / ZCode 混在同一批。
//   GET /v0/webui/accounts/activity/jobs/:jobId
//     —— 查询任务进度与结果（页面轮询）。
//   POST /v0/webui/accounts/:provider/:accountRef/activity/:actionId
//     —— 单账号单动作（账号菜单项），单次请求内完成。
//
// 批量领取为什么异步：ZCode 每个账号要过一次无痕验证码（约 10–20s），账号一多，
// 同步 HTTP 请求会越过浏览器 / 代理超时。后台队列串行执行，页面只轮询进度。
//
// 领取失败（活动未开放、验证码失败、凭据失效）是**正常业务结果**：任务结果里按
// result.status / error 显示，不伪装成服务器故障；只有路径 / 选择参数 / 账号不存在
// 才是 4xx。

const {
  listActivityActions,
  runActivityClaim
} = require('../account/activity-claim');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const { listAccountCredentialRecords } = require('./account-credential-store');
const { fetchWithTimeout } = require('./http-utils');
const { resolveAccountEgressRequestOptions } = require('./account-egress-request-options');
const {
  createAccountActivityJobManager,
  isTerminalStatus,
  summarizeResults
} = require('./account-activity-job-manager');
const { getWebUiTaskHub } = require('./webui-task-hub');

const BULK_ROUTE = '/v0/webui/accounts/activity/run';
const JOB_ROUTE = /^\/v0\/webui\/accounts\/activity\/jobs\/([A-Za-z0-9._:-]{1,128})$/;
const ACTION_ROUTE = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/activity\/([a-z0-9][a-z0-9._-]{0,63})$/;
const DEFAULT_TIMEOUT_MS = 20_000;

const managersByState = new WeakMap();
let fallbackManager = null;

// 账号活动任务 -> 统一任务队列条目（WebUI 的 `WebUiTask` 形状）。
// `kind: 'activity'` 是队列页分 tab 的依据；进度用 completed/total 折算百分比。
function toWebUiTask(job) {
  if (!job || typeof job !== 'object') return null;
  const providers = Array.isArray(job.providers) ? job.providers : [];
  const progress = job.progress && typeof job.progress === 'object' ? job.progress : {};
  const total = Math.max(0, Number(progress.total) || 0);
  const completed = Math.max(0, Number(progress.completed) || 0);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const current = String(progress.currentAccountRef || '').trim();
  return {
    id: String(job.id || ''),
    source: 'account-activity',
    taskName: `${providers.join('/').toUpperCase() || '账号'} · ${String(job.actionLabel || job.actionId || '账号活动')}`,
    appId: providers.join(','),
    provider: providers.join(','),
    kind: 'activity',
    action: 'claim',
    status: String(job.status || 'queued'),
    phase: String(job.phase || ''),
    progress: {
      percent,
      label: total > 0 ? `${completed}/${total}${current ? ` · ${current}` : ''}` : String(job.phase || '')
    },
    attempts: [],
    result: null,
    error: String(job.error || ''),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null
  };
}

function resolveAiHomeDir(ctx) {
  const processObj = (ctx && ctx.processObj) || process;
  const env = processObj.env || {};
  return String(
    (ctx && ctx.aiHomeDir)
    || (ctx && ctx.state && ctx.state.aiHomeDir)
    || env.AI_HOME_DIR
    || env.AIH_HOME_DIR
    || ''
  ).trim();
}

function resolveDep(ctx, name, fallback) {
  const injected = ctx && ctx.deps && ctx.deps[name];
  return typeof injected === 'function' ? injected : fallback;
}

function getAccountActivityJobManager(ctx) {
  const injected = ctx && ctx.deps && ctx.deps.accountActivityJobManager;
  if (injected) return injected;
  if (ctx && ctx.state && typeof ctx.state === 'object') {
    const cached = managersByState.get(ctx.state);
    if (cached) return cached;
    const manager = createAccountActivityJobManager({
      // 接进**统一任务队列**：账号活动（签到 / 领臭鸡蛋）的执行与下载/卸载同队列同页面，
      // 页面用 tab 区分；计划任务触发的领取走同一个 manager，因此同样可见。
      onJobChanged: (job) => {
        try {
          getWebUiTaskHub(ctx).publish(toWebUiTask(job));
        } catch (_error) {
          // 队列投影失败不能影响领取本身。
        }
      }
    });
    getWebUiTaskHub(ctx).registerSource('account-activity', () => (
      manager.listJobs().filter((job) => !isTerminalStatus(job.status)).map(toWebUiTask)
    ));
    managersByState.set(ctx.state, manager);
    return manager;
  }
  if (!fallbackManager) fallbackManager = createAccountActivityJobManager();
  return fallbackManager;
}

function matchAccountActivityRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'POST' && path === BULK_ROUTE) return { bulk: true };
  if (verb === 'GET') {
    const jobMatch = JOB_ROUTE.exec(path);
    if (!jobMatch) return null;
    return { jobId: jobMatch[1] };
  }
  if (verb !== 'POST') return null;
  const match = ACTION_ROUTE.exec(path);
  if (!match) return null;
  try {
    return {
      bulk: false,
      provider: decodeURIComponent(match[1]).trim().toLowerCase(),
      accountRef: decodeURIComponent(match[2]).trim(),
      actionId: decodeURIComponent(match[3]).trim().toLowerCase()
    };
  } catch (_error) {
    return null;
  }
}

function buildClaimDeps(ctx, aiHomeDir) {
  return {
    fs: (ctx && ctx.fs) || (ctx && ctx.deps && ctx.deps.fs) || nodeFs,
    aiHomeDir,
    hostHomeDir: String(
      (ctx && ctx.deps && ctx.deps.hostHomeDir)
      || (ctx && ctx.state && ctx.state.hostHomeDir)
      || (ctx && ctx.processObj && ctx.processObj.env && ctx.processObj.env.AIH_HOST_HOME)
      || nodeOs.homedir()
    ).trim(),
    processObj: (ctx && ctx.processObj) || process,
    fetchWithTimeout: resolveDep(ctx, 'fetchWithTimeout', fetchWithTimeout),
    resolveAccountEgressRequestOptions: resolveDep(
      ctx,
      'resolveAccountEgressRequestOptions',
      resolveAccountEgressRequestOptions
    ),
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
}

/** 构造单账号执行函数；批量任务与单账号路由共用，执行器注入点唯一。 */
function buildClaimRunner(ctx, deps, actionId) {
  const executeClaim = resolveDep(ctx, 'runActivityClaim', runActivityClaim);
  const accountEgressDeps = ctx && ctx.deps && ctx.deps.accountEgressDeps;
  return async ({ provider, record }) => {
    try {
      const result = await executeClaim({
        ...deps,
        provider,
        record,
        actionId,
        ...(accountEgressDeps ? { accountEgressDeps } : {})
      });
      return result && typeof result === 'object'
        ? result
        : {
          provider,
          accountRef: record.accountRef,
          actionId,
          status: 'error',
          error: 'activity_empty_result'
        };
    } catch (error) {
      return {
        provider,
        accountRef: record.accountRef,
        actionId,
        status: 'error',
        error: `activity_failed:${String(error && error.message || error).trim()}`
      };
    }
  };
}

/**
 * 解析批量选择。严格模式：缺字段 / 空数组 / 非法 JSON 都返回 null，
 * 绝不把“没带选择”解释成“跑全部 provider”。
 */
async function readBulkSelection(ctx) {
  if (!ctx || typeof ctx.readRequestBody !== 'function' || !ctx.req) return null;
  let payload = null;
  try {
    const buffer = await ctx.readRequestBody(ctx.req, { maxBytes: 8 * 1024 });
    payload = buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : null;
  } catch (_error) {
    return null;
  }
  const providers = Array.isArray(payload && payload.providers)
    ? [...new Set(payload.providers
      .map((item) => String(item === undefined || item === null ? '' : item).trim().toLowerCase())
      .filter(Boolean))]
    : [];
  const actionId = typeof (payload && payload.actionId) === 'string'
    ? payload.actionId.trim().toLowerCase()
    : '';
  if (providers.length === 0 || !actionId) return null;
  return { providers, actionId };
}

async function handleBulk(ctx, deps, aiHomeDir) {
  const selection = await readBulkSelection(ctx);
  if (!selection) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_activity_selection' });
    return true;
  }
  const listActions = resolveDep(ctx, 'listActivityActions', listActivityActions);
  let actionLabel = '';
  for (const provider of selection.providers) {
    const actions = listActions(provider);
    const action = actions.find((entry) => entry.id === selection.actionId);
    // 请求里混入了不支持该动作的 provider 时整体拒绝，不做“跳过一部分”的模糊执行。
    if (!action) {
      ctx.writeJson(ctx.res, 400, {
        ok: false,
        error: `activity_action_unknown:${provider}:${selection.actionId}`
      });
      return true;
    }
    if (!actionLabel) actionLabel = action.label;
  }

  const listRecords = resolveDep(ctx, 'listAccountCredentialRecords', listAccountCredentialRecords);
  const targets = [];
  try {
    for (const provider of selection.providers) {
      for (const record of listRecords(deps.fs, aiHomeDir, provider)) {
        targets.push({ provider, record });
      }
    }
  } catch (error) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: `account_list_failed:${String(error && error.message || error).trim()}`
    });
    return true;
  }
  if (targets.length === 0) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'activity_no_accounts' });
    return true;
  }

  const manager = getAccountActivityJobManager(ctx);
  const started = manager.start({
    providers: selection.providers,
    actionId: selection.actionId,
    actionLabel,
    targets,
    execute: buildClaimRunner(ctx, deps, selection.actionId)
  });
  if (!started.ok) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: started.error || 'activity_start_failed' });
    return true;
  }
  ctx.writeJson(ctx.res, 202, { ok: true, ...started });
  return true;
}

async function handleJob(ctx, route) {
  const manager = getAccountActivityJobManager(ctx);
  const job = manager.getJob(route.jobId);
  if (!job) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'activity_job_not_found' });
    return true;
  }
  ctx.writeJson(ctx.res, 200, { ok: true, job });
  return true;
}

async function handleSingle(ctx, deps, aiHomeDir, route) {
  const actions = typeof (ctx.deps && ctx.deps.listActivityActions) === 'function'
    ? ctx.deps.listActivityActions(route.provider)
    : listActivityActions(route.provider);
  if (actions.length === 0) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: `activity_unsupported:${route.provider}` });
    return true;
  }
  if (!actions.some((action) => action.id === route.actionId)) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: `activity_action_unknown:${route.actionId}` });
    return true;
  }
  const listRecords = resolveDep(ctx, 'listAccountCredentialRecords', listAccountCredentialRecords);
  let records = [];
  try {
    records = listRecords(deps.fs, aiHomeDir, route.provider);
  } catch (error) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: `account_list_failed:${String(error && error.message || error).trim()}`
    });
    return true;
  }
  const record = records.find((item) => String(item && item.accountRef || '') === route.accountRef);
  if (!record) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const execute = buildClaimRunner(ctx, deps, route.actionId);
  const result = await execute({ provider: route.provider, record });
  ctx.writeJson(ctx.res, 200, { ok: result.status !== 'error', ...result });
  return true;
}

async function handleAccountActivityRequest(ctx) {
  const route = matchAccountActivityRoute(ctx.method, ctx.pathname);
  if (!route) return false;
  if (route.jobId) return handleJob(ctx, route);
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'aih_home_dir_unavailable' });
    return true;
  }
  const deps = buildClaimDeps(ctx, aiHomeDir);
  if (route.bulk) return handleBulk(ctx, deps, aiHomeDir);
  return handleSingle(ctx, deps, aiHomeDir, route);
}

module.exports = {
  handleAccountActivityRequest,
  matchAccountActivityRoute,
  getAccountActivityJobManager,
  toWebUiTask,
  summarizeActivityResults: summarizeResults
};
