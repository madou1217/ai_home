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

const { providerCatalog, listProvidersByCapability } = require('../provider-catalog');
const { AIH_SERVER_PROFILE_ID } = require('./provider-profile-id');

const GATEWAY_PROFILE_PROVIDERS = new Set(listProvidersByCapability('gatewayProfile'));

function supportsAihServerProfile(provider) {
  return GATEWAY_PROFILE_PROVIDERS.has(normalizeProvider(provider));
}

function normalizeProvider(provider) {
  return providerCatalog.normalize(provider);
}

function buildDefaultAccountKey(provider) {
  const normalizedProvider = normalizeProvider(provider);
  return normalizedProvider ? `account:default:${normalizedProvider}` : '';
}

function buildDefaultProviderProfileKey(provider) {
  const normalizedProvider = normalizeProvider(provider);
  return normalizedProvider ? `provider:default:${normalizedProvider}` : '';
}

function readDefaultProviderProfile(fs, aiHomeDir, provider) {
  if (!supportsAihServerProfile(provider)) return '';
  const key = buildDefaultProviderProfileKey(provider);
  if (!key) return '';
  const value = String(readJsonValue(fs, aiHomeDir, key) || '').trim();
  return value === AIH_SERVER_PROFILE_ID ? value : '';
}

function writeDefaultProviderProfile(fs, aiHomeDir, provider, profile) {
  const key = buildDefaultProviderProfileKey(provider);
  const normalizedProfile = String(profile || '').trim();
  if (!key || !supportsAihServerProfile(provider) || normalizedProfile !== AIH_SERVER_PROFILE_ID) {
    throw new Error('invalid_default_provider_profile');
  }
  if (!writeJsonValue(fs, aiHomeDir, key, normalizedProfile)) {
    throw new Error('default_provider_profile_write_failed');
  }
  return true;
}

function clearDefaultProviderProfile(fs, aiHomeDir, provider) {
  const key = buildDefaultProviderProfileKey(provider);
  if (!key) return false;
  return deleteJsonValue(fs, aiHomeDir, key);
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
  AIH_SERVER_PROFILE_ID,
  buildDefaultAccountKey,
  buildDefaultProviderProfileKey,
  clearDefaultProviderProfile,
  clearDefaultAccountRef,
  readDefaultProviderProfile,
  readDefaultAccountRef,
  writeDefaultProviderProfile,
  writeDefaultAccountRef
};
