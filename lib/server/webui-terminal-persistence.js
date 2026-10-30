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

function exists(key) {
  return process.platform !== 'win32' && run(socketForKey(key), ['has-session', '-t', '=web']).status === 0;
}

function create(key, { file, args, cwd, env, cols, rows }) {
  if (process.platform === 'win32') return { ok: true, durable: false };
  const socket = socketForKey(key);
  const result = run(socket, ['-f', '/dev/null', 'new-session', '-d', '-s', 'web', '-c', cwd,
    '-x', String(cols), '-y', String(rows), '--', file, ...args], { env });
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
  if (key && process.platform !== 'win32') run(socketForKey(key), ['kill-session', '-t', '=web']);
}

module.exports = { exists, create, attachCommand, close };
