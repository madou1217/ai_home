'use strict';

// 关闭常驻 codex app-server 后，结束仍在监听其端口的残留进程。
//
// app-server 由 tmux/psmux 托管，清理时关掉会话，但会话关掉后 app-server 本身不一定退出：
//   - Windows：psmux kill-server 杀不掉 launcher pane 的孙进程（cmd→node 链）；
//   - macOS / Linux：实测 tmux 会话已不在、登记文件已删，app-server 仍活着并攥着
//     ~/.codex/thread-writer-locks 下的线程写锁，之后任何进程恢复该线程都报
//     "thread already has an active writer"。
// 因此两端都按端口找监听者并结束它。POSIX 上先核对命令行确实是 codex app-server，
// 端口若已被别的程序复用就不动。

const { spawnSync } = require('node:child_process');

function resolveSpawnSync(options) {
  if (typeof options.spawnSync === 'function') return options.spawnSync;
  if (typeof options.spawnSyncImpl === 'function') return options.spawnSyncImpl;
  return spawnSync;
}

function isValidPort(port) {
  const target = Number(port);
  return Number.isInteger(target) && target > 0 && target <= 65535;
}

function killWindowsPortOwner(port, spawnImpl) {
  let out;
  try {
    out = spawnImpl('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  } catch (_error) {
    return false;
  }
  if (!out || out.status !== 0 || !out.stdout) return false;
  const pids = new Set();
  for (const line of String(out.stdout).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    // TCP    127.0.0.1:3503    0.0.0.0:0    LISTENING    31620
    if (parts.length >= 5 && /^TCP$/i.test(parts[0])
        && parts[1].endsWith(`:${port}`) && /LISTEN/i.test(parts[3])) {
      const pid = Number(parts[4]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  let killed = false;
  for (const pid of pids) {
    try {
      const result = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      if (result && result.status === 0) killed = true;
    } catch (_error) { /* 单个失败不影响其余 */ }
  }
  return killed;
}

function killPosixAppServerPortOwner(port, spawnImpl, killImpl) {
  let out;
  try {
    out = spawnImpl('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  } catch (_error) {
    return false;
  }
  if (!out || !out.stdout) return false;
  let killed = false;
  for (const text of String(out.stdout).split(/\s+/)) {
    const pid = Number(text);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    let command = '';
    try {
      const ps = spawnImpl('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      command = String(ps && ps.stdout || '');
    } catch (_error) {
      command = '';
    }
    // 只结束监听在该端口上的 codex app-server，端口被别人复用时不误杀。
    if (!/\bapp-server\b/.test(command) || !command.includes(`127.0.0.1:${port}`)) continue;
    try {
      killImpl(pid, 'SIGTERM');
      killed = true;
    } catch (_error) { /* 进程可能已退出 */ }
  }
  return killed;
}

/**
 * @param {number} port 已关闭的 app-server 登记的端口
 * @param {{platform?: string, spawnSync?: Function, spawnSyncImpl?: Function, kill?: Function}} options
 * @returns {boolean} 是否结束了残留进程
 */
function killAppServerPortOwner(port, options = {}) {
  if (!isValidPort(port)) return false;
  const target = Number(port);
  const spawnImpl = resolveSpawnSync(options);
  if (String(options.platform || process.platform) === 'win32') {
    return killWindowsPortOwner(target, spawnImpl);
  }
  const killImpl = typeof options.kill === 'function' ? options.kill : (pid, signal) => process.kill(pid, signal);
  return killPosixAppServerPortOwner(target, spawnImpl, killImpl);
}

module.exports = { killAppServerPortOwner };
