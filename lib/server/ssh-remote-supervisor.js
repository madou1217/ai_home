'use strict';

// 远程工作区的 SSH 守护（B5：断线自动重连）。
//
// 它跑在 Web 终端的持久 PTY 里（tmux 托管），代替直接 exec ssh：
//   - ssh 正常退出（用户在远端 exit / 远端 tmux 会话结束）→ 守护也退出，终端页签显示已结束；
//   - ssh 异常断开（网络抖动、远端重启、超时，退出码 255 或被信号打断）→ 退避后自动重连，
//     远端有 tmux 时重连进入同名会话，shell 与正在跑的进程原样接回；
//   - 每次重连都按工作区 ID 重新读取 Server 里保存的连接配置，凭据只在建连那一刻落临时文件，
//     连上后立即擦除；改了连接配置（换密钥、改端口）下一次重连即生效。
//
// 不读命令行里的任何凭据：参数只有 aiHomeDir 与工作区 ID。

const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { readJsonValue } = require('./app-state-store');
const { buildRemoteShellCommand, remoteSessionKey, removeCredentialFiles } = require('./ssh-remote-shell');

const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const STABLE_AFTER_MS = 60000;
const CREDENTIAL_WIPE_MS = 10000;

/**
 * 判定 ssh 退出后是否应该重连。
 * 255 = ssh 自身失败（连不上、断线、超时）；被信号杀掉也算断线。
 * 0 / 其他码 = 远端 shell 正常结束（用户 exit 或远端命令的退出码），不重连。
 */
function shouldReconnect(code, signal) {
  if (signal && signal !== 'SIGINT') return true;
  return code === 255;
}

function backoffDelay(attempt) {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

function loadWorkspace(aiHomeDir, workspaceId, fsImpl = fs) {
  const workspaces = readJsonValue(fsImpl, aiHomeDir, 'ssh_workspaces');
  const workspace = Array.isArray(workspaces) ? workspaces.find((item) => item && item.id === workspaceId) : null;
  if (!workspace) return { error: 'workspace_not_found' };
  const connections = readJsonValue(fsImpl, aiHomeDir, 'ssh_connections');
  const connection = Array.isArray(connections) ? connections.find((item) => item && item.id === workspace.connectionId) : null;
  if (!connection) return { error: 'connection_not_found' };
  return { workspace, connection };
}

function write(stream, text) {
  try { stream.write(text); } catch (_error) { /* 终端已关闭 */ }
}

/**
 * @param {{aiHomeDir, workspaceId, sessionKey, stdout?, spawnImpl?, setTimer?, homeDir?, fsImpl?}} options
 * @returns {Promise<number>} 退出码
 */
function runRemoteSupervisor(options) {
  const {
    aiHomeDir,
    workspaceId,
    sessionKey = remoteSessionKey(workspaceId),
    stdout = process.stdout,
    spawnImpl = spawn,
    setTimer = setTimeout,
    homeDir = os.homedir(),
    fsImpl = fs
  } = options;
  let attempt = 0;
  let stopping = false;
  let child = null;

  const onSignal = (signal) => {
    stopping = true;
    if (child) {
      try { child.kill(signal); } catch (_error) { /* already gone */ }
    }
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGHUP', () => onSignal('SIGHUP'));

  return new Promise((resolve) => {
    const connect = () => {
      if (stopping) return resolve(0);
      const loaded = loadWorkspace(aiHomeDir, workspaceId, fsImpl);
      if (loaded.error) {
        write(stdout, `\r\n[aih] 远程工作区不可用：${loaded.error === 'workspace_not_found' ? '工作区已删除' : 'SSH 连接已删除'}\r\n`);
        return resolve(1);
      }
      let command;
      try {
        command = buildRemoteShellCommand({
          connection: loaded.connection,
          remoteRoot: loaded.workspace.remoteRoot,
          sessionKey,
          aiHomeDir,
          fs: fsImpl,
          homeDir
        });
      } catch (error) {
        write(stdout, `\r\n[aih] SSH 连接配置无效：${error.code || error.message}\r\n`);
        return resolve(1);
      }
      const startedAt = Date.now();
      child = spawnImpl(command.file, command.args, {
        stdio: 'inherit',
        env: { ...process.env, ...command.env }
      });
      // ssh 在建连阶段读完私钥 / askpass；之后擦掉，凭据不在磁盘上常驻。
      const wipe = setTimer(() => removeCredentialFiles(command.tempFiles, fsImpl), CREDENTIAL_WIPE_MS);
      if (wipe && typeof wipe.unref === 'function') wipe.unref();
      child.on('error', (error) => {
        removeCredentialFiles(command.tempFiles, fsImpl);
        write(stdout, `\r\n[aih] 无法启动 ssh：${error.message}\r\n`);
        resolve(1);
      });
      child.on('exit', (code, signal) => {
        child = null;
        removeCredentialFiles(command.tempFiles, fsImpl);
        if (stopping) return resolve(0);
        if (!shouldReconnect(code, signal)) return resolve(Number.isInteger(code) ? code : 0);
        // 连上后稳定运行过一段时间，说明是一次新的断线：退避从头算。
        if (Date.now() - startedAt >= STABLE_AFTER_MS) attempt = 0;
        const delay = backoffDelay(attempt);
        attempt += 1;
        write(stdout, `\r\n\x1b[33m[aih] 与 ${loaded.connection.host} 的连接已断开，${Math.round(delay / 1000)} 秒后自动重连（第 ${attempt} 次）…\x1b[0m\r\n`);
        const timer = setTimer(connect, delay);
        if (timer && typeof timer.ref === 'function') timer.ref();
      });
    };
    connect();
  });
}

module.exports = {
  BACKOFF_MS,
  backoffDelay,
  loadWorkspace,
  runRemoteSupervisor,
  shouldReconnect
};
