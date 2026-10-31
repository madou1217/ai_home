'use strict';

const { matchUpstreamErrorRule } = require('../account/upstream-error-rules');
const { ACCOUNT_GUESSED_COOLDOWN_MS } = require('../cli/config/constants');

function readConfiguredFailureBody(options = {}) {
  if (options.body !== undefined && options.body !== null) return options.body;
  const error = options.error;
  return error && (
    error.upstreamBody
    ?? error.responseBody
    ?? error.body
  );
}

// 规则只负责识别；状态、作用域、恢复语义由统一策略决定，不能在 UI 任意组合。
function classifyConfiguredUpstreamFailure(options) {
  const account = options.account;
  const rule = matchUpstreamErrorRule(
    account && account.upstreamErrorRules,
    options.statusCode,
    readConfiguredFailureBody(options)
  );
  if (!rule) return null;
  const hard = ['billing_blocked', 'quota_exhausted', 'permission_denied'].includes(rule.kind);
  const accountScoped = hard || rule.kind === 'auth_invalid';
  return {
    kind: rule.kind,
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    // 规则只识别类型；时长不是规则能证明的事实（旧：auth_invalid 1 年 / 密钥 30 分钟、
    // 限流 5 分钟、其它 60 秒），统一取猜测冷却。硬阻断（额度 / 账单 / 权限）仍走 routingBlock。
    cooldownMs: hard ? 0 : ACCOUNT_GUESSED_COOLDOWN_MS,
    clientStatusCode: Number(options.statusCode) >= 400 ? Number(options.statusCode) : 503,
    failureReason: rule.kind,
    detail: rule.kind,
    scope: accountScoped ? 'account' : 'model',
    shouldUnbindSession: accountScoped,
    configuredRule: true,
    matchedRule: rule.name
  };
}

module.exports = { classifyConfiguredUpstreamFailure };
