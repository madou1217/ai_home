'use strict';

// WebUI 终端承载策略：浏览器与 AIH Server 不在同一台机器时，Server 弹出的原生终端窗口
// 出现在**服务器的屏幕**上（或根本没有屏幕），用户看不见也用不了。此时所有「打开终端 /
// 打开 CLI」都只能落到 WebUI 的 Web Terminal（Server 端 PTY，浏览器里显示）。
//
// 判定口径（任一成立即为「非本机」）：
//   1. 请求不是从回环地址直接打进来的（局域网、公网、cloudflared/反向代理都不算本机）；
//   2. 请求经由另一台 AIH Server 转发（带 x-aih-server-id，WebUI 选了远端 Server）；
//   3. Server 没有桌面会话（headless Linux），原生窗口无处可开。
// 只有「本机浏览器 → 本机 Server，且 Server 有桌面」才允许打开原生终端窗口。

const { isLoopbackPeer } = require('./management-key-auth');
const { isDesktopHost } = require('../runtime/host-capabilities');

const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded', 'x-aih-server-id'];

function hasProxyHop(req) {
  const headers = (req && req.headers) || {};
  return PROXY_HEADERS.some((name) => String(headers[name] || '').trim() !== '');
}

/** 浏览器是否与 Server 在同一台机器上（回环直连且没有经过任何代理/中转）。 */
function isSameMachineRequest(req) {
  return isLoopbackPeer(req) && !hasProxyHop(req);
}

/**
 * 返回本次请求应使用的 CLI/终端承载方式：'native'（本机窗口）或 'webui'（Web Terminal）。
 * 客户端传来的 `transport` 只能把本机请求降级到 webui，不能把远端请求升级为 native。
 */
function resolveTerminalTransport({ req, requested, processObj = process, env } = {}) {
  const hostEnv = env || (processObj && processObj.env) || {};
  const desktop = isDesktopHost({ platform: processObj && processObj.platform, env: hostEnv });
  if (!desktop || !isSameMachineRequest(req)) return 'webui';
  return String(requested || '').trim().toLowerCase() === 'webui' ? 'webui' : 'native';
}

/**
 * 客户端没带 sessionKey 时（老前端、Toolkit 入口），Server 自己生成一个：
 * 每次打开都是新的 PTY，和 WebUI 账号页「每次点击新开一个页签」的语义一致。
 */
function defaultWebTerminalSessionKey({ accountRef = '', harness = '', model = '', workdir = '', randomBytes } = {}) {
  const nonce = (randomBytes || require('node:crypto').randomBytes)(8).toString('hex');
  const raw = [nonce, accountRef, harness, model, workdir].map((value) => String(value || '').trim()).join('|');
  return `account-cli:${encodeURIComponent(raw).slice(0, 150)}`;
}

module.exports = {
  defaultWebTerminalSessionKey,
  isSameMachineRequest,
  resolveTerminalTransport
};
