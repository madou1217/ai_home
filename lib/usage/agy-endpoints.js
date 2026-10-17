'use strict';

// agy 用量/额度探测的端点覆盖（通用 base、额度 base 列表）合并成一个环境变量。
const AGY_ENDPOINTS_ENV = 'AIH_AGY_ENDPOINTS';
const FIELD_ORDER = Object.freeze(['baseUrl', 'quotaBaseUrls']);

function parseAgyEndpoints(value) {
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

function serializeAgyEndpoints(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readAgyEndpointField(env, key, fallback = '') {
  const fields = parseAgyEndpoints(env && env[AGY_ENDPOINTS_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = {
  AGY_ENDPOINTS_ENV,
  parseAgyEndpoints,
  serializeAgyEndpoints,
  readAgyEndpointField
};
