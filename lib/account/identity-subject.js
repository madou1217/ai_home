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

/** Empty aliases are absent; a malformed or conflicting supplied alias is not. */
function readSubjectAliases(record, keys) {
  const values = [];
  for (const key of keys) {
    const value = record && record[key];
    if (value === undefined || value === null || value === '') continue;
    const canonical = canonicalSubject(value);
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
  consistentSubject,
  decodeIdentityJwt,
  digestSubject,
  hasNativeSecret,
  parseIdentityObject,
  readSubjectAliases,
  tokenSubject
};
