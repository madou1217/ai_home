'use strict';

// Some OpenAI-compatible relays wrap non-streaming completions in a transport
// envelope of the shape `{"data": {...}, "success": true}` while their streaming
// SSE frames stay unwrapped. Clients that speak plain OpenAI cannot read the
// wrapped form, so the gateway normalizes it back to the canonical payload.
//
// Detection is deliberately strict: a genuine OpenAI response never carries a
// top-level `success` field, so requiring it (plus an OpenAI-shaped `data`)
// keeps well-behaved upstreams untouched.

const { decodeResponseBuffer } = require('./response-body');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeOpenAIPayload(value) {
  if (!isPlainObject(value)) return false;
  if (Array.isArray(value.choices)) return true;
  if (Array.isArray(value.data) && typeof value.object === 'string') return true;
  return typeof value.object === 'string' && typeof value.id === 'string';
}

function isOpenAIResponseEnvelope(payload) {
  if (!isPlainObject(payload)) return false;
  if (!Object.prototype.hasOwnProperty.call(payload, 'success')) return false;
  // An already-canonical payload must never be unwrapped, even if the upstream
  // bolted a `success` flag onto it.
  if (looksLikeOpenAIPayload(payload) && !isPlainObject(payload.data)) return false;
  return looksLikeOpenAIPayload(payload.data);
}

function unwrapOpenAIResponseEnvelope(payload) {
  return isOpenAIResponseEnvelope(payload) ? payload.data : payload;
}

// Buffer-level helper for the passthrough path, which forwards raw bytes and
// must leave anything unrecognized (non-JSON, streams, errors) byte-identical.
function unwrapOpenAIResponseEnvelopeBuffer(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 1) return raw;
  let parsed = null;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (_error) {
    return raw;
  }
  if (!isOpenAIResponseEnvelope(parsed)) return raw;
  return Buffer.from(JSON.stringify(parsed.data), 'utf8');
}

// Passthrough entry point: decodes a possibly-compressed upstream body and
// reports the rewritten bytes, or null when nothing needed unwrapping. A null
// result lets the caller forward the original bytes untouched, including their
// content-encoding.
function unwrapUpstreamEnvelopeBody(rawBuffer, contentEncoding = '') {
  if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length < 1) return null;
  const encoding = String(contentEncoding || '').trim();
  let decoded = rawBuffer;
  if (encoding) {
    try {
      decoded = Buffer.from(decodeResponseBuffer(rawBuffer, encoding), 'utf8');
    } catch (_error) {
      return null;
    }
  }
  const unwrapped = unwrapOpenAIResponseEnvelopeBuffer(decoded);
  return unwrapped === decoded ? null : unwrapped;
}

module.exports = {
  isOpenAIResponseEnvelope,
  unwrapOpenAIResponseEnvelope,
  unwrapOpenAIResponseEnvelopeBuffer,
  unwrapUpstreamEnvelopeBody
};
