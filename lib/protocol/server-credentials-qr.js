'use strict';

const MANAGEMENT_KEY_QR_VERSION = 1;
const MANAGEMENT_KEY_QR_TYPE = 'aih-server-credentials';
const MIN_MANAGEMENT_KEY_LENGTH = 32;
const MAX_MANAGEMENT_KEY_LENGTH = 8192;

function normalizeText(value, maxLength = 8192) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > maxLength) throw new Error('二维码字段长度超过限制。');
  return text;
}

function normalizeEndpoint(value) {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  if (!raw) throw new Error('Management Key QR 缺少 Server URL。');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    throw new Error('Management Key QR 的 Server URL 无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Management Key QR 的 Server URL 必须使用 HTTP 或 HTTPS。');
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('Server URL 不能包含凭据、查询参数或片段。');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeManagementKey(value) {
  if (typeof value !== 'string') throw new Error('Management Key 格式无效。');
  const key = normalizeText(value, MAX_MANAGEMENT_KEY_LENGTH);
  if (
    key.length < MIN_MANAGEMENT_KEY_LENGTH
    || key.length > MAX_MANAGEMENT_KEY_LENGTH
    || /[\u0000-\u0020\u007f]/.test(key)
  ) {
    throw new Error(`Management Key 必须为 ${MIN_MANAGEMENT_KEY_LENGTH}-${MAX_MANAGEMENT_KEY_LENGTH} 个字符，且不能包含换行。`);
  }
  return key;
}

function buildManagementKeyQrPayload(input = {}) {
  const endpoint = normalizeEndpoint(input.endpoint);
  const managementKey = normalizeManagementKey(input.managementKey);
  return JSON.stringify({
    v: MANAGEMENT_KEY_QR_VERSION,
    type: MANAGEMENT_KEY_QR_TYPE,
    endpoint,
    managementKey
  });
}

function parseManagementKeyQrPayload(value) {
  let payload;
  try {
    if (typeof value !== 'string' || value.length > 16384) throw new Error('invalid_payload');
    payload = JSON.parse(value);
  } catch (_error) {
    throw new Error('二维码内容不是有效的 JSON。');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('二维码内容格式无效。');
  }
  if (payload.v !== MANAGEMENT_KEY_QR_VERSION || payload.type !== MANAGEMENT_KEY_QR_TYPE) {
    throw new Error('二维码不是 AI Home Server 凭据二维码，或版本不受支持。');
  }
  if (typeof payload.endpoint !== 'string') throw new Error('Server URL 格式无效。');
  const endpoint = normalizeEndpoint(payload.endpoint);
  const managementKey = normalizeManagementKey(payload.managementKey);
  return { endpoint, managementKey };
}

module.exports = { MANAGEMENT_KEY_QR_VERSION, MANAGEMENT_KEY_QR_TYPE, MIN_MANAGEMENT_KEY_LENGTH, MAX_MANAGEMENT_KEY_LENGTH, normalizeEndpoint, normalizeManagementKey, buildManagementKeyQrPayload, parseManagementKeyQrPayload };
