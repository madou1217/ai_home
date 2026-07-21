'use strict';

const { listEnabledProviders } = require('./providers');
const {
  collectProviderModelIds
} = require('./account-capabilities');
const {
  normalizeAliasRecord
} = require('./model-alias-store');
const {
  applyModelCatalogSettingsToEntries,
  isAccountModelEnabled,
  isModelEnabled,
  normalizeGatewayEntry
} = require('./model-catalog-settings-store');
const { buildModelCapabilityIndex } = require('./model-capability-index');
const { aliasIsVisible } = require('./model-alias-validation');

function normalizeModelEntry(entry) {
  return normalizeGatewayEntry(entry);
}

function buildAliasModelEntries(aliases, context = {}) {
  const modelCapabilityIndex = context.modelCapabilityIndex
    || buildModelCapabilityIndex(context.state || {}, context.options || {});
  return (Array.isArray(aliases) ? aliases : [])
    .map((item) => normalizeAliasRecord(item))
    // Never advertise wildcard patterns (e.g. "claude-*") as selectable models —
    // a client can't send a glob as a model name and would be confused by it.
    // The wildcard still resolves at request time; it's just not listed.
    .filter((alias) => !String(alias.alias || '').endsWith('*'))
    .filter((alias) => aliasIsVisible(alias, {
      ...context,
      modelCapabilityIndex,
      aliases
    }))
    .map((alias) => ({
      id: alias.alias,
      origin: alias.target,
      provider: alias.provider === 'all' ? '' : alias.provider,
      source: 'alias'
    }));
}

function buildLocalModelEntries(state, options = {}) {
  const entries = [];
  listEnabledProviders(options && options.provider).forEach((provider) => {
    collectProviderModelIds(state, options, provider).forEach((id) => {
      entries.push({ id, provider, source: 'capability' });
    });
  });
  return entries;
}

function mergeGatewayModelEntries(entries, aliases, context = {}) {
  const merged = new Map();
  const settings = context.modelCatalogSettings
    || context.state && context.state.modelCatalogSettings
    || null;

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const normalized = normalizeModelEntry(entry);
    if (!normalized) return;
    if (normalized.accountRef) {
      if (!isAccountModelEnabled(settings, normalized)) return;
    } else if (!isModelEnabled(settings, normalized.id, normalized.provider)) {
      return;
    }
    if (!merged.has(normalized.id)) merged.set(normalized.id, normalized);
  });

  buildAliasModelEntries(aliases, context).forEach((entry) => {
    if (!isModelEnabled(settings, entry.id)) return;
    if (!merged.has(entry.id)) merged.set(entry.id, entry);
  });

  return applyModelCatalogSettingsToEntries(Array.from(merged.values()), settings, {
    providerMode: context.options && context.options.provider
  });
}

function buildGatewayModelEntries(state, options = {}) {
  return buildLocalModelEntries(state, options);
}

module.exports = {
  buildAliasModelEntries,
  buildGatewayModelEntries,
  mergeGatewayModelEntries
};
