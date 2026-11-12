'use strict';

const { listProvidersByCapability } = require('../provider-catalog');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const liveAccountSource = require('./webui-account-live');
const { refreshLiveAccountRecord } = liveAccountSource;
const { detectStoredApiKeyMode } = require('./webui-account-routes-state');
const { accountExists, goOnlyAccountExists, parseAccountRoute } = require('./webui-account-routes-utils');
const { startModelCatalogRefreshJob } = require('./webui-openai-model-routes');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const {
  accountRefreshJobs,
  emitAccountRefreshJobEvent,
  findActiveAccountRefreshJob,
  makeAccountRefreshJobId,
  serializeAccountRefreshJob
} = require('./webui-account-routes-refresh');

const MODEL_CATALOG_PROVIDERS = new Set(listProvidersByCapability('modelCatalog'));
const BRANCH_LABELS = { status: '状态', models: '模型', usage: '额度' };

// Go 作业的轮询节奏：一次三段刷新通常几秒内收尾，300ms 足够让界面跟手。
const GO_REFRESH_POLL_INTERVAL_MS = 300;
// 轮询总上限。POST 本身最多等 30s，这里给同样的量级：超时只说明「等不到终态」，
// 不代表 Go 没在跑，所以超时不能回退（见 isGoRefreshUnavailable）。
const GO_REFRESH_POLL_TIMEOUT_MS = 30 * 1000;
// 只有这些错误码说明「Go 明确没有承接这次刷新」，才允许回退本地三段实现。
// timeout 刻意不在其中：请求超时只说明 Node 等不到响应，Go 很可能已经在跑，
// 回退会重复打上游。status===0 同理要先排除 timeout（见 isGoRefreshUnavailable）。
const GO_REFRESH_FALLBACK_ERROR_CODES = new Set([
  'go_core_unavailable',
  'network_error',
  'http_404',
  'http_501',
  'http_405'
]);
const GO_REFRESH_TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

function isActiveJobStatus(status) {
  return status === 'queued' || status === 'running';
}

// 轮询间隔用的定时器不参与进程存活判定：Node 退出时不该被一次轮询吊住。
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// Go 侧能力探测：宿主没接线（或旧宿主没有这个方法）时返回 null，直接走本地实现。
function readGoRefreshHost(ctx) {
  const host = ctx && ctx.deps && ctx.deps.goCoreSync;
  if (!host || typeof host.refreshAccountWebUI !== 'function') return null;
  return host;
}

// Go 的业务错误体有两种形状（见 Go 侧 writeError）：
//   {ok:false, error:"account_not_found", message:"账号不存在"}
//   {ok:false, error:{code:"unauthorized", message:"需要管理密钥"}}
// 路由不存在时是纯文本 404 / 空体，两者都读不到。
// 领域错误码是「Go 已经处理了这次请求」的证据，必须优先于传输层错误码。
function readGoDomainError(result) {
  const data = result && result.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { code: '', message: '' };
  const raw = data.error;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      code: String(raw.code || raw.error || '').trim(),
      message: String(raw.message || '').trim()
    };
  }
  return {
    code: typeof raw === 'string' ? raw.trim() : String(data.code || '').trim(),
    message: String(data.message || '').trim()
  };
}

// 「Go 明确不可用」的判定：错误码在名单内，或请求根本没发出去（status=0）。
// timeout 必须先排除——它同样带 status=0，但 Go 可能已经把刷新跑起来了。
// 回包里有领域错误码时同样排除：Go 已经给出 account_not_found / unauthorized，
// 再回退会把它盖成「Go Core 不可用」（goOnly 账号尤其明显），真实原因就丢了。
function isGoRefreshUnavailable(result) {
  if (!result) return true;
  const errorCode = String(result.errorCode || '');
  if (errorCode === 'timeout') return false;
  if (readGoDomainError(result).code) return false;
  if (GO_REFRESH_FALLBACK_ERROR_CODES.has(errorCode)) return true;
  return Number(result.status || 0) === 0;
}

// 失败文案优先用 Go 给的领域错误码（与本地实现的 account_not_found 等口径一致，
// 前端按它决定「账号已不存在」这类分支），没有再用中文 message。
function readGoErrorText(result, fallback) {
  const { code, message } = readGoDomainError(result);
  const text = code || message;
  if (text) return text.slice(0, 500);
  const status = Number((result && result.status) || 0);
  return status > 0 ? `${fallback}（http_${status}）` : fallback;
}

