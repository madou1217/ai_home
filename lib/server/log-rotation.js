'use strict';

// Bound on-disk log size. Files are trimmed in place because launchd and daemon
// children can keep stdout/stderr descriptors open; renaming those files would
// make the child continue writing an otherwise invisible old generation.

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function resolveMaxBytes(env) {
  const raw = Number((env || {}).AIH_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

function resolveMaxAgeMs(env) {
  const days = Number((env || {}).AIH_LOG_MAX_AGE_DAYS);
  return Number.isFinite(days) && days > 0
    ? Math.floor(days * 24 * 60 * 60 * 1000)
    : DEFAULT_MAX_AGE_MS;
}

function trimFileToRecentBytes(fs, filePath, maxBytes = DEFAULT_MAX_BYTES) {
  const sizeLimit = Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_MAX_BYTES));
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (_error) {
    return false;
  }
  if (!stats || stats.size <= sizeLimit) return false;

  let fd = null;
  try {
    const start = Math.max(0, stats.size - sizeLimit);
    const buffer = Buffer.allocUnsafe(Math.min(sizeLimit, stats.size));
    fd = fs.openSync(filePath, 'r');
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    fs.closeSync(fd);
    fd = null;

    let retained = buffer.subarray(0, offset);
    if (start > 0) {
      const firstNewline = retained.indexOf(0x0a);
      if (firstNewline >= 0) retained = retained.subarray(firstNewline + 1);
    }
    fs.writeFileSync(filePath, retained);
    return true;
  } catch (_error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_closeError) {}
    }
    try {
      fs.truncateSync(filePath, sizeLimit);
      return true;
    } catch (_truncateError) {
      return false;
    }
  }
}

/**
 * Enforce size and age limits across every `*.log` / `*.jsonl` file under
 * `logsDir`. Trimming happens in place so active daemon file descriptors remain
 * attached to the bounded file.
 *
 * @returns {number} number of files trimmed or removed
 */
function sweepAihLogs(fs, path, logsDir, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : DEFAULT_MAX_AGE_MS;
  const now = Number(options.now) || Date.now();
  const pendingDirs = [logsDir];
  let changed = 0;
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const name = String(entry && entry.name || '');
      const entryPath = path.join(currentDir, name);
      if (entry && typeof entry.isDirectory === 'function' && entry.isDirectory()) {
        pendingDirs.push(entryPath);
        continue;
      }
      if (!/\.(log|jsonl)(?:\.1)?$/i.test(name)) continue;
      let stats = null;
      try { stats = fs.statSync(entryPath); } catch (_error) {}
      if (stats && now - Number(stats.mtimeMs || 0) > maxAgeMs) {
        try {
          fs.rmSync(entryPath, { force: true });
          changed += 1;
        } catch (_error) {}
        continue;
      }
      if (typeof fs.chmodSync === 'function') {
        try { fs.chmodSync(entryPath, 0o600); } catch (_error) {}
      }
      if (trimFileToRecentBytes(fs, entryPath, maxBytes)) changed += 1;
    }
  }
  return changed;
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  resolveMaxBytes,
  resolveMaxAgeMs,
  sweepAihLogs,
  trimFileToRecentBytes
};
