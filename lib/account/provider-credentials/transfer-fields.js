'use strict';

// 导入导出载荷里常见的邮箱位置（顶层、auth、credentials、config、meta），各 provider 在此基础上追加自己的字段。
function genericEmailCandidates(fields) {
  return [fields.payload.email, fields.nestedAuth.email, fields.credentials.email, fields.config.email, fields.meta.email];
}

// 账号/用户对象里的邮箱位置（gemini、claude、agy 的原生凭据都可能带）。
function profileEmailCandidates(source) {
  return [source.email, source.account && source.account.email, source.user && source.user.email];
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' ? value : {};
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function hasNonEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function parseDateMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function removeEmptyValues(input) {
  const out = {};
  Object.entries(input || {}).forEach(([key, value]) => {
    if (value == null) return;
    const next = typeof value === 'string' ? value.trim() : value;
    if (next === '') return;
    if (Array.isArray(next) && next.length === 0) return;
    if (isPlainObject(next) && Object.keys(next).length === 0) return;
    out[key] = next;
  });
  return out;
}

function readNestedObject(source, key) {
  const value = source && source[key];
  return isPlainObject(value) ? value : {};
}

module.exports = {
  firstNonEmptyString,
  isPlainObject,
  readNestedObject,
  removeEmptyValues,
  genericEmailCandidates,
  hasNonEmptyObject,
  objectOrEmpty,
  parseDateMs,
  profileEmailCandidates
};
