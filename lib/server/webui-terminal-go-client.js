'use strict';

const GO_PREFIX = '/v1/management/webui/terminal';

function envPairs(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [];
  return Object.entries(env)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);
}

// 进程内启动器入口：账号 CLI / 远程工作区 / SSH 守护用同一个 Go 会话服务。
//
// 与浏览器 /open 的边界：这里允许 file/args/env，但只存在于 Node 进程内调用，
// 永远不经过 /v0/webui/terminal/* 的代理（见 handleTerminalOpen 的字段收口）。
async function openWebUiTerminalSession(input = {}, goHost = null) {
  if (!goHost || typeof goHost.terminalRequest !== 'function') {
    return { ok: false, error: 'web_terminal_unavailable', message: 'Go Core 未就绪' };
  }
  const body = {
    sessionKey: input.sessionKey,
    cwd: input.cwd,
    file: input.file,
    args: Array.isArray(input.args) ? input.args.map((item) => String(item)) : [],
    env: envPairs(input.env),
    cols: input.cols,
    rows: input.rows,
    muxId: input.muxId,
    persistent: input.persistent === true,
    // SSH 工作区：Go 直接建 SSH PTY；凭据只走管理密钥链路。
    ssh: input.ssh || undefined
  };
  let result = null;
  try {
    result = await goHost.terminalRequest({ method: 'POST', path: GO_PREFIX + '/launch', body });
  } catch (error) {
    return { ok: false, error: 'web_terminal_unavailable', message: String((error && error.message) || error) };
  }
  if (!result || !result.body || typeof result.body !== 'object') {
    return { ok: false, error: 'web_terminal_unavailable' };
  }
  return result.body;
}

module.exports = {
  openWebUiTerminalSession
};
