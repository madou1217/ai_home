'use strict';

const { authorizeManagementKey, isLoopbackPeer } = require('./management-key-auth');

const LOOPBACK_INGRESS_PATHS = new Set([
  '/v0/webui/internal/approval-request',
  '/v0/webui/session-events/provider-hook'
]);

// WebUI 数据面鉴权门：/v0/webui/*。
// - 所有客户端都必须携带当前 Management Key，包括同机 loopback。
// - 仅 provider hook / Claude 审批桥这两个本机内部 POST ingress 使用窄 loopback
//   capability；它们不返回管理数据，也不能扩展成普通 WebUI 信任边界。
// - 静态 UI 可以公开加载，但 Dashboard、账号、会话等数据面不能把网络位置当作身份。
// 凭据只接受 Authorization: Bearer。浏览器实时流使用 fetch stream，因此完整
// Management Key 不进入 URL、代理日志或 DOM 资源地址。

function extractWebUiCredential(req) {
  const header = String((req && req.headers && req.headers.authorization) || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match && match[1]) return match[1].trim();
  return '';
}

function isLoopbackInternalIngress(req, url) {
  const method = String(req && req.method || '').toUpperCase();
  const pathname = url && typeof url.pathname === 'string'
    ? url.pathname
    : new URL(String(req && req.url || '/'), 'http://localhost').pathname;
  return method === 'POST'
    && LOOPBACK_INGRESS_PATHS.has(pathname)
    && isLoopbackPeer(req);
}

function authorizeWebUiRequest({ req, url, requiredManagementKey = '' } = {}) {
  if (isLoopbackInternalIngress(req, url)) {
    return { ok: true, via: 'internal_loopback' };
  }
  const credential = extractWebUiCredential(req);
  if (!requiredManagementKey) {
    return {
      ok: false,
      statusCode: 503,
      error: 'webui_unauthorized',
      reason: 'management_key_not_configured'
    };
  }
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
  isLoopbackInternalIngress
};
