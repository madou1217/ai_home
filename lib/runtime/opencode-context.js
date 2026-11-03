'use strict';

// opencode 运行时上下文：网关连接（baseUrl/apiKey）、BYOK opt-in、run 布局逃生门。
const OPENCODE_CONTEXT_ENV = 'AIH_OPENCODE_GATEWAY';
const FIELD_ORDER = Object.freeze(['baseUrl', 'apiKey', 'byok', 'runLayout']);

function parseOpencodeContext(value) {
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

function serializeOpencodeContext(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readOpencodeContextField(env, key, fallback = '') {
  const fields = parseOpencodeContext(env && env[OPENCODE_CONTEXT_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = {
  OPENCODE_CONTEXT_ENV,
  parseOpencodeContext,
  serializeOpencodeContext,
  readOpencodeContextField
};
