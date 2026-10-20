'use strict';

// 账号活动领取的策略注册表。
//
// provider → 策略 是唯一派发表：新增一个可领取活动的 provider 只需要在这里
// 注册一行（实现放在同目录的独立模块），命令层与调度层都不需要改。
//
// 两个策略的语义差异：
//   * qoder / qodercn：每日签到，幂等（领过则 claimStatus=CLAIMED）；
//   * zcode：周末/试用套餐，非活动窗口 preview 返回空列表，领取需要验证码。

const { runQoderDailyClaim } = require('./qoder-daily');
const { runZcodePlanClaim } = require('./zcode-plan');

const CLAIM_STRATEGIES = Object.freeze({
  qoder: Object.freeze({
    provider: 'qoder',
    action: 'qoder_daily_checkin',
    label: 'Qoder daily check-in',
    run: runQoderDailyClaim
  }),
  qodercn: Object.freeze({
    provider: 'qodercn',
    action: 'qoder_daily_checkin',
    label: 'Qoder CN daily check-in',
    run: runQoderDailyClaim
  }),
  zcode: Object.freeze({
    provider: 'zcode',
    action: 'zcode_plan_claim',
    label: 'ZCode weekend / trial plan',
    run: runZcodePlanClaim
  })
});

function listClaimProviders() {
  return Object.keys(CLAIM_STRATEGIES);
}

function getClaimStrategy(provider) {
  return CLAIM_STRATEGIES[String(provider || '').trim().toLowerCase()] || null;
}

/**
 * 按 provider 选策略并执行。未知 provider 返回显式错误（不静默跳过）。
 */
async function runActivityClaim(input = {}) {
  const provider = String(input.provider || (input.record && input.record.provider) || '').trim().toLowerCase();
  const strategy = getClaimStrategy(provider);
  if (!strategy) {
    return {
      provider,
      accountRef: String(input.record && input.record.accountRef || input.accountRef || '').trim(),
      status: 'error',
      error: `claim_strategy_unsupported:${provider || 'unknown'}`
    };
  }
  return strategy.run({ ...input, provider });
}

module.exports = {
  CLAIM_STRATEGIES,
  getClaimStrategy,
  listClaimProviders,
  runActivityClaim
};
