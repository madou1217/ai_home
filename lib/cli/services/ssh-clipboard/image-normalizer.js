'use strict';

const fsBase = require('node:fs');
const osBase = require('node:os');
const pathBase = require('node:path');
const { spawnSync: spawnSyncBase } = require('node:child_process');
const { validateImageBuffer } = require('./image-data');

function createTempDir(fsImpl, osImpl, pathImpl) {
  return fsImpl.mkdtempSync(pathImpl.join(osImpl.tmpdir(), 'aih-image-normalize-'));
}

function cleanupTempDir(fsImpl, dir) {
  try {
    if (typeof fsImpl.rmSync === 'function') {
      fsImpl.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_error) {}
}

function readValidatedPng(fsImpl, filePath, maxBytes) {
  try {
    const buffer = fsImpl.readFileSync(filePath);
    const info = validateImageBuffer(buffer, {
      mimeType: 'image/png',
      maxBytes
    });
    return {
      buffer,
      mimeType: info.mimeType,
      byteLength: info.byteLength,
      sha256: info.sha256
    };
  } catch (_error) {
    return null;
  }
}

function runConverter(spawnSync, command, args) {
  try {
    const result = spawnSync(command, args, {
      stdio: 'ignore'
    });
    return Boolean(result && result.status === 0);
  } catch (_error) {
    return false;
  }
}

function tryConvertTiffToPng(buffer, options = {}) {
  const fsImpl = options.fs || fsBase;
  const osImpl = options.os || osBase;
  const pathImpl = options.path || pathBase;
  const spawnSync = options.spawnSync || spawnSyncBase;
  const maxBytes = Math.max(1, Number(options.maxBytes) || (16 * 1024 * 1024));
  let dir = '';
  try {
    dir = createTempDir(fsImpl, osImpl, pathImpl);
    const inputPath = pathImpl.join(dir, 'clipboard.tiff');
    const outputPath = pathImpl.join(dir, 'clipboard.png');
    fsImpl.writeFileSync(inputPath, buffer);
    const converters = [
      { command: 'sips', args: ['-s', 'format', 'png', inputPath, '--out', outputPath] },
      { command: 'magick', args: [inputPath, outputPath] },
      { command: 'convert', args: [inputPath, outputPath] }
    ];
    for (const converter of converters) {
      if (!runConverter(spawnSync, converter.command, converter.args)) continue;
      const image = readValidatedPng(fsImpl, outputPath, maxBytes);
      if (image) return image;
    }
  } catch (_error) {
  } finally {
    if (dir) cleanupTempDir(fsImpl, dir);
  }
  return null;
}

function normalizeImageForInjection(image = {}, options = {}) {
  const buffer = Buffer.isBuffer(image.buffer) ? image.buffer : Buffer.alloc(0);
  const maxBytes = Math.max(1, Number(options.maxBytes) || (16 * 1024 * 1024));
  const info = validateImageBuffer(buffer, {
    mimeType: image.mimeType,
    maxBytes
  });
  if (info.mimeType === 'image/tiff') {
    const converted = tryConvertTiffToPng(buffer, {
      ...options,
      maxBytes
    });
    if (converted) return converted;
  }
  return {
    buffer,
    mimeType: info.mimeType,
    byteLength: info.byteLength,
    sha256: info.sha256
  };
}

module.exports = {
  normalizeImageForInjection,
  tryConvertTiffToPng
};
