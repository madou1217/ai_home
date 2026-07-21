'use strict';

const { readJsonValue, writeJsonValue } = require('./app-state-store');

const OUTBOUND_RELAY_CONFIG_KEY = 'fabric:outbound-relays';
const OUTBOUND_RELAY_CONFIG_VERSION = 1;
const MIN_OUTBOUND_RELAYS = 1;
const MAX_OUTBOUND_RELAYS = 5;

function configurationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeText(value, maxLength) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeEndpoint(value) {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      throw configurationError('invalid_outbound_relay_endpoint');
    }
    if (parsed.username || parsed.password) {
      throw configurationError('invalid_outbound_relay_endpoint');
    }
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    if (error && error.code === 'invalid_outbound_relay_endpoint') throw error;
    throw configurationError('invalid_outbound_relay_endpoint');
  }
}

function normalizeEnabled(value) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw configurationError('invalid_outbound_relay_enabled');
  return value;
}

function normalizeRelay(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const endpoint = normalizeEndpoint(source.endpoint);
  const managementKey = normalizeText(source.managementKey, 4096);
  if (!managementKey) throw configurationError('missing_outbound_relay_management_key');
  const parsed = new URL(endpoint);
  return {
    endpoint,
    name: normalizeText(source.name, 120) || parsed.host,
    enabled: normalizeEnabled(source.enabled),
    managementKey
  };
}

function normalizeOutboundRelayConfig(value) {
  const source = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.relays)
      ? value.relays
      : null);
  if (!source) throw configurationError('invalid_outbound_relay_config');
  if (source.length !== 0 && (source.length < MIN_OUTBOUND_RELAYS || source.length > MAX_OUTBOUND_RELAYS)) {
    throw configurationError('invalid_outbound_relay_count');
  }
  const relays = source.map(normalizeRelay);
  const endpoints = new Set();
  relays.forEach((relay) => {
    if (endpoints.has(relay.endpoint)) throw configurationError('duplicate_outbound_relay_endpoint');
    endpoints.add(relay.endpoint);
  });
  return {
    version: OUTBOUND_RELAY_CONFIG_VERSION,
    relays
  };
}

function emptyOutboundRelayConfig() {
  return {
    version: OUTBOUND_RELAY_CONFIG_VERSION,
    relays: []
  };
}

function readOutboundRelayConfig(deps = {}) {
  const stored = readJsonValue(deps.fs, deps.aiHomeDir, OUTBOUND_RELAY_CONFIG_KEY, deps);
  return stored == null ? emptyOutboundRelayConfig() : normalizeOutboundRelayConfig(stored);
}

function writeOutboundRelayConfig(value, deps = {}) {
  const normalized = normalizeOutboundRelayConfig(value);
  if (!writeJsonValue(deps.fs, deps.aiHomeDir, OUTBOUND_RELAY_CONFIG_KEY, normalized, deps)) {
    throw configurationError('outbound_relay_config_write_failed');
  }
  return normalized;
}

function toPublicOutboundRelayConfig(value) {
  const normalized = normalizeOutboundRelayConfig(value);
  return {
    version: normalized.version,
    relays: normalized.relays.map((relay) => ({
      endpoint: relay.endpoint,
      name: relay.name,
      enabled: relay.enabled,
      managementKeyConfigured: Boolean(relay.managementKey)
    }))
  };
}

function readPublicOutboundRelayConfig(deps = {}) {
  return toPublicOutboundRelayConfig(readOutboundRelayConfig(deps));
}

module.exports = {
  MAX_OUTBOUND_RELAYS,
  MIN_OUTBOUND_RELAYS,
  OUTBOUND_RELAY_CONFIG_KEY,
  OUTBOUND_RELAY_CONFIG_VERSION,
  normalizeOutboundRelayConfig,
  readOutboundRelayConfig,
  readPublicOutboundRelayConfig,
  toPublicOutboundRelayConfig,
  writeOutboundRelayConfig
};
