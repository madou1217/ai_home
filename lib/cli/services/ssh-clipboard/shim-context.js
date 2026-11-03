'use strict';

// shim 进程需要的两个路径（自身 bin 目录、请求/响应邮箱根）合并成一个环境变量。
const SHIM_CONTEXT_ENV = 'AIH_SSH_CLIP_SHIM_CONTEXT';
const FIELD_ORDER = Object.freeze(['bin', 'root']);

function parseShimContext(value) {
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

function serializeShimContext(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readShimContextField(env, key, fallback = '') {
  const fields = parseShimContext(env && env[SHIM_CONTEXT_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

function setShimContextField(env, key, value) {
  if (!env || !key || value === undefined || value === null || String(value) === '') return env;
  const fields = parseShimContext(env[SHIM_CONTEXT_ENV]);
  fields[key] = String(value);
  env[SHIM_CONTEXT_ENV] = serializeShimContext(fields);
  return env;
}

module.exports = {
  SHIM_CONTEXT_ENV,
  parseShimContext,
  serializeShimContext,
  readShimContextField,
  setShimContextField
};
