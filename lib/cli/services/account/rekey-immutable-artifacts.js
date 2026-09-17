'use strict';

const path = require('node:path');

function executableMagic(bytes) {
  const hex = bytes.subarray(0, 4).toString('hex');
  return new Set(['7f454c46','feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','bebafeca']).has(hex)
    || bytes.subarray(0, 2).toString('ascii') === 'MZ';
}

/**
 * Explicitly immutable sources only. LevelDB's uppercase LOG is diagnostic
 * output, unlike numbered *.log WAL files or CURRENT/MANIFEST databases. A
 * signed extension/native download is executable content, never text config.
 * Callers still fingerprint every classified file; none is deleted or rewritten.
 */
function immutableArtifactReason(fs, relative, file) {
  const normalized = relative.split(path.sep).join('/'), name = path.basename(file);
  if (/^config\.toml\.aih-bak-\d{4}-\d\d-\d\dT[\d-]+Z$/.test(name)) return 'archived_config_snapshot';
  if (normalized.includes('/electron-user-data/') && /^(LOG|LOG\.old(?:\.\d+)?)$/.test(name)) {
    return 'chromium_leveldb_diagnostic';
  }
  const extensionCache = /\/(?:component_crx_cache|extensions_crx_cache)\/[a-f0-9]{64}$/.test(normalized);
  const nativeDownload = /\/(?:\.grok\/downloads|Library\/Caches\/Homebrew\/downloads)\//.test(normalized)
    || /\/\.local\/bin\/(?:agy|claude|codex|grok|qodercli|qoderclicn)$/.test(normalized);
  if (!extensionCache && !nativeDownload) return '';
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const bytes = Buffer.alloc(8);
  try { fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
  if (extensionCache && ['43723234','504b0304'].includes(bytes.subarray(0, 4).toString('hex'))) return 'signed_extension_cache';
  return nativeDownload && executableMagic(bytes) ? 'installed_native_binary' : '';
}

module.exports = { immutableArtifactReason, executableMagic };