// 把 Go 的作业快照映射进本地作业。
//
// 保留本地 job.id：202 响应与 SSE 事件都按它关联，换 id 会让前端把同一次刷新当成两次。
// branches 只认本地已有的三段，避免上游新增键悄悄改变事件形状。
function applyGoJobSnapshot(job, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const status = String(snapshot.status || '');
  if (status) job.status = status;
  job.error = String(snapshot.error || '').slice(0, 500);
  if (Array.isArray(snapshot.failedBranches)) {
    job.failedBranches = snapshot.failedBranches.map((name) => String(name)).filter(Boolean);
  }
  // 轻探测成功并自动清掉运行态阻塞：Go 也会给出同样的标记，照原样带出去。
  if (snapshot.recovered === true) job.recovered = true;
  const branches = snapshot.branches;
  const localBranches = job.branches && typeof job.branches === 'object' ? job.branches : null;
  if (localBranches && branches && typeof branches === 'object') {
    for (const name of Object.keys(localBranches)) {
      const branch = branches[name];
      if (!branch || typeof branch !== 'object') continue;
      if (branch.status) localBranches[name].status = String(branch.status);
      localBranches[name].error = String(branch.error || '').slice(0, 500);
    }
  }
  if (Number(snapshot.finishedAt) > 0) job.finishedAt = Number(snapshot.finishedAt);
  if (Number(snapshot.updatedAt) > 0) job.updatedAt = Number(snapshot.updatedAt);
}

// 终态收尾时把还挂在 running 的分支改成 failed：终态作业里不该再有「进行中」的分支，
// 否则 serializeAccountRefreshJob 会把矛盾的状态一起发给界面。
function failActiveBranches(job, error) {
  const branches = job.branches && typeof job.branches === 'object' ? job.branches : null;
  if (!branches) return [];
  const failed = [];
  for (const [name, branch] of Object.entries(branches)) {
    if (!isActiveJobStatus(branch.status)) continue;
    branch.status = 'failed';
    branch.error = String(error || '').slice(0, 500);
    failed.push(name);
  }
  return failed;
}

function failGoRefresh(ctx, job, error) {
  const text = String(error || '刷新失败').slice(0, 500);
  job.status = 'failed';
  job.error = text;
  const failed = failActiveBranches(job, text);
  if (failed.length > 0) job.failedBranches = failed;
  job.finishedAt = Date.now();
  job.updatedAt = job.finishedAt;
  emitAccountRefreshJobEvent(ctx, job);
}

// 走 Go 的异步作业；返回 true 表示这次刷新已经由 Go 收尾（含失败），
// 返回 false 表示 Go 明确不可用，调用方应回退本地三段实现。
async function runGoAccountRefresh(ctx, job, goHost) {
  const scope = job.scope === 'usage' ? 'usage' : 'account';
  const start = scope === 'usage'
    ? goHost.refreshAccountUsageWebUI
    : goHost.refreshAccountWebUI;
  let started;
  try {
    started = await start(job.provider, job.accountRef);
  } catch (_error) {
    // 宿主内部抛错（例如管理客户端构造失败）等价于 Go 不可用。
    return false;
  }
  if (started && String(started.errorCode || '') === 'timeout') {
    // POST 超时：Go 可能已经把这次刷新跑起来了，回退只会重复打上游。
    failGoRefresh(ctx, job, '刷新超时');
    return true;
  }
  if (isGoRefreshUnavailable(started)) return false;
  if (!started.ok) {
    // Go 有明确回包（400/500…）：它确实处理过这次请求，不再回退。
    failGoRefresh(ctx, job, readGoErrorText(started, '刷新失败'));
    return true;
  }
  let snapshot = started.data && started.data.job;
  if (!snapshot) {
    failGoRefresh(ctx, job, 'Go 未返回刷新作业快照');
    return true;
  }
  const deadline = Date.now() + GO_REFRESH_POLL_TIMEOUT_MS;
  while (isActiveJobStatus(String(snapshot.status || ''))) {
    if (Date.now() >= deadline) {
      // 等不到终态：Go 可能还在跑，同样不回退。
      failGoRefresh(ctx, job, '刷新超时');
      return true;
    }
    await delay(GO_REFRESH_POLL_INTERVAL_MS);
    if (typeof goHost.getRefreshJob !== 'function') {
      failGoRefresh(ctx, job, 'Go 未提供刷新进度查询');
      return true;
    }
    let polled = null;
    try {
      polled = await goHost.getRefreshJob(String(snapshot.id || ''));
    } catch (_error) {
      polled = null;
    }
    if (polled && polled.ok && polled.data && polled.data.job) {
      snapshot = polled.data.job;
      continue;
    }
    // 作业在 Go 侧查不到（进程重启 / 已过保留期）：再等也不会有结果。
    if (Number((polled && polled.status) || 0) === 404) {
      failGoRefresh(ctx, job, '刷新作业已失效');
      return true;
    }
    // 其它失败（网络抖动 / 5xx）继续轮询，整体上限由 deadline 兜底。
  }
  applyGoJobSnapshot(job, snapshot);
  if (!GO_REFRESH_TERMINAL_STATUSES.has(job.status)) {
    // 形状异常时别让界面一直转圈。
    job.status = 'failed';
    job.error = job.error || '刷新作业状态异常';
  }
  job.finishedAt = job.finishedAt || Date.now();
  job.updatedAt = job.updatedAt || job.finishedAt;
  // Go 已把新快照落库，立刻强制重读一次规范源让账号行尽快跟上。
  // 不 await：它只影响展示，失败也不该拖住终态事件。
  const livePrivate = liveAccountSource && liveAccountSource.__private;
  if (livePrivate && typeof livePrivate.refreshAccountsFromCanonicalSource === 'function') {
    livePrivate.refreshAccountsFromCanonicalSource(ctx, { force: true }).catch(() => {});
  }
  emitAccountRefreshJobEvent(ctx, job);
  return true;
}

