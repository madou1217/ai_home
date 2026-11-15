'use strict';

const crypto = require('node:crypto');
const path = require('node:path').posix;
const layout = require('../../../../contracts/backuprepository/format.json');
const { writeSftpStage } = require('../../../runtime/sftp-stage');
const { replaceSftpFile, unsupportedRename } = require('../../../runtime/sftp-rename');

function scopeError(code, lock, cause, applied) {
  const e = new Error(code); e.code = code; e.recoveryPath = lock; e.cause = cause;
  if (typeof applied === 'boolean') e.applied = applied;
  return e;
}
async function beginRepositoryScope({ session, baseDir, joinRemote, timeoutMs, signal, recovery = false }) {
  const lock = joinRemote(baseDir, layout.lockPath), token = `${crypto.randomBytes(24).toString('hex')}\n`;
  let uncertain = false, applied = false, journal = null;
  const invoke = async (method, args, override) => {
    if (uncertain || session.closed()) throw scopeError('backup_repository_recovery_required', lock);
    try { return await session.call(method, args, { timeoutMs, signal, ...override }); }
    catch (error) { if (typeof error.code !== 'number' && !(method === 'ext_openssh_rename' && unsupportedRename(error))) uncertain = true; throw error; }
  };
  const ensureDir = async (directory) => {
    let current = directory.startsWith('/') ? '' : '.';
    for (const part of directory.split('/').filter(Boolean)) {
      current = current === '' ? `/${part}` : `${current}/${part}`;
      try { await invoke('mkdir', [current, { mode: 0o700 }]); }
      catch (error) { if (uncertain) throw error; const attrs = await invoke('stat', [current]); if (!attrs.isDirectory?.()) throw error; }
    }
  };
  const read = async (relative, limit, override) => {
    const file = joinRemote(baseDir, relative); let handle;
    try { handle = await invoke('open', [file, 'r'], override); }
    catch (error) { if (error.code === 2) return null; throw error; }
    const parts = []; let size = 0;
    try {
      for (;;) {
        const buffer = Buffer.alloc(Math.min(32768, limit + 1 - size));
        const count = await invoke('read', [handle, buffer, 0, buffer.length, size], override);
        if (!count) break;
        size += count; parts.push(buffer.subarray(0, count));
        if (size > limit) throw scopeError('backup_object_too_large', lock);
      }
      await invoke('close', [handle], override); handle = null;
      return Buffer.concat(parts, size);
    } finally { if (handle && !uncertain && !session.closed()) await invoke('close', [handle], override); }
  };
  await ensureDir(path.dirname(lock));
  const checkRecovery = async () => {
    if (recovery) return;
    try { await invoke('lstat', [joinRemote(baseDir, 'v2/.recovery-lock')]); }
    catch (error) { if (error.code === 2) return; throw error; }
    throw scopeError('backup_repository_busy', lock);
  };
  await checkRecovery();
  const lockStage = joinRemote(baseDir, `v2/.lock-stage-${token.trim()}`);
  await invoke('mkdir', [lockStage, { mode: 0o700 }]);
  try {
    await writeSftpStage(invoke, `${lockStage}/owner`, Buffer.from(token), { mode: 0o600 });
    await invoke('rename', [lockStage, lock]);
  } catch (error) {
    if (!uncertain && !session.closed()) {
      try { await invoke('unlink', [`${lockStage}/owner`]); await invoke('rmdir', [lockStage]); }
      catch (cleanup) { if (uncertain) error = cleanup; }
    }
    throw scopeError(uncertain ? 'backup_repository_recovery_required' : 'backup_repository_busy', lock, error);
  }
  await checkRecovery();
  return {
    read,
    async putImmutable(relative, bytes, refresh = false) {
      const owner = await read(`${layout.lockPath}/owner`, 1024);
      if (!owner || owner.toString() !== token) { uncertain = true; throw scopeError('backup_repository_recovery_required', lock); }
      const existing = await read(relative, bytes.length + 1);
      if (existing) { if (!existing.equals(bytes)) throw scopeError('backup_immutable_conflict', lock); if (!refresh) return false; }
      const file = joinRemote(baseDir, relative), stage = `${file}.stage-${token.slice(0, 24)}`;
      await ensureDir(path.dirname(file));
      let owned = false;
      try {
        await writeSftpStage(invoke, stage, bytes, { mode: 0o600, onOwned: () => { owned = true; } });
        if (existing) { await invoke('unlink', [stage]); return false; }
        await invoke('rename', [stage, file]); // no-overwrite v3, not POSIX replace
        return true;
      } catch (error) {
        if (owned && !uncertain && !session.closed()) await invoke('unlink', [stage]).catch(() => {});
        if (!uncertain) { const now = await read(relative, bytes.length + 1); if (now?.equals(bytes)) return false; }
        throw error;
      }
    },
    retain() { uncertain = true; },
    async journal(bytes) {
      try { await this.putImmutable(`${layout.lockPath}/intent.json`, bytes); journal = Buffer.from(bytes); }
      catch (error) { uncertain = true; throw error; }
    },
    async publish(relative, bytes) {
      const owner = await read(`${layout.lockPath}/owner`, 1024);
      if (!owner || owner.toString() !== token) { uncertain = true; throw scopeError('backup_repository_recovery_required', lock); }
      const file = joinRemote(baseDir, relative), stage = `${file}.publish-${token.slice(0, 24)}`;
      await ensureDir(path.dirname(file));
      try {
        await writeSftpStage(invoke, stage, bytes, { mode: 0o600 });
        await replaceSftpFile(session.stream, stage, file, invoke);
        applied = true;
      } catch (error) {
        uncertain = true;
        if (error.code === 'sftp_replace_cleanup_required' && error.applied === true) applied = true;
        throw scopeError('backup_repository_recovery_required', lock, error, applied ? true : undefined);
      }
    },
    async release() {
      if (uncertain || session.closed()) throw scopeError('backup_repository_recovery_required', lock, undefined, applied ? true : undefined);
      const deadline = Date.now() + 3000;
      const cleanup = () => ({ signal: undefined, timeoutMs: Math.max(1, deadline - Date.now()) });
      try {
        const value = await read(`${layout.lockPath}/owner`, 1024, cleanup());
        if (!value || value.toString() !== token) throw new Error('backup_lock_ownership_changed');
        if (journal) {
          const record = await read(`${layout.lockPath}/intent.json`, 4096, cleanup());
          if (!record?.equals(journal)) throw new Error('backup_journal_changed');
        }
        // One namespace operation releases ownership; owner/journal never
        // disappear separately, so a crash cannot create an ownerless lock.
        await invoke('rename', [lock, joinRemote(baseDir, `v2/.completed-${token.trim()}`)], cleanup());
      } catch (error) { throw scopeError('backup_repository_cleanup_required', lock, error, applied ? true : undefined); }
    }
  };
}
module.exports = { beginRepositoryScope };
