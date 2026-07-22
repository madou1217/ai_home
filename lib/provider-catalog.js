'use strict';

const catalogData = require('./provider-catalog-data.json');

const DEFAULT_CAPABILITY_MEMBERS = Object.freeze({
  apiKeyAccount: Object.freeze(['codex', 'gemini', 'claude', 'grok', 'kimi']),
  modelCatalog: Object.freeze(['codex', 'gemini', 'claude', 'agy', 'opencode', 'qoder', 'qodercn'])
});

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

class ProviderCatalog {
  constructor({ definitions, definitionsById, fallback, deprecatedGatewayProviders, capabilityMembers }) {
    this.definitions = definitions;
    this.ids = Object.freeze(definitions.map((provider) => provider.id));
    this.definitionsById = definitionsById;
    this.fallback = fallback;
    this.deprecatedGatewayProviders = deprecatedGatewayProviders;
    this.capabilities = Object.freeze(Object.fromEntries(
      Object.entries(capabilityMembers).map(([capability, providers]) => [
        capability,
        Object.freeze(providers.filter((provider) => this.has(provider)))
      ])
    ));
    Object.freeze(this);
  }

  normalize(providerRaw) {
    const provider = normalizeProviderId(providerRaw);
    return this.has(provider) ? provider : '';
  }

  has(providerRaw) {
    return Boolean(this.definitionsById[normalizeProviderId(providerRaw)]);
  }

  get(providerRaw) {
    return this.definitionsById[normalizeProviderId(providerRaw)] || this.fallback;
  }

  list() {
    return this.definitions.slice();
  }

  listIds() {
    return this.ids.slice();
  }

  supports(providerRaw, capability) {
    const providers = this.capabilities[String(capability || '').trim()];
    return Boolean(providers && providers.includes(normalizeProviderId(providerRaw)));
  }

  listByCapability(capability) {
    const providers = this.capabilities[String(capability || '').trim()];
    return providers ? providers.slice() : [];
  }
}

const providerCatalog = new ProviderCatalog({
  definitions: PROVIDER_DEFINITIONS,
  definitionsById: PROVIDER_CATALOG,
  fallback: CATALOG_FALLBACK,
  deprecatedGatewayProviders: DEPRECATED_GATEWAY_PROVIDERS,
  capabilityMembers: DEFAULT_CAPABILITY_MEMBERS
});

function normalizeProviderId(providerRaw) {
  return String(providerRaw || '').trim().toLowerCase();
}

function isKnownProvider(providerRaw) {
  return providerCatalog.has(providerRaw);
}

function getProviderMeta(providerRaw) {
  return providerCatalog.get(providerRaw);
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
  return providerCatalog.listIds();
}

function providerSupports(providerRaw, capability) {
  return providerCatalog.supports(providerRaw, capability);
}

function listProvidersByCapability(capability) {
  return providerCatalog.listByCapability(capability);
}

module.exports = {
  ProviderCatalog,
  providerCatalog,
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
  listProviderIds,
  providerSupports,
  listProvidersByCapability
};
