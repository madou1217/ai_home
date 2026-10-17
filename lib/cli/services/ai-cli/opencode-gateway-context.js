'use strict';

// opencode 经本机网关时的连接信息（baseUrl + apiKey）合并成一个环境变量。
const OPENCODE_GATEWAY_ENV = 'AIH_OPENCODE_GATEWAY';
const FIELD_ORDER = Object.freeze(['baseUrl', 'apiKey']);

function parseOpencodeGateway(value) {
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

function serializeOpencodeGateway(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readOpencodeGatewayField(env, key, fallback = '') {
  const fields = parseOpencodeGateway(env && env[OPENCODE_GATEWAY_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = {
  OPENCODE_GATEWAY_ENV,
  parseOpencodeGateway,
  serializeOpencodeGateway,
  readOpencodeGatewayField
};
