'use strict';

// 节点字段契约：协议插件在 fields 里声明「字段 → 类型」、在 required 里声明必填字段，
// 节点库按声明校验、按声明生成连接指纹。导入只要求字段合法；某个输出格式编译不了的
// 节点在渲染该格式时跳过，不在导入阶段丢弃。

const { SUPPORTED_TRANSPORTS, isValidPort } = require('./proxy-protocol-contract');

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isOptionsObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => !UNSAFE_KEYS.has(key))
    && Object.values(value).every((item) => ['string', 'number', 'boolean'].includes(typeof item));
}

const FIELD_VALIDATORS = Object.freeze({
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  count: (value) => Number.isInteger(Number(value)) && Number(value) >= 0,
  positive: (value) => Number.isFinite(Number(value)) && Number(value) > 0,
  port: (value) => isValidPort(value),
  'string-list': (value) => typeof value === 'string'
    || (Array.isArray(value) && value.every((item) => typeof item === 'string')),
  options: (value) => typeof value === 'string' || isOptionsObject(value),
  transport: (value) => SUPPORTED_TRANSPORTS.has(String(value).trim().toLowerCase())
});

// 常用字段组：插件展开使用，避免各自重复声明 TLS 与传输层字段。
const TLS_FIELDS = Object.freeze({
  tls: 'boolean',
  sni: 'string',
  alpn: 'string-list',
  allowInsecure: 'boolean',
  fingerprint: 'string'
});

const TRANSPORT_FIELDS = Object.freeze({
  network: 'transport',
  path: 'string',
  host: 'string',
  serviceName: 'string'
});

function protocolFieldError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

/**
 * 按插件声明校验节点上的协议字段（元数据字段由节点库自己处理）。
 * 错误码：invalid_proxy_field_<字段> / unsupported_proxy_transport_<值> /
 * missing_required_proxy_field_<字段>。
 */
function validateDeclaredFields(node, plugin) {
  const fields = plugin.fields || {};
  for (const [field, type] of Object.entries(fields)) {
    const value = node[field];
    if (value === undefined) continue;
    const validate = FIELD_VALIDATORS[type];
    if (!validate) throw protocolFieldError(`unknown_proxy_field_type_${type}`);
    if (validate(value)) continue;
    throw protocolFieldError(type === 'transport'
      ? `unsupported_proxy_transport_${value}`
      : `invalid_proxy_field_${field}`);
  }
  for (const field of plugin.required || []) {
    if (isMissing(node[field])) throw protocolFieldError(`missing_required_proxy_field_${field}`);
  }
  if (typeof plugin.validate === 'function') plugin.validate(node);
}

module.exports = {
  FIELD_VALIDATORS,
  TLS_FIELDS,
  TRANSPORT_FIELDS,
  protocolFieldError,
  validateDeclaredFields
};
