'use strict';

const crypto = require('node:crypto');

function completeStatus(error) {
  return typeof error?.code === 'number' && Number.isInteger(error.code);
}

function transactionError(code, message, recoveryPath, applied = false, cause) {
  const error = new Error(message);
  error.code = code;
  error.recoveryPath = recoveryPath;
  if (code !== 'sftp_replace_recovery_required') error.applied = applied;
  if (cause) error.cause = cause;
  return error;
}

// Used only when the server explicitly lacks atomic replacement.
// mkdir is an atomic per-target claim covering both creation and overwrite
// among AIH writers; nobody steals a stale claim or deletes a conflicting path.
async function recoverableReplace(temporary, target, invoke) {
  const lock = `${target}.aih-replace-lock`;
  const backup = `${lock}/previous-${crypto.randomBytes(12).toString('hex')}`;
  try { await invoke('mkdir', [lock, { mode: 0o700 }]); }
  catch (error) { throw transactionError('sftp_replace_busy', '远端替换被占用或有未恢复事务，请先检查恢复目录', lock, false, error); }

  let moved = false;
  let installed = false;
  try {
    // Even creating a previously absent target must own the claim, otherwise
    // another AIH writer can publish inside the move-old/install-new gap.
    try {
      await invoke('rename', [temporary, target]);
      installed = true;
    } catch (error) {
      if (error?.code !== 4) throw error;
    }
    if (installed) {
      try { await invoke('rmdir', [lock]); }
      catch (error) { throw transactionError('sftp_replace_cleanup_required', '新文件已写入，替换锁目录待清理', lock, true, error); }
      return;
    }
    // A noncooperating writer can still change the path; this is recoverable
    // replacement, not a claim of filesystem CAS or atomic visibility.
    const current = await invoke('lstat', [target]);
    if (!current?.isFile?.() || current?.isSymbolicLink?.()) {
      throw transactionError('sftp_replace_target_changed', '远端目标类型已变化', lock);
    }
    await invoke('rename', [target, backup]);
    moved = true;
    await invoke('rename', [temporary, target]);
    installed = true;
  } catch (error) {
    if (error?.applied) throw error;
    if (moved) {
      // Only a definite negative status authorizes rollback. After connection
      // loss, publication may have happened: preserve recovery material.
      if (!completeStatus(error)) {
        throw transactionError('sftp_replace_recovery_required', '远端替换结果未确认，原文件保留在恢复目录', backup, false, error);
      }
      let absent = false;
      try { await invoke('lstat', [target]); }
      catch (check) { absent = check?.code === 2; }
      if (!absent) {
        throw transactionError('sftp_replace_recovery_required', '远端目标已有内容，保留原文件等待人工核对', backup, false, error);
      }
      try { await invoke('rename', [backup, target]); }
      catch (restore) { throw transactionError('sftp_replace_recovery_required', '恢复原文件未完成，请保留恢复目录', backup, false, restore); }
    } else if (!completeStatus(error) && error.code !== 'sftp_replace_target_changed') {
      throw transactionError('sftp_replace_recovery_required', '远端移动结果未确认，请检查恢复目录', lock, false, error);
    }
    try { await invoke('rmdir', [lock]); }
    catch (cleanup) { throw transactionError('sftp_replace_recovery_required', '原文件未发布新版本，但恢复目录未清理', lock, false, cleanup); }
    throw error;
  }
  if (installed) {
    try { await invoke('unlink', [backup]); }
    catch (error) { throw transactionError('sftp_replace_cleanup_required', '新文件已写入，旧版本待清理', backup, true, error); }
    try { await invoke('rmdir', [lock]); }
    catch (error) { throw transactionError('sftp_replace_cleanup_required', '新文件已写入，替换锁目录待清理', lock, true, error); }
  }
}

module.exports = { recoverableReplace };
