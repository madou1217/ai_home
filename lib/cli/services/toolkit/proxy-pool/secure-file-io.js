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

function fsyncDirectory(fsImpl, directoryPath) {
  if (typeof fsImpl.openSync !== 'function' || typeof fsImpl.fsyncSync !== 'function') return;
  let descriptor = null;
  try {
    descriptor = fsImpl.openSync(directoryPath, 'r');
    fsImpl.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== null) fsImpl.closeSync(descriptor);
  }
}

function atomicWritePrivateFile(fsImpl, pathImpl, filePath, content, options = {}) {
  const directoryPath = pathImpl.dirname(filePath);
  ensurePrivateDirectory(fsImpl, directoryPath, options);
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let descriptor = null;
  try {
    fsImpl.writeFileSync(tempPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    if (typeof fsImpl.openSync === 'function' && typeof fsImpl.fsyncSync === 'function') {
      descriptor = fsImpl.openSync(tempPath, 'r');
      fsImpl.fsyncSync(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = null;
    }
    fsImpl.renameSync(tempPath, filePath);
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(filePath, 0o600);
    fsyncDirectory(fsImpl, directoryPath);
  } catch (error) {
    if (descriptor !== null && typeof fsImpl.closeSync === 'function') {
      try { fsImpl.closeSync(descriptor); } catch (_closeError) { /* best effort */ }
    }
    if (typeof fsImpl.unlinkSync === 'function') {
      try { fsImpl.unlinkSync(tempPath); } catch (_unlinkError) { /* best effort */ }
    }
    throw error;
  }
}

module.exports = {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  fsyncDirectory
};
