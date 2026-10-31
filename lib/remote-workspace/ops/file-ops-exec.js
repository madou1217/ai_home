'use strict';

// 文件操作 · 命令策略：用远端自带命令完成文件读写（POSIX sh / PowerShell，由 dialect 构造）。
// 内容一律 base64 传输，编码 / 换行 / 二进制都原样保留。
//
// 命令怎么送到远端由调用方注入的 run(command, options) 决定（Strategy 组合）：
//   - POSIX：常驻命令会话，一次操作一个往返；
//   - Windows：一次性 exec 通道（PowerShell 冷启动本身就慢，会话收益不大，且避免解析交互式提示符）。
// 每个方法的第一个参数都是 run。

const { remoteError } = require('../errors');

function failFromExec(result, absPath) {
  const stderr = result.stderr.toString('utf8');
  if (result.code === 3 || /NOENT/.test(stderr)) return remoteError('not_found', `远端不存在：${absPath}`);
  if (/permission denied|access.*denied/i.test(stderr)) return remoteError('permission_denied', `没有权限：${absPath}`);
  return remoteError('remote_io_error', `远端读写失败：${absPath}`, { exitCode: result.code });
}

function parseSizeMtime(line) {
  const [size, mtime] = String(line || '').trim().split(/\s+/).map(Number);
  return { size: Number.isFinite(size) ? size : 0, mtime: Number.isFinite(mtime) ? mtime : 0 };
}

// GNU stat %F / BSD stat %HT 的类型名 → d / f / l。
function normalizeType(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'd' || text === 'directory') return 'd';
  if (text === 'l' || text.includes('symbolic')) return 'l';
  return 'f';
}

function createExecFileOps(dialect) {
  return {
    id: `exec-${dialect.id}`,

    async stat(run, absPath, options) {
      const result = await run(dialect.stat(absPath), options);
      if (result.code !== 0) throw failFromExec(result, absPath);
      const [type, size, mtime] = result.stdout.toString('utf8').trim().split(/\s+/);
      return { type, size: Number(size) || 0, mtime: Number(mtime) || 0 };
    },

    async readFile(run, absPath, options) {
      const result = await run(dialect.readFile(absPath), {
        ...options, maxOutputBytes: Math.ceil(options.maxBytes * 4 / 3) + 256
      });
      if (result.code !== 0) throw failFromExec(result, absPath);
      if (result.truncated) throw remoteError('file_too_large', '文件过大');
      const text = result.stdout.toString('utf8');
      const newline = text.indexOf('\n');
      const meta = parseSizeMtime(text.slice(0, newline));
      const content = Buffer.from(text.slice(newline + 1).trim(), 'base64');
      if (content.length > options.maxBytes) throw remoteError('file_too_large', `文件过大（${content.length} 字节）`, { size: content.length });
      return { content, ...meta };
    },

    async writeFile(run, absPath, content, options) {
      const result = await run(dialect.writeFile(absPath), {
        ...options, stdin: Buffer.from(content).toString('base64')
      });
      if (result.code !== 0) throw failFromExec(result, absPath);
      return parseSizeMtime(result.stdout.toString('utf8'));
    },

    async listDir(run, absPath, options) {
      const result = await run(dialect.listDir(absPath), options);
      if (result.code !== 0) throw failFromExec(result, absPath);
      return result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => {
        const [type, size, mtime, ...name] = line.split('\t');
        return { name: name.join('\t'), type: normalizeType(type), size: Number(size) || 0, mtime: Number(mtime) || 0 };
      }).filter((entry) => entry.name && entry.name !== '.' && entry.name !== '..');
    },

    async remove(run, absPath, options) {
      const result = await run(dialect.remove(absPath), options);
      if (result.code !== 0) throw failFromExec(result, absPath);
    }
  };
}

module.exports = { createExecFileOps };
