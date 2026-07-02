'use strict';

const { authorizeControlPlaneDeviceToken } = require('./control-plane-device-pairing');

// WebUI 数据面鉴权门：/v0/webui/*。
// - 同机 loopback 连接（127.0.0.1 / ::1 的真实 TCP 对端）自动信任：你在自己电脑上访问自己的 server
//   不该被自己挡；且能避免"未配对本机→全 401→拉不到 profile→切换器禁用"的死锁。
// - 局域网 / 公网连接（非 loopback 对端）仍必须携带已配对设备 token，未授权 401。
// 凭据来源（按序）：Authorization: Bearer → ?access_token=（EventSource/WS 无法带 header）。
// management key 作为运维逃生口（与 /v0/management 同一把钥匙）。

function isLoopbackPeer(req) {
  // 用真实 TCP 对端地址判断（不可被 Host/Header 伪造），只放行同机连接。
  const addr = String((req && req.socket && req.socket.remoteAddress) || '').trim().toLowerCase();
  if (!addr) return false;
  const normalized = addr.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || addr === '::1' || normalized.startsWith('127.');
}

function extractWebUiCredential(req, url) {
  const header = String((req && req.headers && req.headers.authorization) || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match && match[1]) return match[1].trim();
  if (url && url.searchParams) {
    const queryToken = String(url.searchParams.get('access_token') || '').trim();
    if (queryToken) return queryToken;
  }
  return '';
}

function authorizeWebUiRequest({ req, url, requiredManagementKey = '', deps = {} } = {}) {
  // 同机 loopback：自动信任（远程/局域网不受影响）。
  if (isLoopbackPeer(req)) {
    return { ok: true, via: 'loopback' };
  }
  const credential = extractWebUiCredential(req, url);
  if (!credential) {
    return { ok: false, statusCode: 401, error: 'webui_unauthorized', reason: 'missing_credential' };
  }
  const managementKey = String(requiredManagementKey || '').trim();
  if (managementKey && credential === managementKey) {
    return { ok: true, via: 'management_key' };
  }
  const device = authorizeControlPlaneDeviceToken(credential, '', deps);
  if (device && device.ok) {
    return { ok: true, via: 'device_token', device: device.device };
  }
  return { ok: false, statusCode: 401, error: 'webui_unauthorized', reason: 'invalid_credential' };
}

module.exports = {
  authorizeWebUiRequest,
  extractWebUiCredential,
  isLoopbackPeer
};
