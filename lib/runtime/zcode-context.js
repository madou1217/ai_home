'use strict';

// ZCode 桌面进程内的 aih 运行时上下文：账号作用域、验证码 hook 状态文件、用量归属日志。
// 三者只服务同一次启动，合并成一个环境变量；读取方按字段取值。
const ZCODE_CONTEXT_ENV = 'AIH_ZCODE_CONTEXT';
const FIELD_ORDER = Object.freeze(['scope', 'captchaState', 'usageLog', 'bridgeDir', 'bridgeIdentity', 'thinkingModels']);

function parseZcodeContext(value) {
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

function serializeZcodeContext(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readZcodeContextField(env, key, fallback = '') {
  const fields = parseZcodeContext(env && env[ZCODE_CONTEXT_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

function setZcodeContextField(env, key, value) {
  if (!env || !key || value === undefined || value === null || String(value) === '') return env;
  const fields = parseZcodeContext(env[ZCODE_CONTEXT_ENV]);
  fields[key] = String(value);
  env[ZCODE_CONTEXT_ENV] = serializeZcodeContext(fields);
  return env;
}

module.exports = {
  ZCODE_CONTEXT_ENV,
  parseZcodeContext,
  serializeZcodeContext,
  readZcodeContextField,
  setZcodeContextField
};
