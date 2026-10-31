'use strict';

// 文件操作 · SFTP 策略：二进制协议，不解析 shell 输出，Linux/macOS/Windows OpenSSH 都自带。
//
// 每条连接只开一个 SFTP 会话并缓存复用（SFTP 本身就是多路复用的子系统，开一次省一个往返）；
// 会话出错就丢弃，下次重开。写入：先写同目录临时文件，再 rename 覆盖（远端不会出现半截文件）。
// 与 file-ops-exec 实现同一接口（见 file-ops.js）。

const { withDeadline } = require('../channel/deadline');
const { remoteError } = require('../errors');

const sessions = new WeakMap(); // raw connection → Promise<sftp>

function sftpFor(raw, options) {
  let pending = sessions.get(raw);
  if (!pending) {
    pending = withDeadline(({ resolve, reject }) => {
      raw.sftp((error, sftp) => {
        if (error) return reject(remoteError('sftp_unavailable', '远端没有可用的 SFTP 子系统', { cause: String(error.message || error) }));
        sftp.once('close', () => sessions.delete(raw));
        sftp.on('error', () => sessions.delete(raw));
        resolve(sftp);
      });
    }, { ...options, label: 'sftp open' });
    pending.catch(() => sessions.delete(raw));
    sessions.set(raw, pending);
  }
  return pending;
}

function mapSftpError(error, path) {
  const code = error && error.code;
  if (code === 2) return remoteError('not_found', `远端不存在：${path}`);
  if (code === 3) return remoteError('permission_denied', `没有权限：${path}`);
  return remoteError('remote_io_error', `远端读写失败：${path}`, { cause: String(error && error.message || error) });
}

function call(sftp, method, args, path, options) {
  return withDeadline(({ resolve, reject }) => {
    sftp[method](...args, (error, value) => (error ? reject(mapSftpError(error, path)) : resolve(value)));
  }, options);
}

function typeOf(attrs) {
  if (attrs.isSymbolicLink && attrs.isSymbolicLink()) return 'l';
  if (attrs.isDirectory && attrs.isDirectory()) return 'd';
  return 'f';
}

const sftpFileOps = {
  id: 'sftp',

  async stat(raw, absPath, options) {
    const sftp = await sftpFor(raw, options);
    const attrs = await call(sftp, 'stat', [absPath], absPath, options);
    return { type: typeOf(attrs), size: attrs.size, mtime: attrs.mtime };
  },

  async readFile(raw, absPath, options) {
    const sftp = await sftpFor(raw, options);
    const attrs = await call(sftp, 'stat', [absPath], absPath, options);
    if (attrs.isDirectory && attrs.isDirectory()) throw remoteError('is_directory', `是目录：${absPath}`);
    if (attrs.size > options.maxBytes) throw remoteError('file_too_large', `文件过大（${attrs.size} 字节）`, { size: attrs.size });
    const content = await withDeadline(({ resolve, reject }) => {
      sftp.readFile(absPath, (error, data) => (error ? reject(mapSftpError(error, absPath)) : resolve(data)));
    }, options);
    return { content, size: attrs.size, mtime: attrs.mtime };
  },

  async writeFile(raw, absPath, content, options) {
    const sftp = await sftpFor(raw, options);
    const slash = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
    const dir = slash > 0 ? absPath.slice(0, slash) : '.';
    const temp = `${dir}${absPath.includes('\\') && !absPath.includes('/') ? '\\' : '/'}.aih-write.${process.pid}.${Date.now()}`;
    await withDeadline(({ resolve, reject }) => {
      sftp.writeFile(temp, content, (error) => (error ? reject(mapSftpError(error, absPath)) : resolve()));
    }, options);
    try {
      // POSIX rename 覆盖目标是原子的；不支持覆盖的服务器（部分 Windows）先删再改名。
      await call(sftp, 'rename', [temp, absPath], absPath, options).catch(async (error) => {
        if (error.code !== 'remote_io_error') throw error;
        await call(sftp, 'unlink', [absPath], absPath, options).catch(() => {});
        await call(sftp, 'rename', [temp, absPath], absPath, options);
      });
    } catch (error) {
      await call(sftp, 'unlink', [temp], temp, options).catch(() => {});
      throw error;
    }
    const attrs = await call(sftp, 'stat', [absPath], absPath, options);
    return { size: attrs.size, mtime: attrs.mtime };
  },

  async listDir(raw, absPath, options) {
    const sftp = await sftpFor(raw, options);
    const list = await call(sftp, 'readdir', [absPath], absPath, options);
    return list.map((item) => ({
      name: item.filename,
      type: typeOf(item.attrs),
      size: item.attrs.size,
      mtime: item.attrs.mtime
    }));
  },

  async remove(raw, absPath, options) {
    const sftp = await sftpFor(raw, options);
    await call(sftp, 'unlink', [absPath], absPath, options);
  }
};

module.exports = { sftpFileOps };
