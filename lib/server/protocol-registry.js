'use strict';

const CLIENT_PROTOCOLS = [
  {
    id: 'anthropic_messages',
    method: 'POST',
    family: 'anthropic',
    canonical: 'openai_chat',
    match: (pathname) => pathname === '/v1/messages'
  },
  {
    id: 'gemini_generate_content',
    method: 'POST',
    family: 'gemini',
    canonical: 'openai_chat',
    match: (pathname) => /^\/v1(?:beta)?\/models\/[^/]+:generateContent$/.test(pathname)
  },
  {
    id: 'gemini_stream_generate_content',
    method: 'POST',
    family: 'gemini',
    canonical: 'openai_chat',
    match: (pathname) => /^\/v1(?:beta)?\/models\/[^/]+:streamGenerateContent$/.test(pathname)
  },
  {
    id: 'openai_chat',
    method: 'POST',
    family: 'openai',
    canonical: 'openai_chat',
    match: (pathname) => pathname === '/v1/chat/completions'
  },
  {
    id: 'openai_responses',
    method: 'POST',
    family: 'openai',
    canonical: 'openai_chat',
    match: (pathname) => pathname === '/v1/responses'
  }
];

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

function listClientProtocols() {
  return CLIENT_PROTOCOLS.map((item) => ({
    id: item.id,
    method: item.method,
    family: item.family,
    canonical: item.canonical
  }));
}

module.exports = {
  detectClientProtocol,
  getClientProtocol,
  listClientProtocols,
  normalizePathname
};
