'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { resolveAihRunPath } = require('../../../runtime/aih-storage-layout');
const { hasRunSession: defaultHasRunSession } = require('../../native-run-tmux');
const { verifyCodexAppServerBoot } = require('../verifiers/codex');
const { listJsonFiles, readJson } = require('./run-state');

function isPidAlive(processObj, pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    processObj.kill(value, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但不属于我们，同样算活着。
    return Boolean(error && error.code === 'EPERM');
  }
}

// app-server 状态文件有两种：带 pid 的直接校验进程；由多路复用器（tmux）托管的只记 socket，
// 没有 pid——按 socket 查会话是否仍在。此前后者一律当作忙，残留的旧文件就让 codex 永远
// 「在忙」，自动升级被无限推迟。win32 上 pane 会话跟踪不可信（psmux），仍保守当作忙。
function isAppServerStateAlive(state, options) {
  const processObj = options.processObj || process;
  if (state.pid != null) return isPidAlive(processObj, state.pid);
  const socket = String(state.socket || '').trim();
  const platform = String(options.platform || processObj.platform || process.platform);
  if (!socket || platform === 'win32') return true;
  const hasRunSession = options.hasRunSession || defaultHasRunSession;
  try {
    return Boolean(hasRunSession(socket, { multiplexerType: String(state.multiplexer || 'tmux') }));
  } catch (_error) {
    return true;
  }
}

// 常驻 app-server 只有 codex 有：run/codex-app-server/*.json 里仍存活的实例都算「忙」。
function collectBusyEvidence(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const dir = resolveAihRunPath(options.aiHomeDir, 'codex-app-server');
  if (!dir) return [];
  const evidence = [];
  for (const name of listJsonFiles(fsImpl, dir)) {
    const state = readJson(fsImpl, pathImpl.join(dir, name));
    if (!state) continue;
    if (isAppServerStateAlive(state, options)) {
      evidence.push(`app_server:${name.replace(/\.json$/, '')}`);
    }
  }
  return evidence;
}

module.exports = Object.freeze({
  id: 'codex',
  capability: 'provider-cli.upgrade',
  // 官方 standalone 安装器的布局（aih 的 shim exec 到这里），归 standalone 渠道。
  standaloneRoots: ({ home, localAppData, path }) => [
    home && path.join(home, '.codex', 'packages', 'standalone'),
    localAppData && path.join(localAppData, 'codex', 'packages', 'standalone')
  ],
  collectBusyEvidence,
  // 坏版本的 `--version` 照常通过，失败在 app-server 启动；强判据把它真起一次。
  strongVerifier: verifyCodexAppServerBoot
});
