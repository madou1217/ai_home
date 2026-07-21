'use strict';

const REDACTED = '[redacted]';
const JWT_REDACTED = '[jwt-redacted]';
const DEFAULT_MESSAGE_MAX_LENGTH = 512;
const DEFAULT_DETAIL_DEPTH = 5;
const DEFAULT_DETAIL_ENTRIES = 40;
const SAFE_CODE_RE = /^[a-z0-9][a-z0-9_.:-]{0,95}$/i;
const SENSITIVE_DETAIL_KEY_RE = /(^|[-_.])(authorization|cookie|cookies|credential|credentials|key|keys|password|secret|secrets|token|tokens)($|[-_.])/i;

const QUOTED_SECRET_ASSIGNMENT_RE = /((?:["']?)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|x[_-]?api[_-]?key|management[_-]?key|private[_-]?key|secret[_-]?key|token|secret|credential|password)(?:["']?)\s*[:=]\s*)(["'])[^\r\n]*?\2/gi;
const SECRET_ASSIGNMENT_RE = /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|x[_-]?api[_-]?key|management[_-]?key|private[_-]?key|secret[_-]?key|token|secret|credential|password)\b\s*[:=]\s*)(?!\[redacted\])[^\s,;&}\])]+/gi;
const AUTHORIZATION_RE = /(\b(?:proxy[-_ ]?)?authorization\s*[:=]\s*)(?:(bearer|basic|token)\s+)?[^\s,;)}\]]+/gi;
const COOKIE_RE = /(\b(?:set[-_ ]?cookie|cookie)s?\s*[:=]\s*)[^\r\n]*/gi;
const BEARER_RE = /\b(bearer)\s+(?!\[redacted\])[^\s,;)}\]]+/gi;
const BASIC_RE = /\b(basic)\s+(?!\[redacted\])[^\s,;)}\]]+/gi;
const JWT_LABEL_RE = /(\bjwt\s+)[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi;
const JWT_RE = /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi;
const PROVIDER_KEY_RE = /\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{8,}|AIza[a-z0-9_-]{16,})\b/gi;
const URL_CREDENTIAL_RE = /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

function sanitizeDiagnosticText(value, maxLength = DEFAULT_MESSAGE_MAX_LENGTH) {
  const limit = positiveLimit(maxLength, DEFAULT_MESSAGE_MAX_LENGTH);
  const sanitized = String(value == null ? '' : value)
    .replace(URL_CREDENTIAL_RE, '$1[redacted]@')
    .replace(QUOTED_SECRET_ASSIGNMENT_RE, `$1$2${REDACTED}$2`)
    .replace(AUTHORIZATION_RE, (_match, prefix, scheme) => (
      `${prefix}${scheme ? `${scheme} ` : ''}${REDACTED}`
    ))
    .replace(COOKIE_RE, `$1${REDACTED}`)
    .replace(SECRET_ASSIGNMENT_RE, `$1${REDACTED}`)
    .replace(BEARER_RE, `$1 ${REDACTED}`)
    .replace(BASIC_RE, `$1 ${REDACTED}`)
    .replace(JWT_LABEL_RE, `$1${JWT_REDACTED}`)
    .replace(JWT_RE, JWT_REDACTED)
    .replace(PROVIDER_KEY_RE, REDACTED)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized.length <= limit) return sanitized;
  return `${sanitized.slice(0, Math.max(0, limit - 3))}...`;
}

function sanitizeCanonicalDiagnostic(value, options = {}) {
  const source = diagnosticSource(value);
  const fallbackCode = sanitizeDiagnosticCode(
    options.fallbackCode,
    'chat_runtime_failed'
  );
  const code = sanitizeDiagnosticCode(source.code || source.error, fallbackCode);
  const rawMessage = diagnosticMessage(value, source);
  const fallbackMessage = options.fallbackMessage || code;
  const message = sanitizeDiagnosticText(
    rawMessage || fallbackMessage,
    options.maxMessageLength
  ) || fallbackCode;
  const diagnostic = { code, message };
  if (options.includeStatusCode) {
    diagnostic.statusCode = normalizeStatusCode(source.statusCode, options.defaultStatusCode);
  }
  if (options.includeDetails && source.details !== undefined) {
    diagnostic.details = sanitizeDiagnosticDetails(source.details, options);
  }
  return diagnostic;
}

function sanitizeDiagnosticDetails(value, options = {}) {
  const limits = {
    maxDepth: positiveLimit(options.maxDetailDepth, DEFAULT_DETAIL_DEPTH),
    maxEntries: positiveLimit(options.maxDetailEntries, DEFAULT_DETAIL_ENTRIES),
    maxTextLength: positiveLimit(options.maxDetailTextLength, DEFAULT_MESSAGE_MAX_LENGTH)
  };
  return projectDiagnosticValue(value, limits, 0, new WeakSet());
}

function projectDiagnosticValue(value, limits, depth, seen) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'bigint') {
    return sanitizeDiagnosticText(value, limits.maxTextLength);
  }
  if (typeof value !== 'object') return '[unsupported]';
  if (depth >= limits.maxDepth) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const projected = Array.isArray(value)
    ? projectDiagnosticArray(value, limits, depth, seen)
    : projectDiagnosticRecord(value, limits, depth, seen);
  seen.delete(value);
  return projected;
}

function projectDiagnosticArray(value, limits, depth, seen) {
  return value.slice(0, limits.maxEntries).map((item) => (
    projectDiagnosticValue(item, limits, depth + 1, seen)
  ));
}

function projectDiagnosticRecord(value, limits, depth, seen) {
  const projected = {};
  const keys = Object.keys(value).slice(0, limits.maxEntries);
  for (const key of keys) {
    const normalizedKey = normalizeDetailKey(key);
    if (isSensitiveDetailKey(normalizedKey)) {
      projected[key] = REDACTED;
      continue;
    }
    try {
      projected[key] = projectDiagnosticValue(value[key], limits, depth + 1, seen);
    } catch (_error) {
      projected[key] = '[unavailable]';
    }
  }
  return projected;
}

function isSensitiveDetailKey(key) {
  return SENSITIVE_DETAIL_KEY_RE.test(key);
}

function normalizeDetailKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function sanitizeDiagnosticCode(value, fallback) {
  const code = String(value == null ? '' : value).trim();
  if (SAFE_CODE_RE.test(code)) return code;
  const safeFallback = String(fallback == null ? '' : fallback).trim();
  return SAFE_CODE_RE.test(safeFallback) ? safeFallback : 'chat_runtime_failed';
}

function diagnosticSource(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function diagnosticMessage(value, source) {
  if (typeof source.message === 'string' && source.message.trim()) return source.message;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

function normalizeStatusCode(value, fallback = 500) {
  const statusCode = Number(value);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) return statusCode;
  const fallbackCode = Number(fallback);
  return Number.isInteger(fallbackCode) && fallbackCode >= 400 && fallbackCode <= 599
    ? fallbackCode
    : 500;
}

function positiveLimit(value, fallback) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? limit : fallback;
}

module.exports = {
  sanitizeCanonicalDiagnostic,
  sanitizeDiagnosticCode,
  sanitizeDiagnosticDetails,
  sanitizeDiagnosticText
};
