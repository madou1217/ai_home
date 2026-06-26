'use strict';

const ENCODED_PATH_COLON = String.fromCharCode(0xf03a);
const ENCODED_PATH_SLASH = String.fromCharCode(0xf02f);
const ENCODED_PATH_BACKSLASH = String.fromCharCode(0xf05c);
const ENCODED_PATH_SEPARATORS = new Set([ENCODED_PATH_SLASH, ENCODED_PATH_BACKSLASH]);

function isEncodedWindowsAbsolutePath(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (
    /^[A-Za-z]$/.test(text[0] || '')
    && text[1] === ENCODED_PATH_COLON
    && ENCODED_PATH_SEPARATORS.has(text[2])
  ) {
    return true;
  }
  return text.startsWith(`${ENCODED_PATH_BACKSLASH}${ENCODED_PATH_BACKSLASH}`);
}

function decodeEncodedWindowsPath(value) {
  const text = String(value || '').trim();
  if (!isEncodedWindowsAbsolutePath(text)) return text;
  return text
    .replaceAll(ENCODED_PATH_COLON, ':')
    .replaceAll(ENCODED_PATH_SLASH, '/')
    .replaceAll(ENCODED_PATH_BACKSLASH, '\\');
}

function isWindowsAbsolutePathEntryName(name) {
  const entryName = String(name || '').trim();
  if (!entryName) return false;
  if (/^[A-Za-z]:[\\/]/.test(entryName)) return true;
  if (entryName.startsWith('\\\\')) return true;
  return isEncodedWindowsAbsolutePath(entryName);
}

function normalizeWindowsPathForCodexConfig(value) {
  const decoded = decodeEncodedWindowsPath(value);
  if (!isWindowsAbsolutePathEntryName(decoded)) return decoded;
  return decoded.replace(/\\/g, '/');
}

module.exports = {
  decodeEncodedWindowsPath,
  isEncodedWindowsAbsolutePath,
  isWindowsAbsolutePathEntryName,
  normalizeWindowsPathForCodexConfig
};
