'use strict';

const { authorizeManagementKey, isLoopbackPeer } = require('./management-key-auth');

// WebUI 数据面鉴权门：/v0/webui/*。
// - 同机 loopback 连接（127.0.0.1 / ::1 的真实 TCP 对端）自动信任：你在自己电脑上访问自己的 server
//   不该被自己挡；且能避免“本机尚未配置 Management Key → 无法读取 profile”的死锁。
// - 局域网 / 公网连接（非 loopback 对端）必须携带 Management Key，未授权 401。
// 凭据只接受 Authorization: Bearer。浏览器实时流使用 fetch stream，因此完整
// Management Key 不进入 URL、代理日志或 DOM 资源地址。

function extractWebUiCredential(req) {
  const header = String((req && req.headers && req.headers.authorization) || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match && match[1]) return match[1].trim();
  return '';
}

function authorizeWebUiRequest({ req, requiredManagementKey = '' } = {}) {
  // 同机 loopback：自动信任（远程/局域网不受影响）。
  if (isLoopbackPeer(req)) {
    return { ok: true, via: 'loopback' };
  }
  const credential = extractWebUiCredential(req);
  if (!credential) {
    return { ok: false, statusCode: 401, error: 'webui_unauthorized', reason: 'missing_credential' };
  }
  const authorization = authorizeManagementKey({
    credential,
    requiredManagementKey
  });
  if (authorization.ok) return authorization;
  return {
    ok: false,
    statusCode: authorization.statusCode,
    error: 'webui_unauthorized',
    reason: authorization.error
  };
}

module.exports = {
  authorizeWebUiRequest,
  extractWebUiCredential,
  isLoopbackPeer
};
