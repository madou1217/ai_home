'use strict';

// 把 Server 里保存的 SSH 连接配置（ssh_connections）解析成 ssh2 能用的连接目标。
//
// 认证材料只在内存里交给 ssh2：粘贴的私钥直接以 Buffer 传入、私钥文件按 ssh-identity-file
// 的安全规则读取（必须在 ~/.ssh 下且权限不宽于 0600）、密码以 password 字段传入、agent 用
// SSH_AUTH_SOCK。与 B5 的 CLI 守护不同，这条通道**不写任何临时文件**。

const { KEY_FILE_AUTH_TYPE, resolveIdentityFilePath } = require('../../server/ssh-identity-file');
const { missingAuthError } = require('./ssh-connector');

function resolveTarget(connection, { fs, homeDir, env = process.env } = {}) {
  if (!connection || !String(connection.host || '').trim()) {
    throw missingAuthError('连接没有主机地址');
  }
  const authType = String(connection.authType || 'agent').trim();
  let auth;
  if (authType === 'key') {
    if (!connection.privateKey) throw missingAuthError('私钥为空');
    auth = { privateKey: Buffer.from(String(connection.privateKey)) };
  } else if (authType === KEY_FILE_AUTH_TYPE) {
    const file = resolveIdentityFilePath(connection.identityFile, { fs, homeDir });
    auth = { privateKey: fs.readFileSync(file) };
  } else if (authType === 'password') {
    if (!connection.password) throw missingAuthError('密码为空');
    auth = { password: String(connection.password) };
  } else {
    if (!env.SSH_AUTH_SOCK) throw missingAuthError('Server 进程没有 SSH agent（SSH_AUTH_SOCK）');
    auth = { agent: env.SSH_AUTH_SOCK };
  }
  return {
    id: String(connection.id || ''),
    host: String(connection.host).trim(),
    port: Number(connection.port) || 22,
    username: String(connection.user || '').trim() || undefined,
    auth
  };
}

module.exports = { resolveTarget };
