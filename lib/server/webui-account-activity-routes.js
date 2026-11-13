'use strict';

// WebUI 数据面：账号活动（签到 / 领臭鸡蛋）的纯 Go 代理与内部执行桥。
//
// 所有面向用户的 /v0/webui/accounts/activity/* 请求严格由 Go Core 权威承接，
// Go Core 未就绪或返回 5xx 时显式 503 go_core_unavailable 失败关闭，不再保留 Node 本地回退队列。
// 仅保留 /v0/internal/account-activity/claim（Go → Node 内部回调桥），供 Go 按需调用
// Node 运行时中的 provider activity handler（签到请求、验证码、设备指纹等）。

const { runActivityClaim } = require('../account/activity-claim');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const { listAccountCredentialRecords } = require('./account-credential-store');
const { fetchWithTimeout } = require('./http-utils');
const { resolveAccountEgressRequestOptions } = require('./account-egress-request-options');
const {
  isTerminalStatus,
  summarizeResults
} = require('./account-activity-job-manager');
const { getWebUiTaskHub } = require('./webui-task-hub');
const { refreshUsageAfterClaim } = require('./activity-usage-refresh');
const { acquireRun } = require('./scheduled-run-guard');
const { activityClaimKey } = require('./activity-run-keys');
const {
  credentialsEqual,
  isDirectLoopbackRequest,
  parseBearerCredential
} = require('./management-key-auth');

const BULK_ROUTE = '/v0/webui/accounts/activity/run';
const PARAMS_ROUTE = '/v0/webui/accounts/activity/params';
const PROBE_ROUTE = '/v0/webui/accounts/activity/probe';
// Go → Node 的内部执行桥：Go 持有任务状态与限流，逐账号回调本进程执行 provider handler。
// 只接受回环直连 + Go Core 自己的引导密钥（与插件 internal 回调同一套边界）。
const INTERNAL_CLAIM_PATH = '/v0/internal/account-activity/claim';
const INTERNAL_CLAIM_MAX_BYTES = 64 * 1024;
// 等 Node 侧该动作的运行权（计划任务可能正在跑同一动作）：最长等 120s，之后明确失败。
const INTERNAL_CLAIM_WAIT_MS = 120 * 1000;
const JOB_ROUTE = /^\/v0\/webui\/accounts\/activity\/jobs\/([A-Za-z0-9._:-]{1,128})$/;
const ACTION_ROUTE = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/activity\/([a-z0-9][a-z0-9._-]{0,63})$/;
const DEFAULT_TIMEOUT_MS = 20_000;

// 代理结果里，哪些状态是 Go 的「业务结论」而不是「实现不可用」。
const GO_ACTIVITY_DELEGATED_STATUSES = Object.freeze([200, 202, 400, 404, 409, 429]);
const projectedActivityJobs = new Map();
let projectedActivityState = null;

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
    error: String(job.errorSummary || job.error || ''),
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

function matchAccountActivityRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'POST' && path === BULK_ROUTE) return { bulk: true };
  if (verb === 'POST' && path === PROBE_ROUTE) return { probe: true };
  if (verb === 'GET') {
    if (path === PARAMS_ROUTE) return { paramOptions: true };
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
  const fsImpl = (ctx && ctx.fs) || (ctx && ctx.deps && ctx.deps.fs) || nodeFs;
  const listRecords = (ctx && ctx.deps && typeof ctx.deps.listAccountCredentialRecords === 'function')
    ? ctx.deps.listAccountCredentialRecords
    : listAccountCredentialRecords;
  return {
    fs: fsImpl,
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
    listAccountIdentities: resolveDep(ctx, 'listAccountIdentities', ({ provider } = {}) => (
      listRecords(fsImpl, aiHomeDir, provider)
        .map((record) => ({ value: record.accountRef, label: record.accountRef }))
    )),
    timeoutMs: DEFAULT_TIMEOUT_MS
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
  const params = payload && payload.params && typeof payload.params === 'object' ? payload.params : {};
  return { providers, actionId, params };
}

// ---------------------------------------------------------------------------
// 内部执行桥（Go → Node）
// ---------------------------------------------------------------------------

let internalClaimChain = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function withInternalClaimSlot(task) {
  const run = internalClaimChain.then(task, task);
  internalClaimChain = run.then(() => undefined, () => undefined);
  return run;
}

async function acquireInternalClaimGuard(provider, actionId) {
  const key = activityClaimKey(provider, actionId);
  const deadline = Date.now() + INTERNAL_CLAIM_WAIT_MS;
  for (;;) {
    const guard = acquireRun(key, { debounceMs: 0 });
    if (guard.ok) return guard;
    if (guard.reason !== 'in_flight' || Date.now() >= deadline) return null;
    await delay(250);
  }
}

/**
 * 执行桥：POST /v0/internal/account-activity/claim
 *
 * body {provider, accountRef, actionId, params?, dryRun?}
 * 200 {ok:true, result}；账号不存在 404 account_not_found；运行权被占 409。
 */
async function handleAccountActivityInternalRequest(ctx) {
  const pathname = String((ctx && ctx.pathname) || '');
  if (pathname !== INTERNAL_CLAIM_PATH) return false;
  const writeJson = ctx.writeJson;
  const method = String((ctx && ctx.method) || '').toUpperCase();
  if (method !== 'POST') {
    writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  // 内部回调只接受本机直连：外部地址、反向代理转发的请求连密钥都不必看。
  if (!isDirectLoopbackRequest(ctx.req)) {
    writeJson(ctx.res, 403, { ok: false, error: 'activity_internal_loopback_required' });
    return true;
  }
  const goCoreKey = typeof (ctx.deps && ctx.deps.goCoreManagementKey) === 'function'
    ? String(ctx.deps.goCoreManagementKey() || '').trim()
    : '';
  const credential = parseBearerCredential(ctx.req);
  if (!goCoreKey || !credentialsEqual(credential, goCoreKey)) {
    writeJson(ctx.res, 401, { ok: false, error: 'activity_internal_unauthorized' });
    return true;
  }

  let payload = null;
  try {
    const buffer = await ctx.readRequestBody(ctx.req, { maxBytes: INTERNAL_CLAIM_MAX_BYTES });
    payload = buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : null;
  } catch (_error) {
    payload = null;
  }
  const provider = String(payload && payload.provider || '').trim().toLowerCase();
  const accountRef = String(payload && payload.accountRef || '').trim();
  const actionId = String(payload && payload.actionId || '').trim().toLowerCase();
  if (!provider || !accountRef || !actionId) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_activity_claim' });
    return true;
  }
  const params = payload && payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  const dryRun = payload && payload.dryRun === true;

  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 503, { ok: false, error: 'aih_home_dir_unavailable' });
    return true;
  }
  const deps = buildClaimDeps(ctx, aiHomeDir);
  const listRecords = resolveDep(ctx, 'listAccountCredentialRecords', listAccountCredentialRecords);
  let records = [];
  try {
    records = listRecords(deps.fs, aiHomeDir, provider);
  } catch (error) {
    writeJson(ctx.res, 503, {
      ok: false,
      error: `account_list_failed:${String(error && error.message || error).trim()}`
    });
    return true;
  }
  const record = records.find((item) => String(item && item.accountRef || '') === accountRef);
  if (!record) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  let result = null;
  try {
    result = await withInternalClaimSlot(async () => {
      const guard = await acquireInternalClaimGuard(provider, actionId);
      if (!guard) {
        return {
          provider,
          accountRef,
          actionId,
          status: 'error',
          error: 'activity_already_running'
        };
      }
      try {
        const executeClaim = resolveDep(ctx, 'runActivityClaim', runActivityClaim);
        const accountEgressDeps = ctx && ctx.deps && ctx.deps.accountEgressDeps;
        return await executeClaim({
          ...deps,
          provider,
          record,
          actionId,
          ...(Object.keys(params).length > 0 ? { params } : {}),
          ...(dryRun ? { dryRun: true } : {}),
          ...(accountEgressDeps ? { accountEgressDeps } : {})
        });
      } finally {
        guard.release();
      }
    });
  } catch (error) {
    result = {
      provider,
      accountRef,
      actionId,
      status: 'error',
      error: `activity_failed:${String(error && error.message || error).trim()}`
    };
  }
  const normalized = result && typeof result === 'object'
    ? result
    : { provider, accountRef, actionId, status: 'error', error: 'activity_empty_result' };
  refreshUsageAfterClaim(ctx && ctx.deps, provider, accountRef, normalized);
  writeJson(ctx.res, 200, { ok: true, result: normalized });
  return true;
}

// ---------------------------------------------------------------------------
// Go 权威代理（Fail-Closed，零 Node 本地回退）
// ---------------------------------------------------------------------------

function goActivityHost(ctx) {
  const host = ctx && ctx.deps && ctx.deps.goCoreSync;
  return host && typeof host === 'object' ? host : null;
}

async function callGoActivity(ctx, method, args) {
  const host = goActivityHost(ctx);
  if (!host || typeof host[method] !== 'function') return { available: false, response: null };
  try {
    const response = await host[method](...args);
    return { available: true, response: response || null };
  } catch (_error) {
    return { available: true, response: null };
  }
}

function goActivityUnavailable(response) {
  if (!response) return true;
  const status = Number(response.status) || 0;
  if (status === 0 || status >= 500) return true;
  return String(response.errorCode || '') === 'go_core_unavailable';
}

function writeGoActivityUnavailable(ctx, response) {
  const message = String(
    (response && response.data && response.data.message)
    || 'Go Core 未就绪，账号活动服务不可用'
  );
  ctx.writeJson(ctx.res, 503, {
    ok: false,
    error: String((response && response.errorCode) || 'go_core_unavailable'),
    message
  });
  return true;
}

