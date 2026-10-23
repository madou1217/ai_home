'use strict';

// 会话键送达：把「这是哪个 CLI 会话」这件事从 CLI 进程送到本地网关。
//
// 网关模式的终端标题要回答「当前路由到了哪个账号」，而选号只发生在服务端。两侧靠
// **会话键**关联（见 lib/runtime/route-observation.js）。网关从请求头读它
// （lib/server/session-key.js 的候选表认 `x-session-id`）。
//
// 送达通道各家不同，因此**声明在 relay profile 上**，这里只做统一执行：
//
//   kind: 'env-header'    换行分隔的自定义头 env（claude 的 ANTHROPIC_CUSTOM_HEADERS、
//                         kimi 的 KIMI_CODE_CUSTOM_HEADERS）
//   kind: 'env-value'     单个 env 变量承载（codex 的 AIH_CODEX_GATEWAY_SESSION_KEY，
//                         由 codex-provider-args 翻译成 `-c http_headers.X-Session-Id=`，
//                         与账号钉选头走完全相同的路径）
//
// 没声明 `sessionKeyTransport` 的 provider 不送达（例如 opencode 走 OPENCODE_CONFIG
// overlay，没有可追加头的 env 通道）——此时标题少一帧路由，不是失败。

const { extractRequestSessionKey } = require('../../../../server/session-key');

// 网关认的会话头名（与 lib/server/session-key.js 的候选表同源）。
const SESSION_HEADER_NAME = 'x-session-id';

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

// 送达会话键。返回**新的** env 对象（不改入参——调用方可能还要用原值）。
function applySessionKeyTransport(profile, gatewayEnv, sessionKey) {
  const env = { ...(gatewayEnv || {}) };
  const key = normalizeText(sessionKey);
  const transport = profile && profile.sessionKeyTransport;
  if (!key || !transport || typeof transport !== 'object') return env;

  const envKey = normalizeText(transport.envKey);
  if (!envKey) return env;

  if (transport.kind === 'env-value') {
    env[envKey] = key;
    return env;
  }

  if (transport.kind === 'env-header') {
    const headerName = normalizeText(transport.headerName) || SESSION_HEADER_NAME;
    const existing = normalizeText(env[envKey]);
    env[envKey] = [existing, `${headerName}: ${key}`].filter(Boolean).join('\n');
    return env;
  }

  return env;
}

// 网关请求里的会话键提取：诊断与测试用（服务端走 session-key.js 的候选表）。
function readSessionKeyFromHeaders(headers) {
  return extractRequestSessionKey(headers || {}, null);
}

module.exports = {
  SESSION_HEADER_NAME,
  applySessionKeyTransport,
  readSessionKeyFromHeaders
};
