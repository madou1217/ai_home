'use strict';

// 远程工作区终端：把「SSH 开发机」上的某个目录开成一个 Web Terminal。
//
// 形态：Server 自己用已保存的 SSH 连接（agent / 私钥 / 私钥文件 / 密码）跑
// `ssh -tt <dest> 'cd <root> && exec $SHELL -l'`，这个 ssh 进程放在 Server 端的持久 PTY 里
// （tmux 托管）。所以：
//   - 浏览器刷新 / 断网重连 / 关掉页面再回来：attach 回同一个 PTY，远端 shell 不断；
//   - 凭据只在 Server 侧，从不下发到浏览器；
//   - 远端机器不需要装 aih、node 或任何 AI CLI。
//
// 凭据文件的生命周期：
//   - 私钥（key）：写到 aiHomeDir/run/ssh-remote/<sessionKey>.key（0600），会话结束时删除；
//   - 密码（password）：写 askpass 脚本（0700），同上；
//   - agent / key-file：不落任何临时文件。

const crypto = require('node:crypto');
const path = require('node:path');
const { KEY_FILE_AUTH_TYPE, resolveIdentityFilePath } = require('./ssh-identity-file');

const SAFE_KEY = /[^A-Za-z0-9._-]/g;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function remoteSessionKey(workspaceId, suffix = '') {
  const base = `remote-ws:${String(workspaceId || '').trim()}`;
  return suffix ? `${base}:${suffix}` : base;
}

function credentialDir(aiHomeDir, pathImpl = path) {
  return pathImpl.join(aiHomeDir, 'run', 'ssh-remote');
}

/**
 * 构造 ssh 命令与临时凭据文件。返回 { file, args, env, tempFiles }。
 * 远端命令：进入工作区根目录后 exec 登录 shell（目录不存在时给出明确提示后仍进入 $HOME）。
 */
function buildRemoteShellCommand({ connection, remoteRoot, sessionKey, aiHomeDir, fs, homeDir, pathImpl = path }) {
  if (!connection || !String(connection.host || '').trim()) {
    const error = new Error('ssh_connection_invalid');
    error.code = 'ssh_connection_invalid';
    throw error;
  }
  const args = [
    '-tt',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    // 断线判定：30s 一次心跳，连续 4 次无响应才断（长时间空闲不掉线）。
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=4'
  ];
  const env = {};
  const tempFiles = [];
  const authType = String(connection.authType || 'agent').trim();
  const safeName = String(sessionKey || crypto.randomBytes(6).toString('hex')).replace(SAFE_KEY, '_').slice(0, 120);
  const dir = credentialDir(aiHomeDir, pathImpl);

  if (authType === 'key' && connection.privateKey) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyFile = pathImpl.join(dir, `${safeName}.key`);
    const body = String(connection.privateKey).endsWith('\n') ? String(connection.privateKey) : `${connection.privateKey}\n`;
    fs.writeFileSync(keyFile, body, { mode: 0o600 });
    tempFiles.push(keyFile);
    args.push('-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes');
  } else if (authType === KEY_FILE_AUTH_TYPE) {
    const identityFile = resolveIdentityFilePath(connection.identityFile, { fs, homeDir });
    args.push('-i', identityFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes');
  } else if (authType === 'password' && connection.password) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const askPass = pathImpl.join(dir, `${safeName}.askpass`);
    // 密码通过 env 传给 askpass，不进脚本内容、不进命令行参数。
    fs.writeFileSync(askPass, '#!/bin/sh\nprintf "%s\\n" "$AIH_SSH_PASSWORD"\n', { mode: 0o700 });
    tempFiles.push(askPass);
    env.AIH_SSH_PASSWORD = String(connection.password);
    env.SSH_ASKPASS = askPass;
    env.SSH_ASKPASS_REQUIRE = 'force';
    env.DISPLAY = env.DISPLAY || ':0';
    args.push('-o', 'NumberOfPasswordPrompts=1');
  } else {
    // agent：交给 Server 进程的 SSH_AUTH_SOCK；失败时 ssh 会在终端里提示。
    args.push('-o', 'BatchMode=yes');
  }
  if (connection.port) args.push('-p', String(Number(connection.port) || 22));
  const dest = connection.user ? `${connection.user}@${connection.host}` : String(connection.host);
  args.push(dest, buildRemoteCommand(remoteRoot, sessionKey));
  return { file: 'ssh', args, env, tempFiles };
}

/**
 * 远端命令：进入工作区根目录；远端有 tmux 时进入（或接回）同名 tmux 会话，这样 Server ↔ 远端
 * 的 SSH 断了也只是客户端断开，重新打开就接回原来的 shell 和正在跑的进程；没有 tmux 就直接开登录 shell。
 */
function buildRemoteCommand(remoteRoot, sessionKey) {
  const root = String(remoteRoot || '').trim();
  const name = `aih-${String(sessionKey || 'ws').replace(/[^A-Za-z0-9_-]/g, '-')}`.slice(0, 60);
  const enter = root
    ? `cd ${shellQuote(root)} 2>/dev/null || echo ${shellQuote(`[aih] 远程目录不存在：${root}，已进入 $HOME`)}; `
    : '';
  return `${enter}if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ${shellQuote(name)}; fi; exec "\${SHELL:-/bin/sh}" -l`;
}

function removeCredentialFiles(files, fs) {
  for (const file of files || []) {
    try {
      // 覆写后删除：私钥/askpass 不留在磁盘上。
      const size = fs.statSync(file).size;
      fs.writeFileSync(file, Buffer.alloc(size));
      fs.unlinkSync(file);
    } catch (_error) {
      // 已被删除或不可写：忽略。
    }
  }
}

module.exports = {
  buildRemoteCommand,
  buildRemoteShellCommand,
  credentialDir,
  remoteSessionKey,
  removeCredentialFiles,
  shellQuote
};
