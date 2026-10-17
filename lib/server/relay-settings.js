'use strict';

// 中转运行参数（UDP 开关 / 播报地址 / 端口 / 端口模式 / 绑定网卡）在进程内的唯一载体。
// `aih server config` 是正式入口；这里只做一次 config → 单一环境变量的投影，
// 深层模块不再各自占用一个 AIH_RELAY_* 名字。
const RELAY_SETTINGS_ENV = 'AIH_RELAY_SETTINGS';
const FIELD_ORDER = Object.freeze(['udp', 'advertiseHost', 'advertisePort', 'portMode', 'listenHost']);

function parseRelaySettings(value) {
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

function serializeRelaySettings(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readRelaySetting(env, key, fallback = '') {
  const fields = parseRelaySettings(env && env[RELAY_SETTINGS_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

function setRelaySetting(env, key, value) {
  if (!env || !key || value === undefined || value === null || String(value) === '') return env;
  const fields = parseRelaySettings(env[RELAY_SETTINGS_ENV]);
  fields[key] = String(value);
  env[RELAY_SETTINGS_ENV] = serializeRelaySettings(fields);
  return env;
}

module.exports = {
  RELAY_SETTINGS_ENV,
  parseRelaySettings,
  serializeRelaySettings,
  readRelaySetting,
  setRelaySetting
};
