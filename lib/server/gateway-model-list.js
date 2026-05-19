'use strict';

const { listEnabledProviders } = require('./providers');
const {
  collectProviderModelIds
} = require('./account-capabilities');
const {
  normalizeAliasRecord
} = require('./model-alias-store');

function normalizeModelEntry(entry) {
  if (typeof entry === 'string') {
    return { id: entry, provider: '' };
  }
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || '').trim();
  if (!id) return null;
  return {
    id,
    provider: String(entry.provider || '').trim(),
    origin: String(entry.origin || '').trim(),
    source: String(entry.source || '').trim()
  };
}

function buildAliasModelEntries(aliases) {
  return (Array.isArray(aliases) ? aliases : [])
    .map((item) => normalizeAliasRecord(item))
    .filter((alias) => alias.enabled !== false && alias.alias && alias.target && !alias.alias.includes('*'))
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

function mergeGatewayModelEntries(entries, aliases) {
  const merged = new Map();
  const maskedTargets = new Set();

  buildAliasModelEntries(aliases).forEach((entry) => {
    merged.set(entry.id, entry);
    if (entry.origin) maskedTargets.add(entry.origin);
  });

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const normalized = normalizeModelEntry(entry);
    if (!normalized) return;
    if (maskedTargets.has(normalized.id) && !merged.has(normalized.id)) return;
    if (!merged.has(normalized.id)) merged.set(normalized.id, normalized);
  });

  return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function buildGatewayModelEntries(state, options = {}) {
  return buildLocalModelEntries(state, options);
}

module.exports = {
  buildAliasModelEntries,
  buildGatewayModelEntries,
  mergeGatewayModelEntries
};
