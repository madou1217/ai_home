'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 单文件 launch context：父进程把「本次启动的上下文」写进 0600 JSON，
// 子进程只收一个环境变量 `AIH_LAUNCH_CONTEXT=<file>`。
//
// 为什么不用一堆 AIH_* 环境变量：
//   - 环境变量会进 `ps`（含审批端点、会话身份等），文件可以 0600；
//   - 每加一个上下文字段就要加一个环境变量名，最终变成上百个。
// 新代码请用 `writeLaunchContext` / `launchContextValue`，不要再新增 `AIH_*` 字段名。
const LAUNCH_CONTEXT_ENV = 'AIH_LAUNCH_CONTEXT';

function writeLaunchContext(fields, options = {}) {
  const root = String(options.root || '').trim();
  if (!root) throw new Error('launch_context_root_required');
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const name = String(options.name || '').trim()
    || `ctx-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const dir = pathImpl.join(root, 'run', 'launch-context');
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = pathImpl.join(dir, `${name}.json`);
  fsImpl.writeFileSync(file, JSON.stringify(fields || {}), { mode: 0o600 });
  try {
    fsImpl.chmodSync(file, 0o600);
  } catch (_error) {
    // Windows 上 chmod 是 no-op；不要因此让审批桥起不来。
  }
  return file;
}

const contextCache = new Map();

function readLaunchContext(env = process.env, options = {}) {
  const file = String((env && env[LAUNCH_CONTEXT_ENV]) || '').trim();
  if (!file) return {};
  const fsImpl = options.fs || fs;
  try {
    const stat = fsImpl.statSync(file);
    const cacheKey = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (contextCache.has(cacheKey)) return contextCache.get(cacheKey);
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    contextCache.set(cacheKey, value);
    return value;
  } catch (_error) {
    return {};
  }
}

function launchContextValue(env, key, fallback = '') {
  const value = readLaunchContext(env)[key];
  return value === undefined || value === null ? fallback : value;
}

function removeLaunchContext(file, options = {}) {
  const target = String(file || '').trim();
  if (!target) return false;
  const fsImpl = options.fs || fs;
  try {
    fsImpl.unlinkSync(target);
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  LAUNCH_CONTEXT_ENV,
  writeLaunchContext,
  readLaunchContext,
  launchContextValue,
  removeLaunchContext
};
