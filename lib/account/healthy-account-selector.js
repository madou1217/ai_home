'use strict';

// 「拿一个健康账号」的唯一封装。
//
// 账号池的设计理念（docs/architecture/account-request-scheduling.md）是：
// 账号的健康度**随时在变**，所以任何「加载池时算好的结论」都不能当事实用。
// 选号必须每次按**当前时刻**重新求值：
//
//   1. 生命周期：status=up、configured、api-key 是否允许；
//   2. 运行态：auth_invalid / rate_limited / overloaded / 网络 / 5xx / routingBlock；
//   3. 冷却：账号级 cooldownUntil 与 (账号, 模型) 的 modelCooldowns；
//   4. 额度：remainingPct <= 0、后台阈值停池、account-usage-gate 的快照门禁；
//   5. 模型：指定模型时优先「目录里有它」的账号；目录未知 ≠ 不支持（弱证据放行）。
//
// 这个模块只做**纯判定 + 排序**，不读库、不发请求、不写状态。调用方把候选账号
// 交进来（CLI 从 account_state 读，server 从运行池拿），并负责把 runtimeState
// 展开到账号对象上；本模块按传入的 now 现算健康度。
//
// 返回值统一是 evaluation：
//   { healthy, status, reason, accountRef, provider, cliAccountId,
//     remainingPct, modelSupport, retryAtMs, runtime }
// 这样调用方既能 pickHealthyAccount 直接取最好的，也能把拒绝原因展示给用户。

const {
  deriveAccountRuntimeStatus,
  getAccountModelCooldownUntil
} = require('../server/account-runtime-state');
const { evaluateAccountUsageGate } = require('../server/account-usage-gate');
const { modelIdsMatch } = require('../server/model-id');
const { getMinRemainingPctFromUsageSnapshot } = require('./usage-remaining');

// 未知额度不等于耗尽（与选号器「未知取中性权重」同一口径）。排序时它位于
// 高额度与低额度之间，既不会被当成满额，也不会被当成 0%。
const UNKNOWN_REMAINING_PCT = 50;
const HEALTHY = 'healthy';
const UNKNOWN_RUNTIME = 'unknown';

