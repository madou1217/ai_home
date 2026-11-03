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
    fallbackRequestProtocols: Object.freeze(['anthropic_messages', 'openai_chat', 'openai_responses']),
    match: (pathname) => pathname === '/v1/chat/completions'
  },
  {
    id: 'openai_responses',
    method: 'POST',
    family: 'openai',
    canonicalEventProtocol: 'aih_canonical_events',
    fallbackRequestProtocol: 'openai_chat',
    fallbackRequestProtocols: Object.freeze(['anthropic_messages', 'openai_chat', 'openai_responses']),
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

// Vertex AI 形态的 Gemini 入口 → 标准 Gemini 入口（同一请求体/响应体，只是路径不同）。
// gemini CLI 的 vertex-ai 认证（GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_VERTEX_BASE_URL）实测发
//   POST /v1beta1/publishers/google/models/{model}:streamGenerateContent?alt=sse   （express 模式）
// 带项目/地域时是 /v1[beta1]/projects/{p}/locations/{l}/publishers/google/models/{model}:...。
// 改写后进同一条 gemini_generate_content 路由，由选号把 {model} 交给池里任意能处理它的账号
// （别名/其它 provider 模型同样可用）——宿主把 Vertex 接口代理到本网关即可无缝切换。
const VERTEX_GEMINI_PATH = /^\/v1(?:beta1)?(?:\/projects\/[^/]+\/locations\/[^/]+)?\/publishers\/google\/models\/([^/]+:(?:stream)?[gG]enerateContent)$/;

function normalizePathname(pathname) {
  const value = String(pathname || '').trim();
  if (value === '/v1/v1') return '/v1';
  if (value.startsWith('/v1/v1/')) return value.slice(3);
  const vertex = VERTEX_GEMINI_PATH.exec(value);
  if (vertex) return `/v1beta/models/${vertex[1]}`;
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
