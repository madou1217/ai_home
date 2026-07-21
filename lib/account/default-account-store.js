'use strict';

const {
  deleteJsonValue,
  readJsonValue,
  writeJsonValue
} = require('../server/app-state-store');
const {
  isAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');

const ACCOUNT_PROVIDERS = new Set(['agy', 'claude', 'codex', 'gemini', 'opencode', 'grok', 'qoder', 'qodercn', 'kimi', 'kiro']);

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return ACCOUNT_PROVIDERS.has(value) ? value : '';
}

function buildDefaultAccountKey(provider) {
  const normalizedProvider = normalizeProvider(provider);
  return normalizedProvider ? `account:default:${normalizedProvider}` : '';
}

function readDefaultAccountRef(fs, aiHomeDir, provider) {
  const key = buildDefaultAccountKey(provider);
  if (!key) return '';
  const value = String(readJsonValue(fs, aiHomeDir, key) || '').trim();
  if (!isAccountRef(value)) return '';
  const account = resolveAccountRef(fs, aiHomeDir, value, { bestEffort: true });
  return account && account.provider === normalizeProvider(provider) ? value : '';
}

function writeDefaultAccountRef(fs, aiHomeDir, provider, accountRef) {
  const key = buildDefaultAccountKey(provider);
  const normalizedRef = String(accountRef || '').trim();
  const account = isAccountRef(normalizedRef)
    ? resolveAccountRef(fs, aiHomeDir, normalizedRef)
    : null;
  if (!key || !account || account.provider !== normalizeProvider(provider)) {
    throw new Error('invalid_default_account');
  }
  if (!writeJsonValue(fs, aiHomeDir, key, normalizedRef)) {
    throw new Error('default_account_write_failed');
  }
  return true;
}

function clearDefaultAccountRef(fs, aiHomeDir, provider, expectedAccountRef = '') {
  const key = buildDefaultAccountKey(provider);
  if (!key) return false;
  const expected = String(expectedAccountRef || '').trim();
  if (expected && readDefaultAccountRef(fs, aiHomeDir, provider) !== expected) return false;
  return deleteJsonValue(fs, aiHomeDir, key);
}

module.exports = {
  buildDefaultAccountKey,
  clearDefaultAccountRef,
  readDefaultAccountRef,
  writeDefaultAccountRef
};
