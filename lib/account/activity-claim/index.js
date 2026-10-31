'use strict';

// 账号活动领取：provider 能力描述符的消费侧（策略执行器 + handler 注册表）。
//
// 「哪些 provider 有可领取的活动」不是这里的名单，而是每个 provider 描述符自己声明的
// `activity` 能力（lib/providers/defs/<id>.js）。因此：
//   * 新增 provider = 加一段描述符，本文件与命令层都不用改；
//   * 外部 provider 描述符（<AIH_HOME_DIR>/provider-defs）同样能声明 activity；
//   * 描述符只写 handler id，实现由下面的注册表提供；未知 handler 明确失败，不静默跳过。
//
// 两个 handler 的语义差异：
//   * qoder-daily-checkin：每日签到，幂等（领过则 claimStatus=CLAIMED）；
//   * zcode-plan-claim：周末/试用套餐，非活动窗口 preview 返回空列表，领取需要验证码。
//
// 参数（账号子集、套餐类型）由描述符的 `action.params` 声明，归一与 target 过滤在
// ./params.js，选项解析在 ./options.js。本文件只做「归一 → 交给 handler」，
// 不认识任何具体参数 key 的语义。

const { listActivityProviders, listActivityActions, getActivityAction } = require('./actions');
const { normalizeActivityParams, resolveActivityTargets } = require('./params');
const { listActivityParamOptions, listActivityActionParamOptions } = require('./options');
const { summarizeActivityResults } = require('./outcomes');
const { describePlanKinds } = require('./plans');
const { runQoderDailyClaim } = require('./qoder-daily');
const { runZcodePlanClaim } = require('./zcode-plan');

// handler id → 实现。与 model-discovery 的 handler 词汇表同一形态：描述符声明 id，
// 组合根提供实现；描述符写错 id 时执行期 fail-closed。
//
// 将来若某个 provider 需要「按凭据形态预筛账号」（例如跳过 API Key 账号），
// 在这里的条目上加可选的 `resolveTargets: ({ action, params, targets }) => targets`
// 即可 —— 那是宿主实现细节，**不放进描述符**（描述符只声明有哪些参数）。
const ACTIVITY_HANDLERS = Object.freeze({
  'qoder-daily-checkin': Object.freeze({
    action: 'qoder_daily_checkin',
    run: runQoderDailyClaim
  }),
  'zcode-plan-claim': Object.freeze({
    action: 'zcode_plan_claim',
    run: runZcodePlanClaim
  })
});

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/**
 * 按 provider 描述符选 handler 并执行。返回结构化结论，不抛异常。
 * `actionId` 省略时执行该 provider 的第一个动作。
 *
 * `input.params` 按描述符 schema 归一后透传给 handler（handler 只认自己的 key）。
 */
async function runActivityClaim(input = {}) {
  const provider = normalizeText(input.provider || (input.record && input.record.provider)).toLowerCase();
  const accountRef = normalizeText(input.record && input.record.accountRef || input.accountRef);
  const action = getActivityAction(provider, input.actionId);
  if (!action) {
    return {
      provider,
      accountRef,
      actionId: normalizeText(input.actionId),
      status: 'error',
      error: normalizeText(input.actionId)
        ? `activity_action_unknown:${provider}:${normalizeText(input.actionId).toLowerCase()}`
        : `activity_unsupported:${provider || 'unknown'}`
    };
  }
  const normalized = normalizeActivityParams(action, input.params);
  if (!normalized.ok) {
    return { provider, accountRef, actionId: action.id, status: 'error', error: normalized.error };
  }
  const handler = ACTIVITY_HANDLERS[action.handler];
  if (!handler) {
    return {
      provider,
      accountRef,
      actionId: action.id,
      status: 'error',
      error: `activity_handler_unregistered:${action.handler}`
    };
  }
  let result;
  try {
    result = await handler.run({
      ...input,
      provider,
      actionId: action.id,
      actionLabel: action.label,
      params: normalized.params,
      // 分类规则是描述符数据，handler 只做求值（classifyPlan），不写死类型。
      actionKinds: Array.isArray(action.kinds) ? action.kinds : []
    });
  } catch (error) {
    // handler 约定返回结构化结论；万一抛异常也不能让 CLI/HTTP 调用方收到未捕获错误。
    return {
      provider,
      accountRef,
      actionId: action.id,
      status: 'error',
      error: `activity_handler_failed:${normalizeText(error && error.message) || 'unknown'}`
    };
  }
  if (!result || typeof result !== 'object') {
    return {
      provider,
      accountRef,
      actionId: action.id,
      status: 'error',
      error: 'activity_handler_empty_result'
    };
  }
  return {
    ...result,
    actionId: result.actionId || action.id,
    action: result.action || handler.action
  };
}