function writeGoActivityResult(ctx, response, options = {}) {
  const status = Number(response && response.status) || 0;
  const data = response && response.data;
  const extra = Array.isArray(options.extraStatuses) ? options.extraStatuses : [];
  if (!data) return false;
  if (!GO_ACTIVITY_DELEGATED_STATUSES.includes(status) && !extra.includes(status)) return false;
  ctx.writeJson(ctx.res, status, data);
  return true;
}

function rememberProxiedActivityJob(ctx, job) {
  if (!job || typeof job !== 'object' || !String(job.id || '').trim()) return;
  projectedActivityJobs.set(String(job.id), job);
  if (projectedActivityJobs.size > 100) {
    const removable = [...projectedActivityJobs.values()]
      .filter((item) => isTerminalStatus(item.status))
      .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    for (const item of removable) {
      if (projectedActivityJobs.size <= 100) break;
      projectedActivityJobs.delete(item.id);
    }
  }
  try {
    getWebUiTaskHub(ctx).publish(toWebUiTask(job));
  } catch (_error) {
    // 队列投影失败不能影响领取本身。
  }
}

function ensureProjectedActivitySource(ctx) {
  const state = ctx && ctx.state;
  if (!state || projectedActivityState === state) return;
  projectedActivityState = state;
  try {
    getWebUiTaskHub(ctx).registerSource('account-activity-go', () => (
      [...projectedActivityJobs.values()]
        .filter((job) => !isTerminalStatus(job.status))
        .map(toWebUiTask)
    ));
  } catch (_error) {
    // 同理：投影源注册失败不影响领取。
  }
}

async function handleAccountActivityRequest(ctx) {
  const route = matchAccountActivityRoute(ctx.method, ctx.pathname);
  if (!route) return false;

  let selection = null;
  if (route.bulk || route.probe) {
    selection = await readBulkSelection(ctx);
    if (!selection) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_activity_selection' });
      return true;
    }
  }

  if (route.jobId) {
    const { available, response } = await callGoActivity(ctx, 'getAccountActivityJob', [route.jobId]);
    if (!available || goActivityUnavailable(response)) return writeGoActivityUnavailable(ctx, response);
    if (response.ok && response.data && response.data.job) {
      ensureProjectedActivitySource(ctx);
      rememberProxiedActivityJob(ctx, response.data.job);
    }
    return writeGoActivityResult(ctx, response) || writeGoActivityUnavailable(ctx, response);
  }

  if (route.paramOptions) {
    const url = new URL(String((ctx.req && ctx.req.url) || PARAMS_ROUTE), 'http://127.0.0.1');
    const provider = String(url.searchParams.get('provider') || '').trim().toLowerCase();
    const actionId = String(url.searchParams.get('actionId') || '').trim().toLowerCase();
    const { available, response } = await callGoActivity(ctx, 'listAccountActivityParams', [provider, actionId]);
    if (!available || goActivityUnavailable(response)) return writeGoActivityUnavailable(ctx, response);
    return writeGoActivityResult(ctx, response, { extraStatuses: [404] }) || writeGoActivityUnavailable(ctx, response);
  }

  if (route.probe) {
    const { available, response } = await callGoActivity(ctx, 'probeAccountActivity', [{
      providers: selection.providers,
      actionId: selection.actionId
    }]);
    if (!available || goActivityUnavailable(response)) return writeGoActivityUnavailable(ctx, response);
    return writeGoActivityResult(ctx, response, { extraStatuses: [404] }) || writeGoActivityUnavailable(ctx, response);
  }

  if (route.bulk) {
    const { available, response } = await callGoActivity(ctx, 'runAccountActivity', [{
      providers: selection.providers,
      actionId: selection.actionId,
      params: selection.params
    }]);
    if (!available || goActivityUnavailable(response)) return writeGoActivityUnavailable(ctx, response);
    if (response.ok && response.data) {
      ensureProjectedActivitySource(ctx);
      rememberProxiedActivityJob(ctx, response.data.job);
    }
    return writeGoActivityResult(ctx, response) || writeGoActivityUnavailable(ctx, response);
  }

  const { available, response } = await callGoActivity(ctx, 'runAccountActivityForAccount', [
    route.provider,
    route.accountRef,
    route.actionId
  ]);
  if (!available || goActivityUnavailable(response)) return writeGoActivityUnavailable(ctx, response);
  return writeGoActivityResult(ctx, response) || writeGoActivityUnavailable(ctx, response);
}

module.exports = {
  BULK_ROUTE,
  PARAMS_ROUTE,
  PROBE_ROUTE,
  handleAccountActivityRequest,
  // Go → Node 的内部执行桥（只挂回环 + Go Core 密钥，见 web-ui-router 的入口）。
  handleAccountActivityInternalRequest,
  INTERNAL_CLAIM_PATH,
  matchAccountActivityRoute,
  toWebUiTask,
  summarizeActivityResults: summarizeResults
};
