'use strict';

// SFTP wire/timeout ownership is separate from workspace file semantics. Failed
// acknowledgements never authorize deleting or blindly retrying the old target.
const { remoteError } = require('../errors');
const crypto = require('node:crypto');
const { replaceSftpFile } = require('../../runtime/sftp-rename');
const { openSftpSession } = require('../channel/sftp-session');

function mapSftpError(error, path) {
  if (error?.code === 2) return remoteError('not_found', `远端不存在：${path}`);
  if (error?.code === 3) return remoteError('permission_denied', `没有权限：${path}`);
  if (['aborted', 'operation_timeout', 'connection_lost'].includes(error?.code)) return error;
  return remoteError('remote_io_error', `远端读写失败：${path}`, { cause: String(error?.message || error) });
}

async function call(session, method, args, path, options) {
  try { return await session.call(method, args, options); }
  catch (error) { throw mapSftpError(error, path); }
}

function typeOf(attrs) {
  if (attrs.isSymbolicLink?.()) return 'l';
  if (attrs.isDirectory?.()) return 'd';
  return 'f';
}

const sftpFileOps = {
  id: 'sftp',

  async stat(raw, absPath, options) {
    const session = await openSftpSession(raw, options);
    const attrs = await call(session, 'stat', [absPath], absPath, options);
    return { type: typeOf(attrs), size: attrs.size, mtime: attrs.mtime };
  },

  async readFile(raw, absPath, options) {
    const session = await openSftpSession(raw, options);
    const attrs = await call(session, 'stat', [absPath], absPath, options);
    if (attrs.isDirectory?.()) throw remoteError('is_directory', `是目录：${absPath}`);
    if (attrs.size > options.maxBytes) throw remoteError('file_too_large', `文件过大（${attrs.size} 字节）`, { size: attrs.size });
    const content = await call(session, 'readFile', [absPath], absPath, options);
    return { content, size: attrs.size, mtime: attrs.mtime };
  },

  async writeFile(raw, absPath, content, options) {
    const session = await openSftpSession(raw, options);
    const slash = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
    const dir = slash > 0 ? absPath.slice(0, slash) : '.';
    const separator = absPath.includes('\\') && !absPath.includes('/') ? '\\' : '/';
    const temp = `${dir}${separator}.aih-write.${process.pid}.${crypto.randomBytes(12).toString('hex')}`;
    let owned = false;
    let publishing = false;
    let closedHandle = false;
    let handle;
    try {
      handle = await session.call('open', [temp, 'wx', Number.isInteger(options.mode) ? options.mode : 0o666], options);
      owned = true;
      // ssh2 write handles packet splitting; a separate CLOSE ACK is required.
      await session.call('write', [handle, content, 0, content.length, 0], options);
      closedHandle = true;
      await session.call('close', [handle], options);
      if (options.signal?.aborted) throw remoteError('aborted', 'SFTP 操作已取消');
      publishing = true;
      await replaceSftpFile(session.stream, temp, absPath, (method, args) => session.call(method, args, options));
    } catch (error) {
      // On timeout, bytes may already be accepted by the peer. This code is
      // intentionally non-retryable; do not claim rollback or replay a write.
      const uncertain = publishing && typeof error?.code !== 'number';
      const recoveryRequired = ['sftp_replace_recovery_required', 'sftp_replace_cleanup_required'].includes(error?.code);
      if (!session.closed()) {
        const cleanupOptions = { ...options, signal: undefined, timeoutMs: Math.min(Number(options.timeoutMs) || 15000, 1000) };
        if (handle && !closedHandle) await session.call('close', [handle], cleanupOptions).catch(() => {});
        if (owned && !recoveryRequired) await session.call('unlink', [temp], cleanupOptions).catch(() => {});
      }
      if (typeof error?.code === 'string' && error.code.startsWith('sftp_replace_')) throw remoteError(error.code, error.message, { path: absPath, recoveryPath: error.recoveryPath, applied: error.applied });
      if (uncertain) throw remoteError('write_outcome_unknown', '远端写入结果未确认，请读取当前内容后再决定是否重试', { path: absPath, cause: error.code || 'transport_error' });
      throw mapSftpError(error, absPath);
    }
    // Acknowledged rename is the commit point. Metadata lookup can fail after
    // commit; never retry the write just because the following stat failed.
    try {
      const attrs = await call(session, 'stat', [absPath], absPath, options);
      return { size: attrs.size, mtime: attrs.mtime };
    } catch (error) {
      throw remoteError('write_outcome_unknown', '写入已确认，但远端元数据暂不可读，请重新读取', { path: absPath, cause: error.code || 'metadata_unavailable' });
    }
  },

  async listDir(raw, absPath, options) {
    const session = await openSftpSession(raw, options);
    const list = await call(session, 'readdir', [absPath], absPath, options);
    return list.map((item) => ({ name: item.filename, type: typeOf(item.attrs), size: item.attrs.size, mtime: item.attrs.mtime }));
  },

  async remove(raw, absPath, options) {
    const session = await openSftpSession(raw, options);
    await call(session, 'unlink', [absPath], absPath, options);
  }
};

module.exports = { sftpFileOps };
