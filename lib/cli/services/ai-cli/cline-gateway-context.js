'use strict';

// cline 运行时上下文：网关 profile 的连接参数。
//
// cline 没有「推理端点由 env 决定」的开关（CLINE_API_BASE_URL 只改它自己的控制面，
// 见 core/providers/builtins.go 的 builtinCline 注释），所以网关 profile 用一条上下文
// env 把 baseUrl/apiKey/model 传给启动策略，由策略写进账号沙箱的 providers.json。
// 格式与 AIH_OPENCODE_GATEWAY 同构（k=v 逗号分隔、URL 编码），便于统一排查。
const CLINE_GATEWAY_ENV = 'AIH_CLINE_GATEWAY';
const FIELD_ORDER = Object.freeze(['baseUrl', 'apiKey']);

function parseClineGateway(value) {
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

function serializeClineGateway(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => key + '=' + encodeURIComponent(String(fields[key])))
    .join(',');
}

function readClineGatewayField(env, key, fallback = '') {
  const fields = parseClineGateway(env && env[CLINE_GATEWAY_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = {
  CLINE_GATEWAY_ENV,
  parseClineGateway,
  serializeClineGateway,
  readClineGatewayField
};
