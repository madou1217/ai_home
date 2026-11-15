'use strict';

const { spawnSync: defaultSpawnSync } = require('node:child_process');

const REMOTE_AUTH_TOKEN_ENV = 'AIH_CODEX_LOCAL_REMOTE_TOKEN';
// 传给 app-server 的配置：`codex app-server` 只接受 -c/--config、--enable、--disable，
// 传 -m 会直接报 unexpected argument 并退出（TUI 随即报 "closed during initialize"）。
// 模型改写成等价的配置项；其余参数只给 TUI。profile 既不能写成配置项（codex 已拒绝
// `profile = "x"`）也没有 app-server 参数，带 -p/--profile 的启动不走本地 app-server（usesProfile）。
const PASS_THROUGH_FLAGS = new Set(['-c', '--config', '--enable', '--disable']);
const CONFIG_KEY_FLAGS = new Map([['-m', 'model'], ['--model', 'model']]);
const PROFILE_FLAGS = new Set(['-p', '--profile']);

function usesProfile(args) {
  const list = Array.isArray(args) ? args : [];
  for (const value of list) {
    const token = String(value || '');
    if (token === '--') return false;
    if (PROFILE_FLAGS.has(token) || token.startsWith('--profile=')) return true;
  }
  return false;
}

function extractAppServerConfigArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] || '');
    if (token === '--') break;
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = eq > 0 ? token.slice(0, eq) : token;
    let value;
    if (eq > 0) {
      value = token.slice(eq + 1);
    } else if ((PASS_THROUGH_FLAGS.has(flag) || CONFIG_KEY_FLAGS.has(flag)) && index + 1 < list.length) {
      value = String(list[index + 1]);
      index += 1;
    } else {
      continue;
    }
    if (PASS_THROUGH_FLAGS.has(flag)) out.push(flag, value);
    else if (CONFIG_KEY_FLAGS.has(flag)) out.push('-c', `${CONFIG_KEY_FLAGS.get(flag)}=${JSON.stringify(value)}`);
  }
  return out;
}

function terminateChild(child, options = {}) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
  const platform = options.platform || process.platform;
  const processObj = options.processObj || process;
  const pid = Number(child.pid);
  const hasPid = Number.isInteger(pid) && pid > 0;
  if (platform === 'win32' && hasPid) {
    try {
      (options.spawnSync || defaultSpawnSync)('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      return;
    } catch (_error) {}
  }
  // POSIX children are launched in their own group so provider helpers cannot
  // survive an app-server disconnect.
  const target = platform !== 'win32' && options.processGroup === true && hasPid ? -pid : pid;
  try {
    if (target && typeof processObj.kill === 'function') processObj.kill(target, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch (_error) {
    try { child.kill('SIGTERM'); } catch (_ignored) {}
  }
  const forceKill = setTimeout(() => {
    if (child.exitCode !== null && child.exitCode !== undefined) return;
    try {
      if (target && typeof processObj.kill === 'function') processObj.kill(target, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (_error) {
      try { child.kill('SIGKILL'); } catch (_ignored) {}
    }
  }, Number(options.killGraceMs) >= 0 ? Number(options.killGraceMs) : 500);
  if (forceKill && typeof forceKill.unref === 'function') forceKill.unref();
}


module.exports = { REMOTE_AUTH_TOKEN_ENV, extractAppServerConfigArgs, terminateChild, usesProfile };