function normalizeText(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function readOptionalNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeRefSet(input) {
  if (input instanceof Set) return input;
  if (Array.isArray(input)) return new Set(input.map((item) => normalizeText(item)).filter(Boolean));
  return new Set();
}

// runtimeState 可能是 index 行里的嵌套对象，也可能是 server 池账号上的平铺字段。
// 两者都接受：把嵌套对象展开到顶层，后续运行态判定只认一套形状。
function normalizeRuntimeAccount(account) {
  if (!account || typeof account !== 'object') return account;
  const runtimeState = account.runtimeState;
  if (!runtimeState || typeof runtimeState !== 'object') return account;
  return { ...account, ...runtimeState, runtimeState };
}

function readRemainingPct(account) {
  const direct = readOptionalNumber(account && account.remainingPct);
  if (Number.isFinite(direct)) return direct;
  const snapshotRemaining = getMinRemainingPctFromUsageSnapshot(account && account.usageSnapshot);
  return Number.isFinite(snapshotRemaining) ? snapshotRemaining : null;
}

function readAccountCatalog(account, options) {
  const accountRef = normalizeText(account && account.accountRef);
  if (!accountRef) return null;
  const incomplete = options.incompleteAccountRefs;
  if (incomplete && typeof incomplete.has === 'function' && incomplete.has(accountRef)) return null;

  const declared = Array.isArray(account && account.availableModels) ? account.availableModels : [];
  if (declared.length > 0) {
    return declared.map((item) => normalizeText(item)).filter(Boolean);
  }

  const catalog = options.modelCatalog;
  if (!catalog) return null;
  let models = null;
  if (catalog instanceof Map) models = catalog.get(accountRef);
  else if (typeof catalog === 'object') models = catalog[accountRef];
  if (!Array.isArray(models) || models.length === 0) return null;
  return models.map((item) => normalizeText(item)).filter(Boolean);
}

/**
 * 指定模型时该账号能不能服务。
 * @returns {boolean|null} true=目录里有；false=目录已知且没有；null=目录未知（不代表不能）
 */
function resolveModelSupport(account, model, options = {}) {
  if (!model) return null;
  if (typeof options.isModelEnabled === 'function') {
    try {
      if (options.isModelEnabled(account, model) === false) return false;
    } catch (_error) {
      // 用户开关读不出来时按未知处理：宁可让它参与候选，也不要凭空摘掉账号。
    }
  }
  const catalog = readAccountCatalog(account, options);
  if (!catalog) return null;
  return catalog.some((candidate) => modelIdsMatch(candidate, model));
}

function reject(evaluation, status, reason, extra = {}) {
  return {
    ...evaluation,
    healthy: false,
    status: normalizeText(status, 'unavailable'),
    reason: normalizeText(reason, normalizeText(status, 'unavailable')),
    ...extra
  };
}

/**
 * 判定一个账号此刻是否健康。
 *
 * @param {object} rawAccount 账号对象（可带 runtimeState 嵌套）
 * @param {object} [options]
 * @param {string} [options.provider] 覆盖账号上的 provider
 * @param {string} [options.model] 请求模型；空 = 不区分模型
 * @param {number} [options.now] 判定时刻（测试注入）
 * @param {boolean} [options.allowApiKey=true] 是否允许 API Key 账号
 * @param {boolean} [options.requireModel=false] 模型不支持时是否直接判不健康
 * @param {object|Map} [options.modelCatalog] accountRef -> 模型 id 数组
 * @param {Set<string>} [options.incompleteAccountRefs] 目录残缺的账号（不做否定判断）
 * @param {Function} [options.isModelEnabled] (account, model) => boolean
 * @returns {ReturnType<typeof buildEvaluation>}
 */
function evaluateAccountHealth(rawAccount, options = {}) {
  const account = normalizeRuntimeAccount(rawAccount);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const provider = normalizeText(
    account && account.provider ? account.provider : options.provider
  ).toLowerCase();
  const model = normalizeText(options.model);
  const accountRef = normalizeText(account && account.accountRef);
  const cliAccountId = normalizeText(account && account.cliAccountId);
  const base = buildEvaluation({ account, accountRef, provider, cliAccountId, now, model });

  if (!account || typeof account !== 'object') {
    return reject(base, 'missing_account', 'account_missing');
  }
  if (!accountRef) {
    return reject(base, 'missing_account_ref', 'account_ref_missing');
  }
  const lifecycle = normalizeText(account.status, 'up').toLowerCase();
  if (lifecycle !== 'up' && lifecycle !== 'enabled') {
    return reject(base, 'account_disabled', lifecycle || 'account_disabled');
  }
  if (account.configured === false) {
    return reject(base, 'unconfigured', 'account_unconfigured');
  }
  if (account.apiKeyMode && options.allowApiKey === false) {
    return reject(base, 'api_key_not_allowed', 'api_key_account_excluded');
  }

  // 运行态以**当前时刻**重算：持久态里的 until 到期就应自动恢复，不能沿用
  // 加载池时的旧结论。blocked_by_runtime_status 更只是建池快照，运行时重算优先。
  const runtime = deriveAccountRuntimeStatus(account, now);
  base.runtime = runtime;
  if (runtime && runtime.status && runtime.status !== HEALTHY && runtime.status !== UNKNOWN_RUNTIME) {
    return reject(base, `runtime:${runtime.status}`, runtime.reason || runtime.status, {
      retryAtMs: Number(runtime.until) || 0
    });
  }

  if (model) {
    const cooldownUntil = getAccountModelCooldownUntil(account, model, now);
    if (cooldownUntil > now) {
      return reject(base, 'model_cooldown', `model_cooling_down:${model}`, {
        retryAtMs: cooldownUntil
      });
    }
  }

  const remainingPct = readRemainingPct(account);
  if (!account.apiKeyMode && Number.isFinite(remainingPct) && remainingPct <= 0) {
    return reject(base, 'quota_exhausted', 'usage_exhausted', { remainingPct });
  }

  // CLI 侧 derived state 的结论（blocked_by_policy / blocked_by_quota / …）。
  // blocked_by_runtime_status 是旧快照，交给上面的运行态重算，不能重复拦。
  const schedulableStatus = normalizeText(account.schedulableStatus);
  if (
    schedulableStatus
    && schedulableStatus !== 'schedulable'
    && schedulableStatus !== 'blocked_by_runtime_status'
  ) {
    return reject(base, schedulableStatus, account.schedulableReason || schedulableStatus, { remainingPct });
  }

  const quotaStatus = normalizeText(account.quotaStatus).toLowerCase();
  if (quotaStatus === 'exhausted') {
    return reject(base, 'quota_exhausted', 'usage_exhausted', { remainingPct });
  }

  // server 装配了额度门禁时以它为准（读最新快照）；CLI 没装门禁则返回 ALLOW，
  // 上面的 derived state / remainingPct 已经覆盖 CLI 的额度事实。
  const usageGate = evaluateAccountUsageGate(account, model);
  if (usageGate && usageGate.schedulable === false) {
    return reject(base, usageGate.status || 'blocked_by_quota', usageGate.reason || 'usage_gate_blocked', {
      remainingPct: Number.isFinite(Number(usageGate.remainingPct)) ? Number(usageGate.remainingPct) : remainingPct,
      retryAtMs: Number(usageGate.resetAtMs) || 0
    });
  }

  const modelSupport = resolveModelSupport(account, model, options);
  if (model && modelSupport === false && options.requireModel === true) {
    return reject(base, 'model_unsupported', `model_unsupported:${model}`, { modelSupport, remainingPct });
  }

  return {
    ...base,
    healthy: true,
    status: HEALTHY,
    reason: '',
    retryAtMs: 0,
    remainingPct,
    modelSupport
  };
}

function buildEvaluation(input) {
  return {
    account: input.account,
    accountRef: input.accountRef,
    provider: input.provider,
    cliAccountId: input.cliAccountId,
    now: input.now,
    model: input.model,
    healthy: false,
    status: 'unknown',
    reason: '',
    remainingPct: null,
    modelSupport: null,
    retryAtMs: 0,
    runtime: { status: HEALTHY, until: 0, reason: '' }
  };
}

function remainingSortValue(evaluation) {
  const value = readOptionalNumber(evaluation && evaluation.remainingPct);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : UNKNOWN_REMAINING_PCT;
}

function modelSupportRank(evaluation) {
  if (evaluation && evaluation.modelSupport === true) return 0;
  if (evaluation && evaluation.modelSupport === null) return 1;
  return 2;
}

function accountLoad(account, activity, provider) {
  if (!activity || typeof activity.selectionLoad !== 'function') return 0;
  try {
    const load = activity.selectionLoad(provider, account && account.accountRef);
    if (!load) return 0;
    return Number(load.inFlight || 0) + Number(load.rate || 0) / Math.max(1, Number(load.windowMs || 0) / 1000);
  } catch (_error) {
    return 0;
  }
}

function compareEvaluations(left, right, options = {}) {
  // 1. 有模型时先看能不能服务：不支持该模型的账号排最后（但仍可作为「没有更好选择」的兜底）。
  const modelRank = modelSupportRank(left) - modelSupportRank(right);
  if (modelRank !== 0) return modelRank;
  // 2. OAuth 账号优先于 API Key（与 CLI 既有选号语义一致）。API Key 的额度通常
  //    未知，让它凭「未知=中性 50」压过真实的低额度 OAuth 账号会改变既有行为。
  const leftApiKey = left.account && left.account.apiKeyMode ? 1 : 0;
  const rightApiKey = right.account && right.account.apiKeyMode ? 1 : 0;
  if (leftApiKey !== rightApiKey) return leftApiKey - rightApiKey;
  // 3. 用量足优先。
  const remainingDelta = remainingSortValue(right) - remainingSortValue(left);
  if (remainingDelta !== 0) return remainingDelta;
  // 4. 负载低优先（调用方给 activity 时）。
  const activity = options.accountActivity;
  const loadDelta = accountLoad(left.account, activity, left.provider)
    - accountLoad(right.account, activity, right.provider);
  if (loadDelta !== 0) return loadDelta;
  // 5. 连续失败少 / 更久没失败优先。
  const leftFailures = Number(left.account && left.account.consecutiveFailures) || 0;
  const rightFailures = Number(right.account && right.account.consecutiveFailures) || 0;
  if (leftFailures !== rightFailures) return leftFailures - rightFailures;
  const leftLastFailure = Number(left.account && left.account.lastFailureAt) || 0;
  const rightLastFailure = Number(right.account && right.account.lastFailureAt) || 0;
  if (leftLastFailure !== rightLastFailure) return leftLastFailure - rightLastFailure;
  // 6. 调用方声明的 provider 偏好（家族换号时当前 CLI 优先，避免无谓切站）。
  const preferred = Array.isArray(options.providerPreference) ? options.providerPreference : [];
  const leftProviderRank = preferred.indexOf(left.provider);
  const rightProviderRank = preferred.indexOf(right.provider);
  const leftRank = leftProviderRank < 0 ? preferred.length : leftProviderRank;
  const rightRank = rightProviderRank < 0 ? preferred.length : rightProviderRank;
  if (leftRank !== rightRank) return leftRank - rightRank;
  // 7. 稳定兜底：数字账号 id 优先按数值，最后按 accountRef。
  const leftId = Number(left.cliAccountId);
  const rightId = Number(right.cliAccountId);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
  return String(left.accountRef || '').localeCompare(String(right.accountRef || ''));
}

/**
 * 对候选账号逐个求健康度并排序。
 * 默认只返回健康账号；includeUnhealthy=true 时返回全部并按「健康优先、其余按原因」排序。
 */
function rankHealthyAccounts(accounts, options = {}) {
  const pool = Array.isArray(accounts) ? accounts : [];
  const evaluations = pool.map((account) => evaluateAccountHealth(account, options));
  const healthy = evaluations.filter((item) => item.healthy);
  healthy.sort((left, right) => compareEvaluations(left, right, options));
  if (options.includeUnhealthy !== true) return healthy;
  const unhealthy = evaluations.filter((item) => !item.healthy);
  unhealthy.sort((left, right) => {
    const leftRemaining = remainingSortValue(left);
    const rightRemaining = remainingSortValue(right);
    if (leftRemaining !== rightRemaining) return rightRemaining - leftRemaining;
    return String(left.accountRef || '').localeCompare(String(right.accountRef || ''));
  });
  return healthy.concat(unhealthy);
}

/** 取一个最健康的账号；没有健康账号返回 null。 */
function pickHealthyAccount(accounts, options = {}) {
  const ranked = rankHealthyAccounts(accounts, options);
  return ranked.length > 0 ? ranked[0] : null;
}

/** 把拒绝原因压缩成一行，供「没有可切换账号」提示使用。 */
function summarizeRejections(evaluations) {
  const counts = new Map();
  (Array.isArray(evaluations) ? evaluations : []).forEach((item) => {
    if (!item || item.healthy) return;
    const key = normalizeText(item.status, 'unavailable');
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
}

module.exports = {
  UNKNOWN_REMAINING_PCT,
  evaluateAccountHealth,
  pickHealthyAccount,
  rankHealthyAccounts,
  summarizeRejections
};
