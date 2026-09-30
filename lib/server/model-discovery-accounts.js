'use strict';

// 模型发现所用的账号集合 = 运行时账号池 + 只参与模型发现的账号。
//
// CodeBuddy / WorkBuddy 家族按设计不进运行时账号池（网关不为它们路由推理，见
// docs/architecture/codebuddy-family-credential-model.md），但它们的账号页和会话仍需要模型列表。
// 模型发现、缓存合并、后台探测调度原先都只遍历 state.accounts，家族账号永远「待探测」。
// 这里把两路来源合在一处，调用方不再各自遍历 state.accounts。

const { listAccountCredentialRecords } = require('./account-credential-store');
const { isCodebuddyFamilyProvider, summarizeCodebuddyAuth } = require('../account/codebuddy-account-status');

// 只参与模型发现的 provider：有原生 CLI 模型探测能力、但不在运行时账号池里。
const DISCOVERY_ONLY_PROVIDERS = Object.freeze(['workbuddy', 'workbuddycn']);

function poolAccounts(state, provider) {
  const accounts = state && state.accounts && state.accounts[provider];
  return Array.isArray(accounts) ? accounts : [];
}

// 已登录的家族账号（按 DB 凭据判定，与账号页同一口径）。读不到 DB 时返回空，不影响池内账号。
function listDiscoveryOnlyAccounts(deps, provider) {
  if (!DISCOVERY_ONLY_PROVIDERS.includes(provider) || !isCodebuddyFamilyProvider(provider)) return [];
  if (!deps || !deps.fs || !deps.aiHomeDir) return [];
  let records = [];
  try {
    records = listAccountCredentialRecords(deps.fs, deps.aiHomeDir, provider) || [];
  } catch (_error) {
    return [];
  }
  return records
    .map((record) => {
      const summary = summarizeCodebuddyAuth(provider, record && record.nativeAuth);
      if (!summary.configured) return null;
      return {
        provider,
        accountRef: String(record.accountRef || '').trim(),
        displayName: summary.accountName,
        configured: true,
        apiKeyMode: false
      };
    })
    .filter((account) => account && account.accountRef);
}

function listModelDiscoveryAccounts(state, provider, deps) {
  const pool = poolAccounts(state, provider);
  const seen = new Set(pool.map((account) => String(account && account.accountRef || '').trim()));
  const extra = listDiscoveryOnlyAccounts(deps, provider).filter((account) => !seen.has(account.accountRef));
  return extra.length > 0 ? pool.concat(extra) : pool;
}

function listModelDiscoveryProviders(state, deps) {
  const providers = new Set(Object.keys((state && state.accounts) || {}));
  if (deps && deps.fs && deps.aiHomeDir) DISCOVERY_ONLY_PROVIDERS.forEach((provider) => providers.add(provider));
  return Array.from(providers);
}

module.exports = {
  DISCOVERY_ONLY_PROVIDERS,
  listDiscoveryOnlyAccounts,
  listModelDiscoveryAccounts,
  listModelDiscoveryProviders
};
