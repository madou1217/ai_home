'use strict';

// Upstream dialect profile for a single account.
//
// Relay vendors all advertise "OpenAI compatible" upstreams, yet they disagree
// on two concrete details: which wire API the endpoint speaks
// (`/responses` vs `/chat/completions`) and which extra request headers the
// endpoint demands. Both are properties of the account's endpoint, not of the
// provider family, so they are resolved from persisted account credentials
// instead of being hardcoded against vendor host names.

const WIRE_API_RESPONSES = 'responses';
const WIRE_API_CHAT = 'chat';

const WIRE_API_ENV_KEY = 'OPENAI_WIRE_API';
const HEADER_OVERRIDES_ENV_KEY = 'AIH_UPSTREAM_HEADERS';

// Hop-by-hop headers are owned by the transport; letting configuration rewrite
// them corrupts framing rather than customizing the upstream call.
const PROTECTED_HEADER_NAMES = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

// Header values must not carry control characters: CR/LF would split the
// outbound request. Checked by code point so this file stays free of literal
// control characters.
function isSafeHeaderValue(value) {
  const text = String(value == null ? '' : value);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x08) return false;
    if (code >= 0x0a && code <= 0x1f) return false;
    if (code === 0x7f) return false;
  }
  return true;
}

function normalizeWireApi(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return '';
  if (text === WIRE_API_CHAT || text === 'chat/completions' || text === 'chat_completions' || text === 'openai') {
    return WIRE_API_CHAT;
  }
  if (text === WIRE_API_RESPONSES || text === 'openai_responses' || text === 'openai-responses') {
    return WIRE_API_RESPONSES;
  }
  return '';
}

function parseHeaderOverridesSource(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const text = String(value).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

// Reject anything that could corrupt the outbound request framing: malformed
// names, CR/LF injection, and transport-owned headers.
function normalizeHeaderOverrides(value) {
  const source = parseHeaderOverridesSource(value);
  if (!source) return {};
  const out = {};
  Object.entries(source).forEach(([rawName, rawValue]) => {
    const name = String(rawName || '').trim().toLowerCase();
    if (!name || !HEADER_NAME_PATTERN.test(name)) return;
    if (PROTECTED_HEADER_NAMES.has(name)) return;
    if (name.startsWith('x-aih-')) return;
    const text = String(rawValue == null ? '' : rawValue).trim();
    if (!text || !isSafeHeaderValue(text)) return;
    out[name] = text;
  });
  return out;
}

// Credential env is the persisted source of truth; the runtime account object
// carries the already-resolved fields so hot paths never re-read storage.
function resolveUpstreamProfileFromEnv(env) {
  const source = env && typeof env === 'object' ? env : {};
  return {
    upstreamWireApi: normalizeWireApi(source[WIRE_API_ENV_KEY]),
    upstreamHeaders: normalizeHeaderOverrides(source[HEADER_OVERRIDES_ENV_KEY])
  };
}

// Inverse of resolveUpstreamProfileFromEnv: turn an operator-supplied profile
// into the credential env fragment that persists it. Keys are omitted entirely
// when nothing was declared, so ordinary accounts keep a clean env payload.
function buildUpstreamProfileEnv(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const env = {};
  const wireApi = normalizeWireApi(source.wireApi != null ? source.wireApi : source.upstreamWireApi);
  if (wireApi) env[WIRE_API_ENV_KEY] = wireApi;
  const headers = normalizeHeaderOverrides(
    source.headerOverrides != null ? source.headerOverrides : source.upstreamHeaders
  );
  if (Object.keys(headers).length > 0) env[HEADER_OVERRIDES_ENV_KEY] = JSON.stringify(headers);
  return env;
}

function resolveAccountUpstreamWireApi(account) {
  const explicit = normalizeWireApi(account && account.upstreamWireApi);
  return explicit || WIRE_API_RESPONSES;
}

function usesChatCompletionsWireApi(account) {
  return resolveAccountUpstreamWireApi(account) === WIRE_API_CHAT;
}

function resolveAccountUpstreamHeaders(account) {
  return normalizeHeaderOverrides(account && account.upstreamHeaders);
}

// Applied last so account configuration wins over inherited client headers,
// which is the entire point of an override.
function applyAccountUpstreamHeaders(headers, account) {
  const target = headers && typeof headers === 'object' ? headers : {};
  const overrides = resolveAccountUpstreamHeaders(account);
  Object.entries(overrides).forEach(([name, value]) => {
    target[name] = value;
  });
  return target;
}

module.exports = {
  HEADER_OVERRIDES_ENV_KEY,
  WIRE_API_CHAT,
  WIRE_API_ENV_KEY,
  WIRE_API_RESPONSES,
  applyAccountUpstreamHeaders,
  buildUpstreamProfileEnv,
  normalizeHeaderOverrides,
  normalizeWireApi,
  resolveAccountUpstreamHeaders,
  resolveAccountUpstreamWireApi,
  resolveUpstreamProfileFromEnv,
  usesChatCompletionsWireApi
};
