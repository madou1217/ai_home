'use strict';

// 直连请求的**跨 provider 回落候选**。
//
// 背景（2026-10-22 真机）：`gemini-3.5-flash` 同时被 workbuddy 与 codebuddy 的账号探测到，
// 但路由只锁定**一个** provider（按绑定分选优），另一个 provider 的持有者被 provider 边界
// 完全排除。于是当选中池里的账号全部因「档位不支持该模型」（上游 11158）失败时，请求直接
// 报错 —— 明明还有别的 provider 持有同一模型、且可能有可用档位。
//
// 用户的原话：「我们做 relay 的意义在哪里？遇到问题我们的 server gateway 没有做好机制，
// 这和我们一个一个手动切换有什么区别？」
//
// 本模块把「还有谁能服务这个模型」变成显式的回落候选，交给既有的 runtimeFallback 机制
// （与别名回落同一套驱动，见 v1-router 的 aliasRuntimeFallback / retryAliasCandidate）。
//
// 设计边界：
// - 只产出**候选描述**，不做路由决策、不发请求 —— 决策仍归 v1-router；
// - 候选顺序 = 该 provider 下**可调度**账号数降序（先试更可能有档位的），再按 provider 声明顺序；
// - 当前 provider 自己排除在外（它已经试过整个池了）；
// - 目录未知的 provider 不入选：没有证据表明它能服务，凭空回落只会换来一个必然失败的请求。

const { buildModelCapabilityIndex, listAvailableAccountRefsForModelProvider } =
  require('./model-capability-index');
const { listEnabledProviders } = require('./providers');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * 列出「除当前 provider 外、还有可调度账号持有该模型」的 provider，按可用账号数降序。
 *
 * @param {{ state: object, options?: object, model: string, currentProvider: string }} input
 * @returns {Array<{ provider: string, accountCount: number }>}
 */
function listCrossProviderFallbacks(input = {}) {
  const state = input.state;
  const options = input.options || {};
  const model = normalizeText(input.model);
  const currentProvider = normalizeText(input.currentProvider).toLowerCase();
  if (!state || !model) return [];

  const index = buildModelCapabilityIndex(state, options);
  const enabled = listEnabledProviders(options.provider);

  return enabled
    .filter((provider) => normalizeText(provider).toLowerCase() !== currentProvider)
    .map((provider, order) => ({
      provider,
      // 用「当前可调度」而非「目录里有」：被熔断/额度耗尽的账号回落过去也只会失败。
      accountCount: listAvailableAccountRefsForModelProvider(index, model, provider).length,
      order
    }))
    .filter((entry) => entry.accountCount > 0)
    .sort((left, right) => (right.accountCount - left.accountCount) || (left.order - right.order))
    .map(({ provider, accountCount }) => ({ provider, accountCount }));
}

module.exports = {
  listCrossProviderFallbacks
};
