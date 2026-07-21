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

function stripWindowsLongPathPrefix(value) {
  const text = String(value || '').trim();
  if (text.startsWith('\\\\?\\UNC\\')) return `\\\\${text.slice('\\\\?\\UNC\\'.length)}`;
  if (text.startsWith('\\\\?\\')) return text.slice('\\\\?\\'.length);
  return text;
}

function isWslDriveMountPath(value) {
  return /^\/mnt\/[A-Za-z](?:\/|$)/.test(String(value || '').trim());
}

function trimTrailingSeparators(value) {
  const text = String(value || '').trim();
  if (/^[A-Za-z]:[\\/]?$/.test(text)) return text.replace('/', '\\');
  if (/^\/mnt\/[A-Za-z]\/?$/.test(text)) return text.replace(/\/+$/, '');
  return text.replace(/[\\/]+$/, '');
}

function normalizeHostPathForLookup(value, options = {}) {
  const platform = String(options.platform || process.platform || '').trim();
  const decoded = stripWindowsLongPathPrefix(decodeEncodedWindowsPath(value));
  const text = String(decoded || '').trim();
  if (!text) return '';

  const wslMatch = text.match(/^\/mnt\/([A-Za-z])(?:\/|$)(.*)$/);
  if (wslMatch && platform === 'win32') {
    const drive = wslMatch[1].toUpperCase();
    const rest = String(wslMatch[2] || '').replace(/\//g, '\\');
    return trimTrailingSeparators(`${drive}:\\${rest}`);
  }

  const driveMatch = text.match(/^([A-Za-z]):[\\/]*(.*)$/);
  if (driveMatch) {
    const rest = String(driveMatch[2] || '').replace(/[\\/]+/g, platform === 'win32' ? '\\' : '/');
    if (platform === 'win32') {
      return trimTrailingSeparators(`${driveMatch[1].toUpperCase()}:\\${rest}`);
    }
    return trimTrailingSeparators(`/mnt/${driveMatch[1].toLowerCase()}${rest ? `/${rest}` : ''}`);
  }

  if (text.startsWith('\\\\')) {
    return platform === 'win32'
      ? trimTrailingSeparators(text.replace(/\//g, '\\'))
      : trimTrailingSeparators(text.replace(/\\/g, '/'));
  }

  return trimTrailingSeparators(text.replace(/\\/g, '/'));
}

function buildHostPathLookupVariants(value, options = {}) {
  const platform = String(options.platform || process.platform || '').trim();
  const decoded = stripWindowsLongPathPrefix(decodeEncodedWindowsPath(value));
  const normalized = normalizeHostPathForLookup(decoded, { platform });
  const variants = new Set([normalized, trimTrailingSeparators(decoded)]);

  const slashInputs = [normalized, decoded].map((item) => String(item || '').replace(/\\/g, '/'));
  for (const slashInput of slashInputs) {
    const wslMatch = slashInput.match(/^\/mnt\/([A-Za-z])(?:\/|$)(.*)$/);
    if (!wslMatch) continue;
    const drive = wslMatch[1].toUpperCase();
    const restSlash = String(wslMatch[2] || '');
    const windowsSlash = `${drive}:/${restSlash}`;
    const windowsBackslash = `${drive}:\\${restSlash.replace(/\//g, '\\')}`;
    variants.add(trimTrailingSeparators(windowsSlash));
    variants.add(trimTrailingSeparators(windowsBackslash));
    variants.add(trimTrailingSeparators(`\\\\?\\${windowsBackslash}`));
  }

  for (const input of [decoded, normalized]) {
    const driveMatch = String(input || '').match(/^([A-Za-z]):[\\/]*(.*)$/);
    if (!driveMatch) continue;
    const restSlash = String(driveMatch[2] || '').replace(/[\\/]+/g, '/');
    const windowsBackslash = `${driveMatch[1].toUpperCase()}:\\${restSlash.replace(/\//g, '\\')}`;
    variants.add(trimTrailingSeparators(`/mnt/${driveMatch[1].toLowerCase()}${restSlash ? `/${restSlash}` : ''}`));
    variants.add(trimTrailingSeparators(`${driveMatch[1].toUpperCase()}:/${restSlash}`));
    variants.add(trimTrailingSeparators(windowsBackslash));
    variants.add(trimTrailingSeparators(`\\\\?\\${windowsBackslash}`));
  }

  return Array.from(variants)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeWindowsPathForCodexConfig(value) {
  const decoded = decodeEncodedWindowsPath(value);
  if (!isWindowsAbsolutePathEntryName(decoded)) return decoded;
  return decoded.replace(/\\/g, '/');
}

module.exports = {
  buildHostPathLookupVariants,
  decodeEncodedWindowsPath,
  isEncodedWindowsAbsolutePath,
  isWindowsAbsolutePathEntryName,
  isWslDriveMountPath,
  normalizeHostPathForLookup,
  normalizeWindowsPathForCodexConfig
};