async function refreshAccountRecord(ctx, job, options) {
  const account = await refreshLiveAccountRecord(ctx, job.provider, job.accountRef, options);
  if (!account) throw new Error('account_not_found');
}

// 轻探测（模型目录）成功是「凭据/连通性可用」的直接证据：运行态门禁会自动清掉可推翻的
// 阻塞（见 account-runtime-gate 的 observeProbeSuccess）。这里只回报事实，不自己改状态。
function readRuntimeStatus(ctx, job) {
  const accounts = ctx && ctx.state && ctx.state.accounts && ctx.state.accounts[job.provider];
  if (!Array.isArray(accounts)) return '';
  const account = accounts.find((item) => String(item && item.accountRef || '') === job.accountRef);
  return account ? deriveAccountRuntimeStatus(account).status : '';
}

function createRefreshBranches(ctx, job, apiKeyMode) {
  return {
    status: () => refreshAccountRecord(ctx, job, { skipUsageRefresh: true }),
    models: async () => {
      if (!MODEL_CATALOG_PROVIDERS.has(job.provider)) return 'skipped';
      const statusBefore = readRuntimeStatus(ctx, job);
      const started = startModelCatalogRefreshJob(ctx, { accountRef: job.accountRef });
      await started.job.completion;
      const error = started.job.error || started.job.catalog?.errorsByAccountRef?.[job.accountRef];
      if (started.job.status === 'failed' || error) throw new Error(error || 'model_catalog_refresh_failed');
      if (statusBefore && statusBefore !== 'healthy' && readRuntimeStatus(ctx, job) === 'healthy') {
        job.recovered = true;
      }
    },
    usage: async () => {
      if (apiKeyMode) return 'skipped';
      const statusBefore = readRuntimeStatus(ctx, job);
      await refreshAccountRecord(ctx, job, { skipRuntimeReload: true });
      const probe = typeof ctx.getLastUsageProbeState === 'function'
        ? ctx.getLastUsageProbeState(job.provider, job.accountRef)
        : null;
      if (probe && Number(probe.checkedAt) >= job.createdAt && probe.error) {
        throw new Error(String(probe.error));
      }
      // 探测成功可能清掉了运行态阻塞（agy 地区资格块：探测端点就是做资格判定的 code-assist 端点，
      // 见 account/state-service 的 isAgyRegionBlock 分支）。正常账号无需额外动作；被阻塞的账号
      // 探测后立刻重载运行池，把恢复落到内存与界面并回报「已自动恢复调度」（与 models 分支同形）。
      if (statusBefore && statusBefore !== 'healthy') {
        await refreshAccountRecord(ctx, job, { skipUsageRefresh: true });
        if (readRuntimeStatus(ctx, job) === 'healthy') {
          job.recovered = true;
        }
      }
    }
  };
}

