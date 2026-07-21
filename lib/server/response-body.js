'use strict';

const zlib = require('node:zlib');

function getHeader(headers, name) {
  if (!headers || !name) return '';
  const wanted = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    return String(headers.get(wanted) || headers.get(name) || '').trim();
  }
  const direct = headers[wanted] || headers[name];
  if (direct !== undefined && direct !== null) return String(direct).trim();
  const key = Object.keys(headers).find((item) => String(item).toLowerCase() === wanted);
  return key ? String(headers[key] || '').trim() : '';
}

function isMostlyText(buffer) {
  if (!buffer || buffer.length < 1) return true;
  let printable = 0;
  let invalid = 0;
  const text = buffer.toString('utf8');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0xfffd) {
      invalid += 1;
      continue;
    }
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable += 1;
  }
  return printable / Math.max(1, text.length) >= 0.92 && invalid === 0;
}

function tryDecode(buffer, decoder) {
  try {
    const out = decoder(buffer);
    return isMostlyText(out) ? out : null;
  } catch (_error) {
    return null;
  }
}

function listDecodersForEncoding(encoding) {
  const value = String(encoding || '').toLowerCase();
  const decoders = [];
  if (value.includes('gzip') || value.includes('x-gzip')) decoders.push(zlib.gunzipSync);
  if (value.includes('br')) decoders.push(zlib.brotliDecompressSync);
  if (value.includes('zstd')) decoders.push(zlib.zstdDecompressSync);
  if (value.includes('deflate')) decoders.push(zlib.inflateSync);
  return decoders;
}

function listHeuristicDecoders(buffer) {
  const decoders = [];
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) decoders.push(zlib.gunzipSync);
  if (buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd) {
    decoders.push(zlib.zstdDecompressSync);
  }
  decoders.push(zlib.brotliDecompressSync, zlib.inflateSync, zlib.inflateRawSync);
  return decoders;
}

function decodeResponseBuffer(buffer, encoding = '') {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (raw.length < 1) return '';

  for (const decoder of listDecodersForEncoding(encoding)) {
    const decoded = tryDecode(raw, decoder);
    if (decoded) return decoded.toString('utf8');
  }

  if (isMostlyText(raw)) return raw.toString('utf8');

  for (const decoder of listHeuristicDecoders(raw)) {
    const decoded = tryDecode(raw, decoder);
    if (decoded) return decoded.toString('utf8');
  }

  return raw.toString('utf8');
}

async function readResponseText(response) {
  if (!response) return '';
  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    return decodeResponseBuffer(buffer, getHeader(response.headers, 'content-encoding'));
  }
  if (typeof response.text === 'function') return String(await response.text());
  return '';
}

async function readResponseJson(response) {
  const text = await readResponseText(response);
  if (text) return JSON.parse(text);
  if (response && typeof response.json === 'function') return response.json();
  return null;
}

function sanitizeResponseText(text, maxLength = 320) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(0, Number(maxLength) || 320));
}

module.exports = {
  decodeResponseBuffer,
  getHeader,
  readResponseJson,
  readResponseText,
  sanitizeResponseText,
  __private: {
    isMostlyText,
    listHeuristicDecoders
  }
};
