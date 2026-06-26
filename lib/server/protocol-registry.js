'use strict';

const CLIENT_PROTOCOLS = [
  {
    id: 'anthropic_messages',
    method: 'POST',
    family: 'anthropic',
    canonicalEventProtocol: 'aih_canonical_events',
    fallbackRequestProtocol: 'openai_chat',
    fallbackRequestProtocols: Object.freeze(['openai_chat', 'openai_responses']),
    match: (pathname) => pathname === '/v1/messages'
  },
  {
    id: 'anthropic_count_tokens',
    method: 'POST',
    family: 'anthropic',
    canonicalEventProtocol: '',
    fallbackRequestProtocol: '',
    fallbackRequestProtocols: Object.freeze([]),
    match: (pathname) => pathname === '/v1/messages/count_tokens'
  },
  {
    id: 'gemini_generate_content',
    method: 'POST',
    family: 'gemini',
    canonicalEventProtocol: 'aih_canonical_events',
    fallbackRequestProtocol: 'openai_chat',
    fallbackRequestProtocols: Object.freeze(['openai_chat', 'openai_responses']),
    match: (pathname) => /^\/v1(?:beta)?\/models\/[^/]*:generateContent$/.test(pathname)
  },
  {
    id: 'gemini_stream_generate_content',
    method: 'POST',
    family: 'gemini',
    canonicalEventProtocol: 'aih_canonical_events',
    fallbackRequestProtocol: 'openai_chat',
    fallbackRequestProtocols: Object.freeze(['openai_chat', 'openai_responses']),
    match: (pathname) => /^\/v1(?:beta)?\/models\/[^/]*:streamGenerateContent$/.test(pathname)
  },
  {
    id: 'openai_chat',
    method: 'POST',
    family: 'openai',
    canonicalEventProtocol: 'aih_canonical_events',
    fallbackRequestProtocol: 'openai_chat',
    fallbackRequestProtocols: Object.freeze(['openai_chat', 'openai_responses']),
    match: (pathname) => pathname === '/v1/chat/completions'
  },
  {
    id: 'openai_responses',
    method: 'POST',
    family: 'openai',
    canonicalEventProtocol: 'aih_canonical_events',
    fallbackRequestProtocol: 'openai_chat',
    fallbackRequestProtocols: Object.freeze(['openai_chat', 'openai_responses']),
    match: (pathname) => pathname === '/v1/responses'
  }
];

function encodeProtocolPathSegment(value) {
  return encodeURIComponent(String(value || '').trim() || 'models/unknown')
    .replace(/%2F/gi, '/');
}

function normalizeMethod(method) {
  return String(method || '').trim().toUpperCase();
}

function normalizePathname(pathname) {
  const value = String(pathname || '').trim();
  if (value === '/v1/v1') return '/v1';
  if (value.startsWith('/v1/v1/')) return value.slice(3);
  return value;
}

function detectClientProtocol(method, pathname) {
  const safeMethod = normalizeMethod(method);
  const safePath = normalizePathname(pathname);
  const descriptor = CLIENT_PROTOCOLS.find((item) => (
    item.method === safeMethod
    && typeof item.match === 'function'
    && item.match(safePath)
  ));
  return descriptor ? descriptor.id : '';
}

function getClientProtocol(id) {
  const safeId = String(id || '').trim();
  return CLIENT_PROTOCOLS.find((item) => item.id === safeId) || null;
}

function readRequestModel(input = {}) {
  const requestJson = input && input.requestJson && typeof input.requestJson === 'object'
    ? input.requestJson
    : input;
  return String(
    requestJson && requestJson.model
    || input && input.model
    || ''
  ).trim();
}

function buildProtocolRequestPath(protocol, input = {}) {
  const safeId = String(protocol || '').trim();
  if (safeId === 'anthropic_messages') return '/v1/messages';
  if (safeId === 'anthropic_count_tokens') return '/v1/messages/count_tokens';
  if (safeId === 'openai_chat') return '/v1/chat/completions';
  if (safeId === 'openai_responses') return '/v1/responses';
  if (safeId === 'gemini_generate_content' || safeId === 'gemini_stream_generate_content') {
    const methodName = safeId === 'gemini_stream_generate_content' ? 'streamGenerateContent' : 'generateContent';
    return `/v1beta/models/${encodeProtocolPathSegment(readRequestModel(input))}:${methodName}`;
  }
  return '';
}

function listFallbackRequestProtocols(id) {
  const descriptor = getClientProtocol(id);
  if (!descriptor) return [];
  if (Array.isArray(descriptor.fallbackRequestProtocols)) {
    return descriptor.fallbackRequestProtocols.slice();
  }
  return descriptor.fallbackRequestProtocol ? [descriptor.fallbackRequestProtocol] : [];
}

function listClientProtocols() {
  return CLIENT_PROTOCOLS.map((item) => ({
    id: item.id,
    method: item.method,
    family: item.family,
    canonicalEventProtocol: item.canonicalEventProtocol,
    fallbackRequestProtocol: item.fallbackRequestProtocol,
    fallbackRequestProtocols: listFallbackRequestProtocols(item.id)
  }));
}

module.exports = {
  buildProtocolRequestPath,
  detectClientProtocol,
  getClientProtocol,
  listFallbackRequestProtocols,
  listClientProtocols,
  normalizePathname
};
