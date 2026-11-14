'use strict';

const zlib = require('node:zlib');

// Match codexwire.MaxRequestBytes and the other inference ingress paths.
const MAX_CODEX_REQUEST_BYTES = 32 * 1024 * 1024;
const decoders = new Map([['gzip', zlib.gunzipSync], ['zstd', zlib.zstdDecompressSync]]);

function decodeCodexRequestBody(body, headers = {}, maxBytes = MAX_CODEX_REQUEST_BYTES) {
  const limit = Math.min(Number(maxBytes) > 0 ? Number(maxBytes) : MAX_CODEX_REQUEST_BYTES, MAX_CODEX_REQUEST_BYTES);
  const encoding = String(headers['content-encoding'] || '').trim().toLowerCase();
  try {
    if (!Buffer.isBuffer(body)) throw new Error('invalid body');
    if (body.length > limit) throw Object.assign(new Error('Request body is too large'), { code: 'request_too_large' });
    if (!encoding || encoding === 'identity') return body;
    const decoder = decoders.get(encoding);
    if (typeof decoder !== 'function') throw new Error('unsupported encoding');
    return decoder(body, { maxOutputLength: limit });
  } catch (error) {
    if (['request_too_large', 'ERR_BUFFER_TOO_LARGE'].includes(error.code)) {
      throw Object.assign(new Error('Request body is too large'), { code: 'request_too_large' });
    }
    throw Object.assign(new Error('Invalid request body'), { code: 'invalid_request_body' });
  }
}

function withoutBodyEncoding(req) {
  const headers = { ...req.headers };
  for (const name of Object.keys(headers)) {
    if (['content-encoding', 'content-length'].includes(name.toLowerCase())) delete headers[name];
  }
  return Object.assign(Object.create(req), { headers });
}

module.exports = { decodeCodexRequestBody, withoutBodyEncoding, MAX_CODEX_REQUEST_BYTES };
