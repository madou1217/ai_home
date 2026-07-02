'use strict';

const { authorizeControlPlaneDeviceToken } = require('./control-plane-device-pairing');

// WebUI 数据面鉴权门：/v0/webui/* 一律要求已配对设备 token（用户拍板：localhost 不豁免）。
// 凭据来源（按序）：Authorization: Bearer → ?access_token=（EventSource/WS 无法带 header）。
// management key 作为运维逃生口（与 /v0/management 同一把钥匙）。

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
  extractWebUiCredential
};
