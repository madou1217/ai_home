'use strict';

const path = require('node:path');
const { toNodePlatform } = require('./client-platform');

function normalizePathString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolvePlatformPath(platform, preferredPath) {
  const normalizedPlatform = toNodePlatform(platform)
    || String(platform || process.platform || '').trim().toLowerCase();
  const expectedSeparator = normalizedPlatform === 'win32' ? '\\' : '/';
  if (preferredPath && (!preferredPath.sep || preferredPath.sep === expectedSeparator)) {
    return preferredPath;
  }
  return normalizedPlatform === 'win32' ? path.win32 : path.posix;
}

function resolveRootPath(root, preferredPath = path) {
  const value = normalizePathString(root);
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) return path.win32;
  if (value.startsWith('/')) return path.posix;
  return preferredPath;
}

module.exports = {
  normalizePathString,
  resolvePlatformPath,
  resolveRootPath
};
