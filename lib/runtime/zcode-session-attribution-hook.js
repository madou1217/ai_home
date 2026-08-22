'use strict';

const nodeCrypto = require('node:crypto');

const AIH_ZCODE_SESSION_SCOPE_ENV = 'AIH_ZCODE_SESSION_ATTRIBUTION_SCOPE';
const GLOBAL_SCOPE_FUNCTION = '__aihScopeZcodeSessionId';
const ATTRIBUTION_FUNCTION_NAME = 'normalizeModelSessionIdForAttribution';

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 服务端只看到由「账号 + 本地会话」确定性派生的 UUID；本地 SQLite/session ID
// 完全不变，因此同账号续聊保持稳定，跨账号复用历史会话时不再共用 admission 身份。
function scopeZcodeSessionId(sessionId, accountScope) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedScope = String(accountScope || '').trim();
  if (!normalizedSessionId || !normalizedScope) return normalizedSessionId;

  const bytes = nodeCrypto.createHash('sha256')
    .update('aih:zcode-session-attribution:v1\0')
    .update(normalizedScope)
    .update('\0')
    .update(normalizedSessionId)
    .digest()
    .subarray(0, 16);
  // 使用 UUID v5 形态表达“稳定派生身份”，同时满足服务端现有 UUID 输入形态。
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

function patchZcodeAgentSource(source) {
  const text = String(source || '');
  if (text.includes(`globalThis.${GLOBAL_SCOPE_FUNCTION}`)) return text;

  const markerPattern = new RegExp(
    `\\b[A-Za-z_$][\\w$]*\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*["']${ATTRIBUTION_FUNCTION_NAME}["']\\s*\\)`,
    'g'
  );
  const markers = Array.from(text.matchAll(markerPattern));
  if (markers.length !== 1) {
    throw new Error(`ZCode session attribution hook expected one ${ATTRIBUTION_FUNCTION_NAME} marker, found ${markers.length}`);
  }

  const functionName = markers[0][1];
  const functionPattern = new RegExp(
    `function\\s+${escapeRegExp(functionName)}\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\{\\s*if\\s*\\(\\s*\\1\\s*\\)\\s*return\\s+([^;{}]+?)\\s*;?\\s*\\}`
  );
  const match = text.match(functionPattern);
  if (!match) {
    throw new Error(`ZCode session attribution hook could not patch ${ATTRIBUTION_FUNCTION_NAME}`);
  }

  const argumentName = match[1];
  const normalizedExpression = match[2];
  const replacement = [
    `function ${functionName}(${argumentName}){`,
    `if(${argumentName}){`,
    `let __aihSessionId=${normalizedExpression};`,
    `return globalThis.${GLOBAL_SCOPE_FUNCTION}`,
    `?globalThis.${GLOBAL_SCOPE_FUNCTION}(__aihSessionId)`,
    ':__aihSessionId',
    '}',
    '}'
  ].join('');
  return text.replace(functionPattern, replacement);
}

function installZcodeSessionScopeFunction(accountScope, globalObject = globalThis) {
  const normalizedScope = String(accountScope || '').trim();
  if (!normalizedScope) return false;
  globalObject[GLOBAL_SCOPE_FUNCTION] = (sessionId) => scopeZcodeSessionId(sessionId, accountScope);
  return true;
}

module.exports = {
  AIH_ZCODE_SESSION_SCOPE_ENV,
  installZcodeSessionScopeFunction,
  patchZcodeAgentSource,
  scopeZcodeSessionId
};
