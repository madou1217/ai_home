'use strict';

// 工作区路径约束：所有文件操作的相对路径都必须落在工作区根目录之内。
// 拒绝 `..` 逃逸、绝对路径、空字节；POSIX 与 Windows（盘符、反斜杠）都按各自规则归一。

const { remoteError } = require('../errors');

function normalizeRelative(relPath, dialectId) {
  const raw = String(relPath == null ? '' : relPath);
  if (raw.includes('\0')) throw remoteError('invalid_path', '路径含非法字符');
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    throw remoteError('invalid_path', '只能使用工作区内的相对路径');
  }
  const parts = [];
  for (const part of unified.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw remoteError('path_outside_workspace', '路径超出工作区');
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join(dialectId === 'powershell' ? '\\' : '/');
}

function resolveInside(root, relPath, dialect) {
  const rel = normalizeRelative(relPath, dialect.id);
  return { rel: rel.replace(/\\/g, '/'), abs: dialect.joinPath(root, rel) };
}

module.exports = { normalizeRelative, resolveInside };
