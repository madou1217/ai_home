'use strict';

// CLI 运行时用量显示：状态栏显示（show）与后台刷新调度（scheduler）。
const RUNTIME_USAGE_ENV = 'AIH_RUNTIME_USAGE';
const FIELD_ORDER = Object.freeze(['show', 'scheduler']);

function parseRuntimeUsage(value) {
  const fields = {};
  for (const part of String(value || '').split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!key || !raw) continue;
    try { fields[key] = decodeURIComponent(raw); } catch (_error) { fields[key] = raw; }
  }
  return fields;
}

function serializeRuntimeUsage(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readRuntimeUsageField(env, key, fallback = '') {
  const fields = parseRuntimeUsage(env && env[RUNTIME_USAGE_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = {
  RUNTIME_USAGE_ENV,
  parseRuntimeUsage,
  serializeRuntimeUsage,
  readRuntimeUsageField
};
