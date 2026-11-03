'use strict';

// Each key gets its own tmux server, so its inherited environment cannot leak
// into a different account's session. No credentials are placed in argv.
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function socketForKey(key) {
  return `aih-web-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

function run(socket, args, options = {}) {
  return spawnSync('tmux', ['-u', '-L', socket, ...args], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, ...options
  });
}

function probe(key) {
  if (process.platform === 'win32') return { state: 'missing' };
  const result = run(socketForKey(key), ['has-session', '-t', '=web']);
  if (result.status === 0) return { state: 'alive' };
  if (result.error && result.error.code === 'ENOENT') return { state: 'unavailable', missingBinary: true };
  const detail = String(result.stderr || result.error || '').trim();
  if (!result.error && result.status === 1 && /no server running|no such file or directory|can't find session/i.test(detail)) {
    return { state: 'missing' };
  }
  return { state: 'unavailable', message: detail };
}

// systemd 托管的 Server（`KillMode=control-group`）重启时会杀光自己 cgroup 里的所有进程，
// 包括这里起的 tmux server —— 于是 Server 一重启，所有 Web 终端（含远程工作区的 ssh）都没了，
// 页面上点「重连」只会得到 terminal_not_found。2026-10-31 AWS 实测确认。
// 这里让每个 tmux server 落到独立的 user scope：Server 重启只断开 attach 客户端，会话本身还在。
// launchd / 前台进程没有这个问题（本机实测重启后仍可 attach），保持原样。
function detachedLauncher(env = process.env) {
  if (process.platform !== 'linux' || !env.INVOCATION_ID) return null;
  const runtimeDir = env.XDG_RUNTIME_DIR || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '');
  if (!runtimeDir) return null;
  return { file: 'systemd-run', prefix: ['--user', '--scope', '--quiet', '--collect'], runtimeDir };
}

function create(key, { file, args, cwd, env, cols, rows }) {
  if (process.platform === 'win32') return { ok: true, durable: false };
  const socket = socketForKey(key);
  const tmuxArgs = ['-u', '-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'web', '-c', cwd,
    // The Web terminal's tmux is a transport, not the user's tmux session.
    // Clear its marker inside the pane so an aih CLI can start its own
    // independent interactive tmux session without the nesting refusal.
    '-x', String(cols), '-y', String(rows), '--', 'env', '-u', 'TMUX', file, ...args];
  const launcher = detachedLauncher();
  let result = launcher
    ? spawnSync(launcher.file, [...launcher.prefix, `--unit=aih-web-${socket.slice(8, 24)}-${Date.now().toString(36)}`, 'tmux', ...tmuxArgs], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
      env: { ...env, XDG_RUNTIME_DIR: launcher.runtimeDir }
    })
    : null;
  // systemd-run 不可用（容器里没有 user bus 等）时退回直接启动：仍可用，只是不跨 Server 重启。
  if (!result || result.error || result.status !== 0) {
    result = spawnSync('tmux', tmuxArgs, { encoding: 'utf8', timeout: 5000, windowsHide: true, env });
  }
  if (result.error && result.error.code === 'ENOENT') return { ok: true, durable: false };
  if (result.status !== 0) return { ok: false, error: 'persistent_terminal_unavailable', message: String(result.stderr || result.error || '').trim() };
  run(socket, ['set-option', '-g', 'status', 'off']);
  run(socket, ['set-option', '-g', 'escape-time', '0']);
  run(socket, ['set-option', '-gq', 'extended-keys', 'on']);
  return { ok: true, durable: true };
}

function attachCommand(key) {
  return { file: 'tmux', args: ['-u', '-L', socketForKey(key), 'attach-session', '-t', '=web'] };
}

function close(key) {
  if (!key || process.platform === 'win32') return { ok: true };
  const result = run(socketForKey(key), ['kill-session', '-t', '=web']);
  if (result.status === 0 || probe(key).state === 'missing') return { ok: true };
  return { ok: false, error: 'persistent_terminal_unavailable' };
}

module.exports = { probe, create, attachCommand, close, detachedLauncher };
