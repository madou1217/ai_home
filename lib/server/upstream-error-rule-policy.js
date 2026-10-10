'use strict';

const { matchUpstreamErrorRule } = require('../account/upstream-error-rules');
const { API_KEY_REJECTED_COOLDOWN_MS } = require('./account-runtime-state');

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
    cooldownMs: hard ? 0 : rule.kind === 'auth_invalid'
      ? (account.apiKeyMode ? API_KEY_REJECTED_COOLDOWN_MS : 365 * 86400000)
      : rule.kind === 'rate_limited' ? 300000 : 60000,
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
