'use strict';

// 远程工作区统一错误类型。每个错误带稳定的 code 与 retryable 语义，上层只看这两个字段，
// 不解析 message（message 可能含远端输出，绝不当作控制信号）。
//
// retryable 的含义是「连接层的瞬时失败，换条健康连接重试可能成功」；
// 业务性失败（文件不存在、权限、版本冲突）一律不可重试。

const RETRYABLE = new Set([
  'connection_lost',
  'connection_timeout',
  'probe_timeout',
  'channel_open_failed',
  'remote_unavailable'
]);

class RemoteWorkspaceError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'RemoteWorkspaceError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (details !== undefined) this.details = details;
  }
}

function remoteError(code, message, details) {
  return new RemoteWorkspaceError(code, message, details);
}

function isRetryable(error) {
  return Boolean(error && error.retryable === true);
}

/** 把 ssh2 / socket 层的原始错误归一成我们的错误码（不泄露原始 message 里的主机细节以外的内容）。 */
function fromTransportError(error) {
  if (error instanceof RemoteWorkspaceError) return error;
  const code = String(error && (error.code || error.level) || '');
  if (code === 'client-authentication' || /authentication/i.test(String(error && error.message))) {
    return remoteError('auth_failed', 'SSH 认证失败');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return remoteError('host_unresolved', '无法解析远端主机');
  if (code === 'ECONNREFUSED') return remoteError('connection_refused', '远端拒绝连接');
  if (code === 'ETIMEDOUT' || /timed out/i.test(String(error && error.message))) return remoteError('connection_timeout', '连接远端超时');
  if (code === 'host_key_mismatch') return error;
  return remoteError('connection_lost', '与远端的连接中断', { cause: code || 'unknown' });
}

module.exports = {
  RemoteWorkspaceError,
  fromTransportError,
  isRetryable,
  remoteError
};
