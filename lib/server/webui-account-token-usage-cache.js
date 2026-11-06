'use strict';

// 账号行 token 用量的缓存读写。
//
// **角色（2026-11-06 起）：降级与刷新来源**。页面默认由 Go 的
// /v1/management/accounts/{ref}/token-usage 提供（见 account-token-usage-go-source），
// 这里的缓存只在 Go 不可用时接管行装配，同时仍是刷新任务写入的落地点。
// 因此它不是死代码：readCachedAccountTokenUsage 有两个生产调用方
// （readAccountTokenUsage 的降级分支、updateCachedAccountTokenUsage 的增量合并）。

const { readCacheJson, writeCacheJson } = require('./webui-cache-store');
const {
  ACCOUNT_TOKEN_USAGE_DIMENSIONS,
  normalizeAccountTokenUsageDimensions,
  normalizeAccountTokenUsageValue
} = require('../usage/account-token-usage');

const ACCOUNT_TOKEN_USAGE_CACHE_FILE = 'webui-account-token-usage.json';
// v3 起多了 `total`（累计）维度；旧版本缓存里没有这个字段，读到就丢弃等下一次刷新重算，
// 否则界面会把"从没统计过"显示成 0。
const ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION = 3;

function normalizeAccountRef(value) {
  const accountRef = String(value || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(accountRef) ? accountRef : '';
}

function cloneAccountTokenUsageCache(cache) {
  const dimensions = normalizeAccountTokenUsageDimensions(cache && cache.dimensions);
  const sourceAccounts = cache && cache.accounts && typeof cache.accounts === 'object'
    ? cache.accounts
    : {};
  const accounts = {};
  Object.entries(sourceAccounts).forEach(([accountRef, value]) => {
    const normalizedRef = normalizeAccountRef(accountRef);
    const normalizedValue = normalizeAccountTokenUsageValue(value, dimensions);
    if (normalizedRef && normalizedValue) accounts[normalizedRef] = normalizedValue;
  });
  return {
    schemaVersion: ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION,
    generatedAt: Number(cache && cache.generatedAt) || 0,
    dimensions,
    accounts
  };
}

function readAccountTokenUsageCache(ctx) {
  const raw = readCacheJson(ctx, ACCOUNT_TOKEN_USAGE_CACHE_FILE);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Number(raw.schemaVersion) !== ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION) return null;
  return cloneAccountTokenUsageCache(raw);
}

function writeAccountTokenUsageCache(ctx, usageByAccount, options = {}) {
  const generatedAt = Number(options.generatedAt);
  const cache = cloneAccountTokenUsageCache({
    schemaVersion: ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION,
    generatedAt: Number.isFinite(generatedAt) && generatedAt >= 0 ? generatedAt : Date.now(),
    dimensions: options.dimensions || ACCOUNT_TOKEN_USAGE_DIMENSIONS,
    accounts: usageByAccount
  });
  writeCacheJson(ctx, ACCOUNT_TOKEN_USAGE_CACHE_FILE, cache);
  return cache;
}

module.exports = {
  ACCOUNT_TOKEN_USAGE_CACHE_FILE,
  ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION,
  cloneAccountTokenUsageCache,
  readAccountTokenUsageCache,
  writeAccountTokenUsageCache
};
