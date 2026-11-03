'use strict';

// 调度规则（账号级上游错误映射）的写入资格 —— WebUI 两个写入口共用这一份判定。
//
// 只有「第三方/自建上游的 API Key 账号」能编辑调度规则（口径见
// account/official-upstream-endpoint）：OAuth 登录态账号与指向厂商官方地址的账号
// 返回的是厂商标准错误码，内置启发式已经覆盖，没有可对齐的东西。UI 隐藏入口只是
// 体验，这里的拒绝才是边界 —— 否则手写请求仍能给官方账号塞一套注定不命中的规则，
// 而「有规则但从不命中」正是最难排查的静默失配。
//
// 返回 null 表示允许写入；否则返回可直接 writeJson 的 400 负载。

const { readAccountCredentials } = require('./account-credential-store');
const { readProviderBaseUrl } = require('../account/provider-credential-env');
const { isCustomUpstreamAccount } = require('../account/official-upstream-endpoint');
const { detectStoredApiKeyMode } = require('./webui-account-routes-state');
const { resolveAiHomeDir } = require('./webui-account-routes-utils');

const ROUTING_RULES_UNSUPPORTED_ERROR = 'routing_rules_unsupported_upstream';

function readStoredStateRow(ctx, accountRef) {
  const index = ctx && ctx.accountStateIndex;
  if (!index || typeof index.getAccountState !== 'function') return null;
  return index.getAccountState(accountRef);
}

/**
 * 判定某个账号当前是否允许编辑调度规则。
 *
 * options.baseUrl 存在时以它为准（「编辑配置」会同时改地址：一次保存把账号切到官方
 * 地址，就不能把旧规则留在账号上），缺席时读账号已存的 base URL。
 */
function resolveRoutingRulesUpstreamRejection(ctx, provider, accountRef, options = {}) {
  const stateRow = options.stateRow || readStoredStateRow(ctx, accountRef);
  const apiKeyMode = detectStoredApiKeyMode(ctx, provider, accountRef, stateRow);
  const aiHomeDir = resolveAiHomeDir(ctx);
  const storedBaseUrl = aiHomeDir
    ? readProviderBaseUrl(provider, readAccountCredentials(ctx.fs, aiHomeDir, accountRef) || {})
    : '';
  const effectiveBaseUrl = Object.prototype.hasOwnProperty.call(options, 'baseUrl')
    ? String(options.baseUrl || '').trim()
    : storedBaseUrl;
  if (isCustomUpstreamAccount({ provider, apiKeyMode, baseUrl: effectiveBaseUrl })) return null;
  return {
    ok: false,
    error: ROUTING_RULES_UNSUPPORTED_ERROR,
    code: apiKeyMode ? 'official_upstream_standard_errors' : 'oauth_account_standard_errors',
    message: apiKeyMode
      ? '该账号使用厂商官方地址，返回的是标准错误码，不需要自定义调度规则。'
      : '登录态账号使用厂商官方链路，返回的是标准错误码，不需要自定义调度规则。'
  };
}

/** 提交内容里是否真的带了规则（空数组是「清空」语义，不算带规则）。 */
function hasUpstreamErrorRulesPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const rules = payload.upstreamErrorRules;
  const groupIds = payload.upstreamErrorGroupIds;
  return (Array.isArray(rules) && rules.length > 0)
    || (Array.isArray(groupIds) && groupIds.length > 0);
}

module.exports = {
  ROUTING_RULES_UNSUPPORTED_ERROR,
  hasUpstreamErrorRulesPayload,
  resolveRoutingRulesUpstreamRejection
};
