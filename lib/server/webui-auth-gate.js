'use strict';

const { authorizeManagementKey, isLoopbackPeer } = require('./management-key-auth');

const LOOPBACK_INGRESS_PATHS = new Set([
  '/v0/webui/internal/approval-request',
  '/v0/webui/internal/remote-tools',
  '/v0/webui/session-events/provider-hook'
]);

// 本机页面引导：浏览器 localStorage 被清掉（PWA 存储回收 / 清站点数据 / 换浏览器）后，
// 同机打开的 UI 需要一个不带 Key 的入口把「本机 profile + 当前 Management Key」取回来。
// 边界比 LOOPBACK_INGRESS_PATHS 更窄：
//   * 只允许 GET，只允许这一个路径；
//   * TCP 对端必须是 loopback；
//   * Host 头必须是 loopback 名字（反向代理转发到 127.0.0.1 时 Host 是外部域名，会被挡住）；
//   * 带任何转发头（X-Forwarded-For / X-Real-IP / Forwarded）一律拒绝。
// 局域网/远端客户端仍然必须自带 Key —— 它们拿不到这个入口。
const LOOPBACK_BOOTSTRAP_PATHS = new Set([
  '/v0/webui/control-plane/bootstrap'
]);

// WebUI 数据面鉴权门：/v0/webui/*。
// - 所有客户端都必须携带当前 Management Key，包括同机 loopback。
// - 仅 provider hook / Claude 审批桥 / 远程工作区工具（自带会话令牌）这几个本机内部 POST ingress 使用窄 loopback
//   capability；它们不返回管理数据，也不能扩展成普通 WebUI 信任边界。
// - 静态 UI 可以公开加载，但 Dashboard、账号、会话等数据面不能把网络位置当作身份。
// HTTP 凭据只接受 Authorization: Bearer。会话 WebSocket 的专用适配器将首帧
// Bearer 凭据交给同一校验器；认证前不订阅数据。Management Key 不进入 URL、
// 代理日志或 DOM 资源地址。

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

// isLoopbackHostName 判断浏览器地址栏是不是本机名字。
// 反向代理场景下 TCP 对端也会是 127.0.0.1，但 Host 是外部域名，必须靠这一条挡住。
function isLoopbackHostName(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host) return false;
  // 裸 IPv6 没有端口，先单独认；带方括号的按 ']' 截断再比较。
  if (host === '::1') return true;
  const withoutPort = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.replace(/:\d+$/, '');
  return withoutPort === 'localhost'
    || withoutPort === '127.0.0.1'
    || withoutPort === '[::1]';
}

function isLoopbackHostHeader(req) {
  return isLoopbackHostName(req && req.headers && req.headers.host);
}

function isLoopbackBootstrapIngress(req, url) {
  const method = String(req && req.method || '').toUpperCase();
  const pathname = url && typeof url.pathname === 'string'
    ? url.pathname
    : new URL(String(req && req.url || '/'), 'http://localhost').pathname;
  if (method !== 'GET' || !LOOPBACK_BOOTSTRAP_PATHS.has(pathname)) return false;
  if (!isLoopbackPeer(req) || !isLoopbackHostHeader(req)) return false;
  const headers = (req && req.headers) || {};
  // Go 前门会写 X-AIH-Peer（真实客户端）并附带 X-Forwarded-For；带前门标记时以
  // X-AIH-Peer 判定的 loopback 结论为准，其它代理头一律仍然拒绝。
  if (headers['x-aih-peer']) return true;
  if (headers['x-forwarded-for'] || headers['x-real-ip'] || headers.forwarded) return false;
  return true;
}

function authorizeWebUiRequest({ req, url, requiredManagementKey = '' } = {}) {
  if (isLoopbackInternalIngress(req, url)) {
    return { ok: true, via: 'internal_loopback' };
  }
  if (isLoopbackBootstrapIngress(req, url)) {
    return { ok: true, via: 'loopback_bootstrap' };
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
  isLoopbackInternalIngress,
  isLoopbackBootstrapIngress,
  isLoopbackHostName
};
