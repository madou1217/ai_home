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

const { getProviderCapability, listProviders } = require('../../providers');
const { runQoderDailyClaim } = require('./qoder-daily');
const { runZcodePlanClaim } = require('./zcode-plan');

// handler id → 实现。与 model-discovery 的 handler 词汇表同一形态：描述符声明 id，
// 组合根提供实现；描述符写错 id 时执行期 fail-closed。
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

function readActivityCapability(provider) {
  const capability = getProviderCapability(normalizeText(provider).toLowerCase(), 'activity');
  if (!capability || capability.supported !== true) return null;
  return capability;
}

/** 倒排索引：声明了 activity 能力（且 supported）的 provider。 */
function listActivityProviders() {
  return listProviders('activity').filter((provider) => Boolean(readActivityCapability(provider)));
}

/** 给 UI / CLI 展示的动作清单（不含 handler —— 那是宿主实现细节）。 */
function listActivityActions(provider) {
  const capability = readActivityCapability(provider);
  if (!capability) return [];
  return capability.actions.map((action) => ({
    id: action.id,
    label: action.label,
    description: action.description || '',
    // 是否**对外提供定时调度**（计划任务菜单据此列出可选事件）+ 该动作的防抖窗口。
    // 声明来自 provider 描述符（见 lib/providers/contract.js），这里只透传、不判断。
    schedulable: action.schedulable === true,
    ...(Number(action.scheduleDebounceMs) > 0 ? { scheduleDebounceMs: Number(action.scheduleDebounceMs) } : {})
  }));
}

function getActivityAction(provider, actionId) {
  const capability = readActivityCapability(provider);
  if (!capability) return null;
  const wanted = normalizeText(actionId).toLowerCase();
  if (!wanted) return capability.actions[0] || null;
  return capability.actions.find((action) => action.id === wanted) || null;
}

/**
 * 按 provider 描述符选 handler 并执行。返回结构化结论，不抛异常。
 * `actionId` 省略时执行该 provider 的第一个动作。
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
      actionLabel: action.label
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

module.exports = {
  ACTIVITY_HANDLERS,
  getActivityAction,
  listActivityActions,
  listActivityProviders,
  runActivityClaim
};
