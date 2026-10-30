'use strict';

// 模型发现所用的账号集合 = 运行时账号池 + 只参与模型发现的账号。
//
// CodeBuddy / WorkBuddy 家族按设计不进运行时账号池（网关不为它们路由推理，见
// docs/architecture/codebuddy-family-credential-model.md），但它们的账号页和会话仍需要模型列表。
// 模型发现、缓存合并、后台探测调度原先都只遍历 state.accounts，家族账号永远「待探测」。
// 这里把两路来源合在一处，调用方不再各自遍历 state.accounts。

const { listAccountCredentialRecords } = require('./account-credential-store');
const { isCodebuddyFamilyProvider, summarizeCodebuddyAuth } = require('../account/codebuddy-account-status');
const { listProvidersByCapability } = require('../provider-catalog');

// 只参与模型发现的 provider：有原生 CLI 模型探测能力、但不在运行时账号池里。
const DISCOVERY_ONLY_PROVIDERS = Object.freeze(
  listProvidersByCapability('modelCatalog').filter(isCodebuddyFamilyProvider)
);

function poolAccounts(state, provider) {
  const accounts = state && state.accounts && state.accounts[provider];
  return Array.isArray(accounts) ? accounts : [];
}

// 家族账号来自凭据库（每个 provider 一次 SQL）。10k 账号规模下，模型发现、后台调度、
// WebUI 投影会在每个 tick / 每个请求各查一遍。凭据库不会在两次生命周期事件之间
// 自己变化，因此按 provider 缓存 30s；导入/启用/删除等事件由监听者显式失效。
const DISCOVERY_ONLY_CACHE_TTL_MS = 30 * 1000;
const discoveryOnlyCache = new Map();

function invalidateDiscoveryOnlyAccounts() {
  discoveryOnlyCache.clear();
}

// 已登录的家族账号（按 DB 凭据判定，与账号页同一口径）。读不到 DB 时返回空，不影响池内账号。
function listDiscoveryOnlyAccounts(deps, provider, options = {}) {
  if (!DISCOVERY_ONLY_PROVIDERS.includes(provider)) return [];
  if (!deps || !deps.fs || !deps.aiHomeDir) return [];
  const cacheKey = `${deps.aiHomeDir}|${provider}`;
  const now = Date.now();
  const cached = discoveryOnlyCache.get(cacheKey);
  if (cached && options.fresh !== true && cached.expiresAt > now) return cached.accounts;
  let records = [];
  try {
    records = listAccountCredentialRecords(deps.fs, deps.aiHomeDir, provider) || [];
  } catch (_error) {
    return [];
  }
  const accounts = records
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
  discoveryOnlyCache.set(cacheKey, { accounts, expiresAt: now + DISCOVERY_ONLY_CACHE_TTL_MS });
  return accounts;
}

// pool.concat(extra) 每次都会新建数组，调用方（如探测索引）按数组身份判断
// 「账号集合变没变」。这里按 pool 数组缓存合并结果：池不变、家族列表不变时返回同一数组。
const combinedAccountsCache = new WeakMap();

function listModelDiscoveryAccounts(state, provider, deps, options = {}) {
  const pool = poolAccounts(state, provider);
  const extra = listDiscoveryOnlyAccounts(deps, provider, options);
  if (extra.length === 0) return pool;
  // 先查合并缓存再算差集：否则每次调用都要 O(pool + extra) 扫一遍。
  const cached = combinedAccountsCache.get(pool);
  if (cached && cached.extra === extra) return cached.combined;
  const seen = new Set(pool.map((account) => String(account && account.accountRef || '').trim()));
  const missing = extra.filter((account) => !seen.has(account.accountRef));
  if (missing.length === 0) {
    combinedAccountsCache.set(pool, { extra, combined: pool });
    return pool;
  }
  const combined = pool.concat(missing);
  combinedAccountsCache.set(pool, { extra, combined });
  return combined;
}

function listModelDiscoveryProviders(state, deps) {
  const providers = new Set(Object.keys((state && state.accounts) || {}));
  if (deps && deps.fs && deps.aiHomeDir) DISCOVERY_ONLY_PROVIDERS.forEach((provider) => providers.add(provider));
  return Array.from(providers);
}

module.exports = {
  DISCOVERY_ONLY_PROVIDERS,
  invalidateDiscoveryOnlyAccounts,
  listDiscoveryOnlyAccounts,
  listModelDiscoveryAccounts,
  listModelDiscoveryProviders
};
