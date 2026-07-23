'use strict';

const path = require('node:path');

function resolvePlatformPath(platform, preferredPath) {
  const normalizedPlatform = String(platform || process.platform || '').trim();
  const expectedSeparator = normalizedPlatform === 'win32' ? '\\' : '/';
  if (preferredPath && (!preferredPath.sep || preferredPath.sep === expectedSeparator)) {
    return preferredPath;
  }
  return normalizedPlatform === 'win32' ? path.win32 : path.posix;
}

function resolveRootPath(root, preferredPath = path) {
  const value = String(root || '').trim();
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) return path.win32;
  if (value.startsWith('/')) return path.posix;
  return preferredPath;
}

module.exports = {
  resolvePlatformPath,
  resolveRootPath
};
