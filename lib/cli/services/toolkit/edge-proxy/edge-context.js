'use strict';

// 边缘代理的配置位置覆盖（Caddyfile / nginx 配置目录 / frpc 配置）合并成一个环境变量。
const EDGE_CONTEXT_ENV = 'AIH_EDGE_CONTEXT';
const FIELD_ORDER = Object.freeze(['caddyfile', 'nginxConfDir', 'frpcConfig']);

function parseEdgeContext(value) {
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

function serializeEdgeContext(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readEdgeContextField(env, key, fallback = '') {
  const fields = parseEdgeContext(env && env[EDGE_CONTEXT_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = { EDGE_CONTEXT_ENV, parseEdgeContext, serializeEdgeContext, readEdgeContextField };
