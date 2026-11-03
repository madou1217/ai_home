'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const VIDEO_FRAME_DIR_SUFFIX = '.frames';

function atomicWriteFileSync(fsImpl, filePath, data, options = {}) {
  if (!fsImpl || typeof fsImpl.writeFileSync !== 'function'
      || typeof fsImpl.renameSync !== 'function') {
    const error = new Error('chat_attachment_fs_unavailable');
    error.code = 'chat_attachment_fs_unavailable';
    throw error;
  }
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
  );
  try {
    fsImpl.writeFileSync(tempPath, data, { ...options, flag: 'wx' });
    fsImpl.renameSync(tempPath, filePath);
  } catch (error) {
    removePathBestEffort(fsImpl, tempPath);
    throw error;
  }
  return filePath;
}

function cleanupPersistedAttachments(fsImpl, filePaths) {
  for (const filePath of new Set(Array.isArray(filePaths) ? filePaths.filter(Boolean) : [])) {
    removePathBestEffort(fsImpl, `${filePath}${VIDEO_FRAME_DIR_SUFFIX}`, true);
    removePathBestEffort(fsImpl, filePath);
  }
}

function removePathBestEffort(fsImpl, targetPath, recursive = false) {
  if (!fsImpl || !targetPath) return;
  try {
    if (typeof fsImpl.rmSync === 'function') {
      fsImpl.rmSync(targetPath, { recursive, force: true });
    } else if (!recursive && typeof fsImpl.unlinkSync === 'function') {
      fsImpl.unlinkSync(targetPath);
    }
  } catch (_error) {
    // Rollback is best-effort; preserve the original persistence failure.
  }
}

module.exports = {
  VIDEO_FRAME_DIR_SUFFIX,
  atomicWriteFileSync,
  cleanupPersistedAttachments,
  removePathBestEffort
};
