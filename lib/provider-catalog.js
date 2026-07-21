'use strict';

const catalogData = require('./provider-catalog-data.json');

const PROVIDER_DEFINITIONS = Object.freeze((catalogData.providers || []).map((provider) => Object.freeze({
  id: String(provider.id || '').trim().toLowerCase(),
  label: String(provider.label || '').trim(),
  short: String(provider.short || '').trim(),
  terminalIcon: String(provider.terminalIcon || '').trim(),
  terminalIconAsset: String(provider.terminalIconAsset || '').trim(),
  accentVar: String(provider.accentVar || '').trim(),
  softVar: String(provider.softVar || '').trim(),
  tagColor: String(provider.tagColor || '').trim()
})).filter((provider) => provider.id && provider.label));

const PROVIDER_IDS = Object.freeze(PROVIDER_DEFINITIONS.map((provider) => provider.id));

const PROVIDER_CATALOG = Object.freeze(PROVIDER_DEFINITIONS.reduce((catalog, provider) => {
  catalog[provider.id] = provider;
  return catalog;
}, {}));

const CATALOG_FALLBACK = Object.freeze({
  id: String(catalogData.fallback && catalogData.fallback.id || 'codex').trim().toLowerCase(),
  label: String(catalogData.fallback && catalogData.fallback.label || 'AI').trim(),
  short: String(catalogData.fallback && catalogData.fallback.short || 'AI').trim(),
  terminalIcon: String(catalogData.fallback && catalogData.fallback.terminalIcon || '◌').trim(),
  terminalIconAsset: String(catalogData.fallback && catalogData.fallback.terminalIconAsset || '').trim(),
  accentVar: String(catalogData.fallback && catalogData.fallback.accentVar || 'var(--color-brand)').trim(),
  softVar: String(catalogData.fallback && catalogData.fallback.softVar || 'var(--color-brand-soft)').trim(),
  tagColor: String(catalogData.fallback && catalogData.fallback.tagColor || 'blue').trim()
});

const DEPRECATED_GATEWAY_PROVIDERS = Object.freeze(
  (catalogData.deprecatedGatewayProviders || [])
    .map((provider) => String(provider || '').trim().toLowerCase())
    .filter((provider) => PROVIDER_IDS.includes(provider))
);

function normalizeProviderId(providerRaw) {
  return String(providerRaw || '').trim().toLowerCase();
}

function isKnownProvider(providerRaw) {
  return PROVIDER_IDS.includes(normalizeProviderId(providerRaw));
}

function getProviderMeta(providerRaw) {
  return PROVIDER_CATALOG[normalizeProviderId(providerRaw)] || CATALOG_FALLBACK;
}

function getProviderTerminalIcon(providerRaw) {
  return getProviderMeta(providerRaw).terminalIcon || CATALOG_FALLBACK.terminalIcon;
}

function getProviderTerminalIconAsset(providerRaw) {
  return getProviderMeta(providerRaw).terminalIconAsset || CATALOG_FALLBACK.terminalIconAsset;
}

function getProviderTerminalBadge(providerRaw) {
  const meta = getProviderMeta(providerRaw);
  const icon = meta.terminalIcon || CATALOG_FALLBACK.terminalIcon;
  const short = meta.short || meta.label || meta.id || 'AI';
  return `${icon} ${short}`;
}

function listProviderIds() {
  return PROVIDER_IDS.slice();
}

module.exports = {
  PROVIDER_DEFINITIONS,
  PROVIDER_IDS,
  PROVIDER_CATALOG,
  CATALOG_FALLBACK,
  DEPRECATED_GATEWAY_PROVIDERS,
  normalizeProviderId,
  isKnownProvider,
  getProviderMeta,
  getProviderTerminalIcon,
  getProviderTerminalIconAsset,
  getProviderTerminalBadge,
  listProviderIds
};
