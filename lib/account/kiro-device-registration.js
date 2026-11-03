'use strict';

// kiro 的 OIDC device-registration 解析 —— **纯 API 刷新的前提**。
//
// 事实（2026-10-15 实测）：本地 kiro CLI 的 `data.sqlite3` 里 `auth_kv` 表存着两条记录：
//   * `kirocli:odic:device-registration` → { client_id, client_secret, client_secret_expires_at, region, oauth_flow, scopes }
//   * `kirocli:odic:token`               → { access_token, refresh_token, expires_at, ... }
// 账号导入时这份 sqlite 以 base64 存在凭据记录的 `nativeAuth.database` 里，因此**不装 CLI 也能刷新**。
//
// 解析优先级：
//   1. `nativeAuth.registration`（新写入的显式字段，最省事、可读）
//   2. `nativeAuth.database`（历史导入形态：base64 sqlite 的 auth_kv 记录）
// 两者都拿不到时返回带原因的失败对象，调用方据此切到 CLI 兜底策略（fail closed，不猜）。

const nodeFs = require('node:fs');

const KEY_DEVICE_REGISTRATION = 'kirocli:odic:device-registration';
const KEY_TOKEN = 'kirocli:odic:token';

function normalizeRegion(value, fallback = 'us-east-1') {
  const region = String(value || '').trim();
  return /^[a-z]{2}-[a-z]+-\d$/.test(region) ? region : fallback;
}

function normalizeRegistration(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const clientId = String(raw.client_id || raw.clientId || '').trim();
  const clientSecret = String(raw.client_secret || raw.clientSecret || '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    region: normalizeRegion(raw.region),
    oauthFlow: String(raw.oauth_flow || raw.oauthFlow || 'DeviceCode'),
    scopes: Array.isArray(raw.scopes) ? raw.scopes.map((scope) => String(scope)) : [],
    clientSecretExpiresAt: String(raw.client_secret_expires_at || raw.clientSecretExpiresAt || '')
  };
}

/** 从凭据记录里内嵌的 base64 sqlite 读取 auth_kv（历史导入形态）。 */
function readAuthKvFromEmbeddedDatabase(nativeAuth, options = {}) {
  const raw = nativeAuth && nativeAuth.database;
  if (raw == null) return null;
  const encoded = Array.isArray(raw) ? raw.join('') : String(raw);
  if (!encoded.trim()) return null;
  const fs = options.fs || nodeFs;
  const tmpPath = options.tmpPath || require('node:path').join(
    require('node:os').tmpdir(),
    `aih-kiro-embedded-${process.pid}-${Date.now()}.sqlite3`
  );
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return null;
  }
  if (!DatabaseSync) return null;
  try {
    fs.writeFileSync(tmpPath, Buffer.from(encoded, 'base64'));
    const database = new DatabaseSync(tmpPath, { readOnly: true });
    try {
      const rows = database.prepare('SELECT key, value FROM auth_kv').all();
      const map = new Map();
      for (const row of rows) {
        try {
          map.set(String(row.key), JSON.parse(String(row.value)));
        } catch (_error) { /* 非 JSON 的行与刷新无关 */ }
      }
      return map;
    } finally {
      try { database.close(); } catch (_error) { /* ignore */ }
    }
  } catch (_error) {
    return null;
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_error) { /* ignore */ }
  }
}

/**
 * 解析该账号可用于纯 HTTP 刷新的 device-registration。
 * @returns {{registration: object}|{error: string}}
 */
function resolveKiroDeviceRegistration(nativeAuth, options = {}) {
  const explicit = normalizeRegistration(nativeAuth && nativeAuth.registration);
  if (explicit) return { registration: explicit };

  const authKv = readAuthKvFromEmbeddedDatabase(nativeAuth, options);
  if (!authKv) return { error: 'kiro_registration_unavailable' };
  const registration = normalizeRegistration(authKv.get(KEY_DEVICE_REGISTRATION));
  if (!registration) return { error: 'kiro_registration_missing' };

  // 内嵌 sqlite 里的 token 可能比记录里的新（CLI 刚刷过）：一并交给调用方做代际比较。
  const embeddedToken = authKv.get(KEY_TOKEN) || null;
  return { registration, embeddedToken };
}

module.exports = {
  KEY_DEVICE_REGISTRATION,
  KEY_TOKEN,
  normalizeRegistration,
  readAuthKvFromEmbeddedDatabase,
  resolveKiroDeviceRegistration
};
