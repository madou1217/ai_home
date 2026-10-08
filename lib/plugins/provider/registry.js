'use strict';

const semver = require('semver');
const { PluginError, requireCondition, freezeJson } = require('../sdk');

const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const REQUIRED_CAPABILITIES = new Set(['auth', 'catalog', 'route', 'usage', 'failure']);

function validateProviderDefinition(input = {}) {
  const id = String(input.id || '').trim().toLowerCase();
  requireCondition(PROVIDER_ID.test(id), 'plugin_provider_id_invalid');
  requireCondition(!['codex', 'claude', 'agy', 'gemini', 'opencode'].includes(id), 'plugin_provider_builtin_conflict');
  requireCondition(semver.valid(String(input.version || '')), 'plugin_provider_version_invalid');
  requireCondition(typeof input.protocol === 'string' && input.protocol.length > 0, 'plugin_provider_protocol_missing');
  const capabilities = [...new Set(Array.isArray(input.capabilities) ? input.capabilities.map((value) => String(value).trim()) : [])];
  for (const capability of capabilities) requireCondition(REQUIRED_CAPABILITIES.has(capability), 'plugin_provider_capability_invalid');
  for (const capability of REQUIRED_CAPABILITIES) requireCondition(capabilities.includes(capability), 'plugin_provider_capability_missing');
  requireCondition(input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata), 'plugin_provider_metadata_invalid');
  return freezeJson(JSON.parse(JSON.stringify({ id, version: input.version, protocol: input.protocol, capabilities, metadata: input.metadata })));
}

class PluginProviderRegistry {
  constructor(options = {}) {
    this.builtin = new Set((options.builtinIds || ['codex', 'claude', 'agy', 'gemini', 'opencode']).map((id) => String(id)));
    this.providers = new Map();
    this.tombstones = new Map();
  }

  register(definition, owner) {
    const value = validateProviderDefinition(definition);
    if (this.builtin.has(value.id) || this.providers.has(value.id)) throw new PluginError('plugin_provider_conflict');
    this.providers.set(value.id, { ...value, owner: String(owner || '') });
    this.tombstones.delete(value.id);
    return value;
  }

  unregister(id, owner) {
    const key = String(id || '').trim().toLowerCase();
    const current = this.providers.get(key);
    if (!current || (owner && current.owner !== owner)) return false;
    this.providers.delete(key);
    this.tombstones.set(key, { ...current, disabledAt: Date.now() });
    return true;
  }

  has(id) { return this.builtin.has(String(id || '').trim().toLowerCase()) || this.providers.has(String(id || '').trim().toLowerCase()); }
  get(id) { return this.providers.get(String(id || '').trim().toLowerCase()) || null; }
  list() { return [...this.providers.values()].map(({ owner, ...provider }) => provider); }
  listTombstones() { return [...this.tombstones.values()].map(({ owner, ...provider }) => provider); }
}

module.exports = { PluginProviderRegistry, validateProviderDefinition };
