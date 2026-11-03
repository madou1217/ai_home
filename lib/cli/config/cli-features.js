'use strict';

// CLI 侧功能开关：psmux 安装提示、skill 注入、Windows 图片剪贴板镜像。
const CLI_FEATURES_ENV = 'AIH_CLI_FEATURES';
const FIELD_ORDER = Object.freeze([
  'psmuxInstallPrompt',
  'skillInject',
  'windowsImageClipboardMirror'
]);

function parseCliFeatures(value) {
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

function serializeCliFeatures(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readCliFeature(env, key, fallback = '') {
  const fields = parseCliFeatures(env && env[CLI_FEATURES_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = {
  CLI_FEATURES_ENV,
  parseCliFeatures,
  serializeCliFeatures,
  readCliFeature
};
