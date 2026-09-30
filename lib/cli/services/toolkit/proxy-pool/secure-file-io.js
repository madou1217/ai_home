'use strict';

const crypto = require('node:crypto');

function ensurePrivateDirectory(fsImpl, directoryPath, options = {}) {
  const existed = fsImpl.existsSync(directoryPath);
  fsImpl.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const enforceMode = options.enforceMode !== false;
  if ((!existed || enforceMode) && typeof fsImpl.chmodSync === 'function' && typeof fsImpl.openSync === 'function') {
    fsImpl.chmodSync(directoryPath, 0o700);
  }
}

// fsync is best-effort durability. Platforms legitimately reject it for reasons
// that say nothing about the data we just wrote: Windows refuses FlushFileBuffers
// on a handle without write access (EPERM) and on directory handles, macOS/Linux
// report EINVAL for directories, and some filesystems do not implement it at all.
// Swallowing those keeps the write itself (which already succeeded) authoritative.
const FSYNC_TOLERATED_CODES = Object.freeze(['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP', 'EBADF']);

function isToleratedFsyncError(error) {
  return Boolean(error) && FSYNC_TOLERATED_CODES.includes(error.code);
}

function fsyncDirectory(fsImpl, directoryPath) {
  if (typeof fsImpl.openSync !== 'function' || typeof fsImpl.fsyncSync !== 'function') return;
  let descriptor = null;
  try {
    descriptor = fsImpl.openSync(directoryPath, 'r');
    fsImpl.fsyncSync(descriptor);
  } catch (error) {
    if (!isToleratedFsyncError(error)) throw error;
  } finally {
    if (descriptor !== null) fsImpl.closeSync(descriptor);
  }
}

// Re-open a file that was just written and flush it. The handle must be opened
// writable: on Windows a read-only handle makes fsync fail with EPERM, which
// previously aborted the whole atomic write on every platform-restart path.
function fsyncFile(fsImpl, filePath) {
  if (typeof fsImpl.openSync !== 'function' || typeof fsImpl.fsyncSync !== 'function') return;
  let descriptor = null;
  try {
    descriptor = fsImpl.openSync(filePath, 'r+');
    fsImpl.fsyncSync(descriptor);
  } catch (error) {
    if (!isToleratedFsyncError(error)) throw error;
  } finally {
    if (descriptor !== null) fsImpl.closeSync(descriptor);
  }
}

function atomicWritePrivateFile(fsImpl, pathImpl, filePath, content, options = {}) {
  const directoryPath = pathImpl.dirname(filePath);
  ensurePrivateDirectory(fsImpl, directoryPath, options);
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fsImpl.writeFileSync(tempPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    fsyncFile(fsImpl, tempPath);
    fsImpl.renameSync(tempPath, filePath);
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(filePath, 0o600);
    fsyncDirectory(fsImpl, directoryPath);
  } catch (error) {
    if (typeof fsImpl.unlinkSync === 'function') {
      try { fsImpl.unlinkSync(tempPath); } catch (_unlinkError) { /* best effort */ }
    }
    throw error;
  }
}

module.exports = {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  fsyncDirectory,
  fsyncFile
};
