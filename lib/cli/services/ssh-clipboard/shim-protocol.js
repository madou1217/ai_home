'use strict';

const pathBase = require('node:path');

const SHIM_REQUEST_PREFIX = '\x1b]5379;aih-clip-shim;';
const BEL_TERMINATOR = '\x07';
const STRING_TERMINATOR = '\x1b\\';
const DEFAULT_SHIM_TIMEOUT_MS = 8000;

function safeValue(value) {
  return encodeURIComponent(String(value == null ? '' : value));
}

function unsafeValue(value) {
  try {
    return decodeURIComponent(String(value == null ? '' : value));
  } catch (_error) {
    return '';
  }
}

function normalizeShimId(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 96);
}

function normalizeShimMimeType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'targets') return 'TARGETS';
  if (text === 'public.png' || text === 'png') return 'image/png';
  if (text === 'public.jpeg' || text === 'public.jpg' || text === 'jpeg' || text === 'jpg') return 'image/jpeg';
  if (text === 'public.webp' || text === 'webp') return 'image/webp';
  if (text === 'public.gif' || text === 'gif') return 'image/gif';
  if (text === 'public.bmp' || text === 'bmp') return 'image/bmp';
  if (text === 'public.tiff' || text === 'public.tif' || text === 'tiff' || text === 'tif' || text === 'image/tif') return 'image/tiff';
  if (/^(?:image\/(?:png|jpeg|jpg|webp|gif|bmp|tiff)|text\/plain|text\/html)$/.test(text)) {
    return text === 'image/jpg' ? 'image/jpeg' : text;
  }
  return '';
}

function normalizeShimKind(value, mimeType) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'list') return 'list';
  if (text === 'read') return 'read';
  return mimeType === 'TARGETS' ? 'list' : 'read';
}

function buildShimRequestFrame(request = {}) {
  const id = normalizeShimId(request.id);
  const mimeType = normalizeShimMimeType(request.mimeType);
  const kind = normalizeShimKind(request.kind, mimeType);
  const responsePath = String(request.responsePath || '').trim();
  if (!id || !mimeType || !responsePath) return '';
  const fields = {
    v: '1',
    id,
    kind,
    mime: mimeType,
    response: responsePath
  };
  const body = Object.entries(fields)
    .map(([key, value]) => `${key}=${safeValue(value)}`)
    .join(';');
  return `${SHIM_REQUEST_PREFIX}${body}${BEL_TERMINATOR}`;
}

function parseShimRequestBody(body) {
  const fields = {};
  String(body || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return;
    const key = part.slice(0, eq).trim();
    if (!key) return;
    fields[key] = unsafeValue(part.slice(eq + 1));
  });
  if (fields.v !== '1') return null;
  const mimeType = normalizeShimMimeType(fields.mime);
  const id = normalizeShimId(fields.id);
  const responsePath = String(fields.response || '').trim();
  if (!id || !mimeType || !responsePath) return null;
  return {
    id,
    kind: normalizeShimKind(fields.kind, mimeType),
    mimeType,
    responsePath
  };
}

function longestPrefixSuffix(text, prefix) {
  const max = Math.min(text.length, prefix.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (prefix.startsWith(text.slice(text.length - size))) return size;
  }
  return 0;
}

function createShimRequestParser() {
  let buffer = '';

  function consume(data) {
    buffer += Buffer.isBuffer(data) ? data.toString('latin1') : String(data || '');
    const passthrough = [];
    const requests = [];

    while (buffer) {
      const start = buffer.indexOf(SHIM_REQUEST_PREFIX);
      if (start < 0) {
        const suffix = longestPrefixSuffix(buffer, SHIM_REQUEST_PREFIX);
        if (suffix > 0) {
          passthrough.push(buffer.slice(0, buffer.length - suffix));
          buffer = buffer.slice(buffer.length - suffix);
        } else {
          passthrough.push(buffer);
          buffer = '';
        }
        break;
      }
      if (start > 0) {
        passthrough.push(buffer.slice(0, start));
        buffer = buffer.slice(start);
      }

      const bodyStart = SHIM_REQUEST_PREFIX.length;
      const belIndex = buffer.indexOf(BEL_TERMINATOR, bodyStart);
      const stIndex = buffer.indexOf(STRING_TERMINATOR, bodyStart);
      const end = belIndex >= 0 && stIndex >= 0
        ? Math.min(belIndex, stIndex)
        : Math.max(belIndex, stIndex);
      if (end < 0) break;

      const terminatorLength = stIndex >= 0 && stIndex === end ? 2 : 1;
      const body = buffer.slice(bodyStart, end);
      buffer = buffer.slice(end + terminatorLength);
      const request = parseShimRequestBody(body);
      if (request) requests.push(request);
    }

    const text = passthrough.join('');
    return {
      passthrough: text ? Buffer.from(text, 'latin1') : null,
      requests
    };
  }

  return { consume };
}

function isSafeShimResponsePath(rootDir, responsePath, pathImpl = pathBase) {
  const root = pathImpl.resolve(String(rootDir || ''));
  const target = pathImpl.resolve(String(responsePath || ''));
  if (!root || !target || /[\r\n\0]/.test(String(responsePath || ''))) return false;
  return target.startsWith(`${root}${pathImpl.sep}`) && pathImpl.basename(target).endsWith('.json');
}

module.exports = {
  DEFAULT_SHIM_TIMEOUT_MS,
  SHIM_REQUEST_PREFIX,
  buildShimRequestFrame,
  createShimRequestParser,
  isSafeShimResponsePath,
  normalizeShimMimeType
};
