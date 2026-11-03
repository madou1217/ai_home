'use strict';

const crypto = require('node:crypto');

const MAX_TOKEN_BYTES = 256 * 1024;

/**
 * Local metadata validation, not authentication: these functions never verify a
 * JWT signature. The official Provider still authenticates the credential. A
 * canonical, unambiguous subject is required before it can name a local account.
 */
function canonicalSubject(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) return '';
  if (value !== value.trim() || /[:\s\u0000-\u001f\u007f\ufffd]/u.test(value)) return '';
  return value;
}

function digestSubject(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 数值型 subject 的规范化（**仅用于读 JWT claims**）。
 *
 * 上游的 JWT 会把 user_id 写成 JSON **数字**而不是字符串：zcode 的
 * `oauth:zai:access_token` payload 就是 `{"user_type":"PERSONAL","user_id":10960790,…}`。
 * 原实现只接受 string，于是 `readSubjectAliases` 判它 malformed（valid:false），
 * 而 `consistentSubject` 遇到任一无效观测就整体 fail closed —— 身份种子变空。
 * 真机后果（2026-10-26）：Windows 上一个账号的 user_info 与 zcodejwttoken 明明给出
 * **同一个** user_id（`68a8c2ed-…`），却因为 access_token 的数字 user_id 而被判
 * 「无法确认身份」，导出/去重时被当成未知账号。
 *
 * 只接受**安全整数**：浮点/NaN/Infinity 不是身份，仍按 malformed 处理（fail closed
 * 的意图不变，只是不再把「合法但非字符串」误判为「畸形」）。
 */
function canonicalNumericSubject(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return '';
  return String(value);
}

/**
 * 从 claims/记录里读 subject 别名。
 *
 * 字符串走 canonicalSubject（保持原有严格校验）；数字按 canonicalNumericSubject
 * 规范化。两者都失败才算 malformed。注意 canonicalSubject 本身**不放宽** ——
 * 它还被 kiro / opencode 等调用点用于已确认的字符串标识，放宽会削弱那里的校验。
 */
function readSubjectAliases(record, keys) {
  const values = [];
  for (const key of keys) {
    const value = record && record[key];
    if (value === undefined || value === null || value === '') continue;
    const canonical = typeof value === 'number'
      ? canonicalNumericSubject(value)
      : canonicalSubject(value);
    if (!canonical) return { valid: false, subject: '' };
    values.push(canonical);
  }
  const subjects = [...new Set(values)];
  return { valid: subjects.length <= 1, subject: subjects.length === 1 ? subjects[0] : '' };
}

/**
 * JSON.parse alone silently accepts duplicate keys. After syntax validation the
 * small lexical pass only tracks object keys, never reimplements JSON values.
 * Depth and size bounds keep native artifact inspection off unbounded paths.
 */
function parseIdentityObject(text, maxBytes = MAX_TOKEN_BYTES) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) return null;
  let value;
  try { value = JSON.parse(text); } catch (_) { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stack = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set() : null);
      if (stack.length > 64) return null;
    } else if (token === '}' || token === ']') {
      stack.pop();
    } else if (/^\s*:/.test(text.slice(match.index + token.length))) {
      const keys = stack.at(-1);
      const key = JSON.parse(token);
      if (!keys || keys.has(key)) return null;
      keys.add(key);
    }
  }
  return value;
}

function decodeIdentityJwt(token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) return null;
  const pieces = token.split('.');
  if (pieces.length !== 3 || pieces.some(piece => !/^[A-Za-z0-9_-]+$/.test(piece))) return null;
  try {
    const bytes = Buffer.from(pieces[1], 'base64url');
    if (bytes.toString('base64url') !== pieces[1]) return null;
    return parseIdentityObject(bytes.toString('utf8'));
  } catch (_) { return null; }
}

function tokenSubject(token) {
  const claims = decodeIdentityJwt(token);
  return claims ? readSubjectAliases(claims, ['user_id', 'userId', 'sub', 'subject'])
    : { valid: true, subject: '' };
}

/** Compare independent observations instead of taking the first usable field. */
function consistentSubject(observations) {
  if (observations.some(observation => !observation.valid)) return '';
  const subjects = [...new Set(observations.map(observation => observation.subject).filter(Boolean))];
  return subjects.length === 1 ? subjects[0] : '';
}

function hasNativeSecret(record, keys) {
  return keys.some(key => typeof record?.[key] === 'string' && record[key].length > 0
    && record[key].length <= MAX_TOKEN_BYTES && record[key] === record[key].trim());
}

module.exports = {
  canonicalSubject,
  canonicalNumericSubject,
  consistentSubject,
  decodeIdentityJwt,
  digestSubject,
  hasNativeSecret,
  parseIdentityObject,
  readSubjectAliases,
  tokenSubject
};
