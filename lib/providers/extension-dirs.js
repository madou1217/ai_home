'use strict';

// 外部 provider 扩展目录：描述符目录（defs）与旧额度插件目录（quota）合并成一个环境变量。
const EXTENSION_DIRS_ENV = 'AIH_PROVIDER_EXTENSION_DIRS';
const FIELD_ORDER = Object.freeze(['defs', 'quota']);

function parseProviderExtensionDirs(value) {
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

function serializeProviderExtensionDirs(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readProviderExtensionField(env, key, fallback = '') {
  const fields = parseProviderExtensionDirs(env && env[EXTENSION_DIRS_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = {
  EXTENSION_DIRS_ENV,
  parseProviderExtensionDirs,
  serializeProviderExtensionDirs,
  readProviderExtensionField
};
