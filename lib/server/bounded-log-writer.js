'use strict';

const nodePath = require('node:path');
const { DEFAULT_MAX_BYTES, trimFileToRecentBytes } = require('./log-rotation');

const TRIM_LOW_WATERMARK_RATIO = 0.8;

function appendBoundedLine(fs, filePath, line, options = {}) {
  const normalizedPath = String(filePath || '').trim();
  if (!fs || !normalizedPath) return false;
  const path = options.path || nodePath;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const payload = `${String(line == null ? '' : line)}\n`;
  const payloadBytes = Buffer.byteLength(payload);
  if (payloadBytes > maxBytes) return false;
  try {
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
    let currentBytes = 0;
    try {
      currentBytes = Number(fs.statSync(normalizedPath).size) || 0;
    } catch (_error) {}
    if (currentBytes + payloadBytes > maxBytes) {
      // Trim to a low watermark, not to exactly maxBytes: a full log otherwise rewrites
      // the whole file (10MB, synchronously) on every appended line. The file still never
      // exceeds maxBytes; trimming now happens once per ~20% of maxBytes written.
      const lowWatermark = Math.floor(maxBytes * TRIM_LOW_WATERMARK_RATIO);
      const retainedBytes = Math.min(maxBytes - payloadBytes, lowWatermark);
      if (retainedBytes <= 0) {
        fs.truncateSync(normalizedPath, 0);
      } else if (!trimFileToRecentBytes(fs, normalizedPath, retainedBytes)) {
        return false;
      }
    }
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(normalizedPath, 0o600); } catch (_chmodError) {}
    }
    fs.appendFileSync(normalizedPath, payload, 'utf8');
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(normalizedPath, 0o600); } catch (_chmodError) {}
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function appendBoundedJsonLine(fs, filePath, value, options = {}) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? false
      : appendBoundedLine(fs, filePath, serialized, options);
  } catch (_error) {
    return false;
  }
}

module.exports = {
  appendBoundedJsonLine,
  appendBoundedLine
};
