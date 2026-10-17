'use strict';

// 服务重启上下文：一次性标记（mode=background|elevated）与源码自动重启开关（sourceAuto）。
const SERVER_RESTART_ENV = 'AIH_SERVER_RESTART';
const FIELD_ORDER = Object.freeze(['mode', 'sourceAuto']);

function parseServerRestart(value) {
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

function serializeServerRestart(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readServerRestartField(env, key, fallback = '') {
  const fields = parseServerRestart(env && env[SERVER_RESTART_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

function setServerRestartField(env, key, value) {
  if (!env || !key || value === undefined || value === null || String(value) === '') return env;
  const fields = parseServerRestart(env[SERVER_RESTART_ENV]);
  fields[key] = String(value);
  env[SERVER_RESTART_ENV] = serializeServerRestart(fields);
  return env;
}

module.exports = {
  SERVER_RESTART_ENV,
  parseServerRestart,
  serializeServerRestart,
  readServerRestartField,
  setServerRestartField
};
