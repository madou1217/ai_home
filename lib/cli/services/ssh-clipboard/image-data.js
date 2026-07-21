'use strict';

const crypto = require('node:crypto');

const IMAGE_MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff'
};

function normalizeMimeType(value) {
  const mime = String(value || '').trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'image/tif') return 'image/tiff';
  if (mime === 'public.tiff' || mime === 'public.tif' || mime === 'tiff' || mime === 'tif') return 'image/tiff';
  return Object.values(IMAGE_MIME_BY_EXTENSION).includes(mime) ? mime : '';
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return { extension: 'png', mimeType: 'image/png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' };
  }
  if (
    buffer.length >= 12
    && buffer.slice(0, 4).toString('ascii') === 'RIFF'
    && buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: 'webp', mimeType: 'image/webp' };
  }
  if (
    buffer.length >= 6
    && (buffer.slice(0, 6).toString('ascii') === 'GIF87a'
      || buffer.slice(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return { extension: 'gif', mimeType: 'image/gif' };
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { extension: 'bmp', mimeType: 'image/bmp' };
  }
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00)
    || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  ) {
    return { extension: 'tiff', mimeType: 'image/tiff' };
  }
  return null;
}

function createImageDataError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateImageBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createImageDataError('ssh_clip_image_empty');
  }
  const maxBytes = Math.max(1, Number(options.maxBytes) || (16 * 1024 * 1024));
  if (buffer.length > maxBytes) {
    throw createImageDataError('ssh_clip_image_too_large');
  }
  const detected = detectImageType(buffer);
  if (!detected) {
    throw createImageDataError('ssh_clip_image_unsupported');
  }
  const declaredMimeType = normalizeMimeType(options.mimeType);
  if (declaredMimeType && declaredMimeType !== detected.mimeType) {
    throw createImageDataError('ssh_clip_image_mime_mismatch');
  }
  return {
    ...detected,
    byteLength: buffer.length,
    sha256: sha256Hex(buffer)
  };
}

function extensionFromMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/bmp') return 'bmp';
  if (normalized === 'image/tiff') return 'tiff';
  return '';
}

module.exports = {
  IMAGE_MIME_BY_EXTENSION,
  detectImageType,
  extensionFromMimeType,
  normalizeMimeType,
  sha256Hex,
  validateImageBuffer
};
