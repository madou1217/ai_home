'use strict';

const { readCacheJson, writeCacheJson } = require('./webui-cache-store');
const {
  ACCOUNT_TOKEN_USAGE_DIMENSIONS,
  normalizeAccountTokenUsageDimensions,
  normalizeAccountTokenUsageValue
} = require('../usage/account-token-usage');

const ACCOUNT_TOKEN_USAGE_CACHE_FILE = 'webui-account-token-usage.json';
const ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION = 1;

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
  return cloneAccountTokenUsageCache(raw);
}

function writeAccountTokenUsageCache(ctx, usageByAccount, options = {}) {
  const cache = cloneAccountTokenUsageCache({
    schemaVersion: ACCOUNT_TOKEN_USAGE_CACHE_SCHEMA_VERSION,
    generatedAt: Number(options.generatedAt) || Date.now(),
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