const PROBE_MAX_ACCOUNTS = 20;
const PROBE_TIMEOUT_MS = 120_000;

/**
 * 只读探测：先看清「有什么可领、是什么类型」，再决定领什么。
 *
 * 复用 handler 的 dryRun 分支（不新增第二个 handler），逐账号串行执行 ——
 * 探测同样在打上游，并发会重演 zcode 的 3012。失败不影响其他账号。
 */
async function probeActivityAction(input = {}) {
  const provider = normalizeText(input.provider).toLowerCase();
  const action = getActivityAction(provider, input.actionId);
  if (!action) {
    return { ok: false, provider, error: `activity_action_unknown:${provider}` };
  }
  if (action.supportsProbe !== true) {
    return { ok: false, provider, actionId: action.id, error: 'activity_probe_unsupported' };
  }
  const targets = Array.isArray(input.targets) ? input.targets : [];
  if (targets.length === 0) {
    return { ok: true, provider, actionId: action.id, accounts: [], plans: [], kinds: [], failures: summarizeActivityResults([]) };
  }
  const capped = targets.slice(0, PROBE_MAX_ACCOUNTS);
  const startedAt = Date.now();
  // 与调度层同一套注入习惯：测试与组合根都可以换掉实际执行器。
  const executeClaim = typeof input.runActivityClaim === 'function' ? input.runActivityClaim : runActivityClaim;
  const results = [];
  for (const target of capped) {
    if (Date.now() - startedAt > PROBE_TIMEOUT_MS) break;
    results.push(await executeClaim({
      ...input,
      provider,
      record: target.record,
      accountRef: target.record && target.record.accountRef,
      actionId: action.id,
      dryRun: true
    }));
  }

  const accounts = results.map((result) => ({
    accountRef: normalizeText(result && result.accountRef),
    status: normalizeText(result && result.status) || 'error',
    ...(result && result.error ? { error: result.error } : {}),
    ...(result && result.discovery ? { discovery: result.discovery } : {}),
    plans: Array.isArray(result && result.plans) ? result.plans : []
  }));

  // 跨账号去重：同一个 plan 可能在多个账号上可领，探测结果按 plan 聚合更可读。
  const plansById = new Map();
  for (const account of accounts) {
    for (const plan of account.plans) {
      const planId = normalizeText(plan && plan.planId);
      if (!planId) continue;
      const entry = plansById.get(planId) || {
        planId,
        name: normalizeText(plan.name),
        planKind: normalizeText(plan.planKind),
        accounts: []
      };
      if (account.accountRef && !entry.accounts.includes(account.accountRef)) {
        entry.accounts.push(account.accountRef);
      }
      if (!entry.planKind && plan.planKind) entry.planKind = normalizeText(plan.planKind);
      plansById.set(planId, entry);
    }
  }
  const plans = [...plansById.values()];
  const summary = summarizeActivityResults(results);
  return {
    ok: true,
    provider,
    actionId: action.id,
    accounts,
    plans,
    // 类型目录直接喂给 enum 选项：claimable 由本次探测决定，planIds 给出证据。
    kinds: describePlanKinds(action.kinds, plans),
    summary,
    failures: summary.failures,
    ...(targets.length > capped.length ? { truncated: targets.length - capped.length } : {})
  };
}

module.exports = {
  ACTIVITY_HANDLERS,
  PROBE_MAX_ACCOUNTS,
  PROBE_TIMEOUT_MS,
  getActivityAction,
  listActivityActions,
  listActivityProviders,
  listActivityParamOptions,
  listActivityActionParamOptions,
  normalizeActivityParams,
  resolveActivityTargets,
  probeActivityAction,
  runActivityClaim
};
