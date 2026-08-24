'use strict';

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

function normalizeImageMime(value) {
  const mimeType = String(value || '').split(';')[0].trim().toLowerCase();
  if (mimeType === 'image/jpg') return 'image/jpeg';
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : '';
}

function decodeCanonicalBase64(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const unpadded = compact.replace(/=+$/, '');
  const padded = `${unpadded}${'='.repeat((4 - (unpadded.length % 4)) % 4)}`;
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.length < 1) return null;
  const canonical = bytes.toString('base64');
  if (canonical.replace(/=+$/, '') !== unpadded) return null;
  return { base64: canonical, bytes };
}

function detectImageMime(bytes) {
  if (!Buffer.isBuffer(bytes)) return '';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return '';
}

module.exports = {
  SUPPORTED_IMAGE_MIME_TYPES,
  decodeCanonicalBase64,
  detectImageMime,
  normalizeImageMime
};
