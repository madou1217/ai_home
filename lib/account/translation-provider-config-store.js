'use strict';

// External translation credentials stay in app-state SQLite. Only the public
// projection below may cross the management API boundary.
const { readJsonValue, writeJsonValue } = require('../server/app-state-store');

const CONFIG_KEY_PREFIX = 'translation:provider-config:';

function configError(code) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 400;
  error.detail = '请检查翻译引擎的配置字段';
  return error;
}

function fieldsOf(descriptor) {
  return Object.entries(descriptor.config.fieldDefinitions || {})
    .filter(([name]) => descriptor.config.fields.includes(name));
}

// The desktop translation status (/v0/webui/translation/system, polled several times a
// second) describes every provider, and each description opened app-state SQLite (~0.5ms
// open + lock + pragmas per provider, ~0.5s of main thread per 10s observed). Stored
// configs are only written through writeTranslationProviderConfig below, which refreshes
// this memo; the short TTL bounds staleness from writes made by another process.
const STORED_CONFIG_TTL_MS = 5000;
const storedConfigCache = new Map();

function storedConfigKey(aiHomeDir, descriptor) {
  return `${String(aiHomeDir || '')}\0${descriptor.id}`;
}

function readStoredConfig(fs, aiHomeDir, descriptor, deps) {
  const cacheable = !Object.hasOwn(deps, 'DatabaseSync');
  const key = storedConfigKey(aiHomeDir, descriptor);
  const hit = cacheable ? storedConfigCache.get(key) : null;
  if (hit && Date.now() - hit.at < STORED_CONFIG_TTL_MS) return hit.value;
  const value = readJsonValue(fs, aiHomeDir, `${CONFIG_KEY_PREFIX}${descriptor.id}`, { ...deps, strict: true }) || {};
  if (cacheable) storedConfigCache.set(key, { at: Date.now(), value });
  return value;
}

function readTranslationProviderConfig(fs, aiHomeDir, descriptor, deps = {}) {
  const stored = readStoredConfig(fs, aiHomeDir, descriptor, deps);
  return Object.fromEntries(fieldsOf(descriptor).map(([name, field]) => [
    name, String(stored[name] || field.defaultValue || '').trim()
  ]));
}

function publicTranslationProviderConfig(descriptor, config) {
  const fields = fieldsOf(descriptor);
  const missingFields = fields.filter(([name, field]) => field.required && !config[name]).map(([name]) => name);
  return {
    configured: missingFields.length === 0,
    missingFields,
    secretConfigured: Object.fromEntries(fields.filter(([, field]) => field.secret).map(([name]) => [name, Boolean(config[name])])),
    values: Object.fromEntries(fields.filter(([, field]) => !field.secret).map(([name]) => [name, config[name] || '']))
  };
}

function writeTranslationProviderConfig(fs, aiHomeDir, descriptor, patch, deps = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw configError('translation_provider_config_invalid');
  const definitions = new Map(fieldsOf(descriptor));
  const next = readTranslationProviderConfig(fs, aiHomeDir, descriptor, deps);
  for (const [name, raw] of Object.entries(patch)) {
    const field = definitions.get(name);
    if (!field || typeof raw !== 'string') throw configError('translation_provider_config_field_invalid');
    const value = raw.trim();
    if (value.length > (field.secret ? 4096 : 2048)) throw configError('translation_provider_config_field_invalid');
    if (value && field.format === 'url') {
      let url;
      try { url = new URL(value); } catch (_error) { throw configError('translation_provider_endpoint_invalid'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw configError('translation_provider_endpoint_invalid');
      }
    }
    next[name] = value || String(field.defaultValue || '');
  }
  // Empty credentials deliberately disable a service; readiness remains visible
  // in the catalog and its adapter rejects execution until configured again.
  storedConfigCache.delete(storedConfigKey(aiHomeDir, descriptor));
  if (!writeJsonValue(fs, aiHomeDir, `${CONFIG_KEY_PREFIX}${descriptor.id}`, next, { ...deps, strict: true })) {
    throw new Error('translation_provider_config_write_failed');
  }
  storedConfigCache.delete(storedConfigKey(aiHomeDir, descriptor));
  return publicTranslationProviderConfig(descriptor, next);
}

module.exports = { readTranslationProviderConfig, publicTranslationProviderConfig, writeTranslationProviderConfig };
