'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeMimeType, sha256Hex, validateImageBuffer } = require('./image-data');

const OSC_PREFIX = '\x1b]5379;aih-clip;';
const BEL = '\x07';
const DEFAULT_CHUNK_SIZE = 3072;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CHUNKS = 8192;
const DEFAULT_MAX_BUFFERED_TEXT = 24 * 1024 * 1024;
const DEFAULT_PENDING_TTL_MS = 10_000;
const ALLOWED_ACTIONS = new Set(['paste', 'cache']);

function createFrameError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return ALLOWED_ACTIONS.has(action) ? action : 'paste';
}

function safeFrameValue(value) {
  return encodeURIComponent(String(value == null ? '' : value));
}

function unsafeFrameValue(value) {
  try {
    return decodeURIComponent(String(value == null ? '' : value));
  } catch (_error) {
    return '';
  }
}

function buildFrameText(fields) {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${safeFrameValue(value)}`);
  return `${OSC_PREFIX}${pairs.join(';')}${BEL}`;
}

function encodeClipboardImageFrames(image, options = {}) {
  const buffer = Buffer.isBuffer(image && image.buffer) ? image.buffer : Buffer.alloc(0);
  const mimeType = normalizeMimeType(image && image.mimeType);
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const info = validateImageBuffer(buffer, { mimeType, maxBytes });
  const chunkSize = Math.max(512, Number(options.chunkSize) || DEFAULT_CHUNK_SIZE);
  const base64 = buffer.toString('base64');
  const total = Math.max(1, Math.ceil(base64.length / chunkSize));
  const id = String(options.id || randomUUID()).replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 96) || randomUUID();
  const action = normalizeAction(options.action);
  const frames = [];

  for (let index = 0; index < total; index += 1) {
    frames.push(buildFrameText({
      v: '1',
      id,
      action,
      seq: String(index + 1),
      total: String(total),
      mime: info.mimeType,
      bytes: String(buffer.length),
      sha256: info.sha256,
      data: base64.slice(index * chunkSize, (index + 1) * chunkSize)
    }));
  }

  return {
    id,
    action,
    mimeType: info.mimeType,
    sha256: info.sha256,
    byteLength: buffer.length,
    frames
  };
}

function parseFrameBody(body) {
  const fields = {};
  String(body || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return;
    const key = part.slice(0, eq).trim();
    if (!key) return;
    fields[key] = unsafeFrameValue(part.slice(eq + 1));
  });
  return fields;
}

function parsePositiveInteger(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : 0;
}

function longestPrefixSuffix(text, prefix) {
  const max = Math.min(text.length, prefix.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (prefix.startsWith(text.slice(text.length - size))) return size;
  }
  return 0;
}

function normalizeChunkData(value) {
  const data = String(value || '').trim();
  return /^[A-Za-z0-9+/=]*$/.test(data) ? data : '';
}

function createClipboardFrameParser(options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const maxChunks = Math.max(1, Number(options.maxChunks) || DEFAULT_MAX_CHUNKS);
  const maxBufferedText = Math.max(OSC_PREFIX.length + 128, Number(options.maxBufferedText) || DEFAULT_MAX_BUFFERED_TEXT);
  const pendingTtlMs = Math.max(1000, Number(options.pendingTtlMs) || DEFAULT_PENDING_TTL_MS);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  let buffer = '';
  const pending = new Map();

  function pruneExpired() {
    const cutoff = now() - pendingTtlMs;
    for (const [id, item] of pending.entries()) {
      if (item.updatedAt < cutoff) pending.delete(id);
    }
  }

  function resetOversizedBuffer() {
    if (buffer.length <= maxBufferedText) return;
    const suffix = longestPrefixSuffix(buffer, OSC_PREFIX);
    buffer = suffix > 0 ? buffer.slice(buffer.length - suffix) : '';
  }

  function acceptFrame(fields) {
    if (fields.v !== '1') return null;
    const id = String(fields.id || '').trim();
    if (!/^[A-Za-z0-9._-]{1,96}$/.test(id)) return null;
    const seq = parsePositiveInteger(fields.seq);
    const total = parsePositiveInteger(fields.total);
    const bytes = parsePositiveInteger(fields.bytes);
    const sha256 = String(fields.sha256 || '').trim().toLowerCase();
    const mimeType = normalizeMimeType(fields.mime);
    const data = normalizeChunkData(fields.data);
    if (!seq || !total || seq > total || total > maxChunks || !bytes || bytes > maxBytes) return null;
    if (!/^[a-f0-9]{64}$/.test(sha256) || !mimeType || !data) return null;

    let item = pending.get(id);
    if (!item) {
      item = {
        id,
        action: normalizeAction(fields.action),
        total,
        bytes,
        sha256,
        mimeType,
        chunks: new Map(),
        updatedAt: now()
      };
      pending.set(id, item);
    }
    if (
      item.total !== total
      || item.bytes !== bytes
      || item.sha256 !== sha256
      || item.mimeType !== mimeType
    ) {
      pending.delete(id);
      return null;
    }

    item.updatedAt = now();
    item.chunks.set(seq, data);
    if (item.chunks.size !== item.total) return null;

    let base64 = '';
    for (let index = 1; index <= item.total; index += 1) {
      const chunk = item.chunks.get(index);
      if (!chunk) return null;
      base64 += chunk;
    }
    pending.delete(id);

    const imageBuffer = Buffer.from(base64, 'base64');
    if (imageBuffer.length !== item.bytes || sha256Hex(imageBuffer) !== item.sha256) {
      throw createFrameError('ssh_clip_frame_checksum_mismatch');
    }
    const info = validateImageBuffer(imageBuffer, { mimeType: item.mimeType, maxBytes });
    return {
      id: item.id,
      action: item.action,
      buffer: imageBuffer,
      mimeType: info.mimeType,
      sha256: info.sha256,
      byteLength: info.byteLength
    };
  }

  function consume(data) {
    pruneExpired();
    const input = Buffer.isBuffer(data) ? data.toString('latin1') : String(data || '');
    buffer += input;
    resetOversizedBuffer();

    const passthroughParts = [];
    const images = [];
    const errors = [];

    while (buffer) {
      const start = buffer.indexOf(OSC_PREFIX);
      if (start < 0) {
        const suffix = longestPrefixSuffix(buffer, OSC_PREFIX);
        if (suffix > 0) {
          passthroughParts.push(buffer.slice(0, buffer.length - suffix));
          buffer = buffer.slice(buffer.length - suffix);
        } else {
          passthroughParts.push(buffer);
          buffer = '';
        }
        break;
      }

      if (start > 0) {
        passthroughParts.push(buffer.slice(0, start));
        buffer = buffer.slice(start);
      }

      const bodyStart = OSC_PREFIX.length;
      const belIndex = buffer.indexOf(BEL, bodyStart);
      const stIndex = buffer.indexOf('\x1b\\', bodyStart);
      const end = belIndex >= 0 && stIndex >= 0
        ? Math.min(belIndex, stIndex)
        : Math.max(belIndex, stIndex);
      if (end < 0) break;

      const terminatorLength = stIndex >= 0 && stIndex === end ? 2 : 1;
      const body = buffer.slice(bodyStart, end);
      buffer = buffer.slice(end + terminatorLength);

      try {
        const image = acceptFrame(parseFrameBody(body));
        if (image) images.push(image);
      } catch (error) {
        errors.push(error);
      }
    }

    const passthroughText = passthroughParts.join('');
    return {
      passthrough: passthroughText ? Buffer.from(passthroughText, 'latin1') : null,
      images,
      errors
    };
  }

  return {
    consume,
    getPendingCount: () => pending.size
  };
}

module.exports = {
  BEL,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MAX_BYTES,
  OSC_PREFIX,
  createClipboardFrameParser,
  encodeClipboardImageFrames
};