// 本地三段实现：Go 明确不可用时的回退路径，行为与接入 Go 之前完全一致。
async function runLocalAccountRefresh(ctx, job, apiKeyMode) {
  // 先排入全部分支，再等待结果；单分支失败不取消其他刷新。
  await Promise.allSettled(Object.entries(createRefreshBranches(ctx, job, apiKeyMode)).map(async ([name, refresh]) => {
    try {
      const result = await Promise.resolve().then(refresh);
      job.branches[name].status = result === 'skipped' ? 'skipped' : 'succeeded';
    } catch (error) {
      job.branches[name].status = 'failed';
      job.branches[name].error = String(error?.message || error || 'unknown').slice(0, 500);
    }
    job.updatedAt = Date.now();
    emitAccountRefreshJobEvent(ctx, job);
  }));
  const failures = Object.entries(job.branches).filter(([, branch]) => branch.status === 'failed');
  const succeeded = Object.entries(job.branches).filter(([, branch]) => branch.status === 'succeeded');
  // 作业成败按**整体**判定，而不是「任一分支失败即失败」：三条分支（状态/模型/额度）
  // 互相独立、各自出网，一条失败不该把另外两条的成功抹掉，更不该让界面弹「刷新失败」
  // 掩盖已完成的部分。只有**全军覆没**才是真的失败。
  // 部分失败仍如实带出去：failedBranches 让界面能说清「哪一面失败了」，而不是笼统报错。
  job.status = (failures.length > 0 && succeeded.length === 0) ? 'failed' : 'succeeded';
  job.error = failures.map(([name, branch]) => `${BRANCH_LABELS[name]}：${branch.error}`).join('；');
  job.failedBranches = failures.map(([name]) => name);
  job.finishedAt = Date.now();
  job.updatedAt = job.finishedAt;
  emitAccountRefreshJobEvent(ctx, job);
}

async function runAccountRefresh(ctx, job, apiKeyMode) {
  job.status = 'running';
  job.updatedAt = Date.now();
  Object.values(job.branches).forEach((branch) => { branch.status = 'running'; });
  emitAccountRefreshJobEvent(ctx, job);
  // 优先交给 Go：对外仍是 202 + job + SSE，执行与作业表在 Go 进程内。
  // 只有 Go 明确不可用时才回退本地三段实现（见 isGoRefreshUnavailable）。
  const goHost = readGoRefreshHost(ctx);
  if (goHost && await runGoAccountRefresh(ctx, job, goHost)) return;
  if (job.goOnly) {
    // 不该静默回退：本地三段需要 Node 凭据，而 Go 独有账号的凭据只在 Go 库里。
    failGoRefresh(ctx, job, 'Go Core 不可用，无法刷新该账号');
    return;
  }
  await runLocalAccountRefresh(ctx, job, apiKeyMode);
}

function startAccountRefresh(ctx, provider, accountRef, options = {}) {
  const active = findActiveAccountRefreshJob(provider, accountRef, 'account');
  if (active) return { job: active, alreadyRunning: true };

  const stateRow = ctx.accountStateIndex?.getAccountState(accountRef);
  const apiKeyMode = detectStoredApiKeyMode(ctx, provider, accountRef, stateRow);
  const now = Date.now();
  const job = {
    id: makeAccountRefreshJobId(provider, accountRef),
    provider,
    accountRef,
    scope: 'account',
    status: 'queued',
    // Go 独有账号没有 Node 凭据，本地三段实现无从执行：Go 不可用时直接落失败。
    goOnly: options.goOnly === true,
    branches: Object.fromEntries(Object.keys(BRANCH_LABELS).map((name) => [name, { status: 'queued', error: '' }])),
    createdAt: now,
    updatedAt: now,
    finishedAt: 0,
    error: ''
  };
  accountRefreshJobs.set(job.id, job);
  emitAccountRefreshJobEvent(ctx, job);
  const timer = setTimeout(() => {
    runAccountRefresh(ctx, job, apiKeyMode).catch(() => {});
  }, 0);
  timer.unref?.();
  return { job, alreadyRunning: false };
}

function handleRefreshAccountRequest(ctx) {
  const parsed = parseAccountRoute(ctx.pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/refresh$/);
  if (!parsed || !SUPPORTED_SERVER_PROVIDERS.includes(parsed.provider)) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: parsed ? 'unsupported_provider' : 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  // Go 独有账号（Node 账号库没有、Go 有）：刷新本来就由 Go 执行，Node 只放行。
  const goOnly = !accountExists(ctx, provider, accountRef);
  if (goOnly && !goOnlyAccountExists(ctx, provider, accountRef)) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const started = startAccountRefresh(ctx, provider, accountRef, { goOnly });
  ctx.writeJson(ctx.res, 202, {
    ok: true,
    accepted: true,
    alreadyRunning: started.alreadyRunning,
    job: serializeAccountRefreshJob(started.job)
  });
  return true;
}

module.exports = { handleRefreshAccountRequest };
