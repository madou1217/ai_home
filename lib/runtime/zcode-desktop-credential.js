'use strict';

// ZCode 桌面桥只需要「一个 accountRef 的 provider + 原生凭据」这两项事实，
// 直接读 Go 的规范表（accounts + account_credentials）。此前经由
// lib/server/account-credential-store.js 读的是 compat 兼容表，而 zcode 账号
// 早已只存在于规范表（compat 无该行），桥接会误判 zcode_desktop_account_unavailable；
// 同时那条 require 会把整棵 Node 账号身份链（account-ref-store/identity/
// provider-credentials）拖进每次 attribution。
//
// 这里只做只读查询：不建表、不写库、不依赖账号身份策略。

const { getBusinessDatabasePath } = require('../server/business-database');

// API Key 账号在规范表里是静态凭据（auth_kind=api_key）；桌面桥只接受 OAuth 登录态。
const API_KEY_AUTH_KIND = 'api_key';

function parseCredentialDocument(raw) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

/**
 * 读取一个 accountRef 的桌面桥所需凭据事实。
 *
 * @returns {{provider: string, apiKey: boolean, nativeAuth: object} | null}
 *   null 表示账号不存在或未启用；apiKey=true 表示这是 API Key 账号（桥不可用）。
 *   nativeAuth 是 account_credentials.credential_json.native_auth_json 原文，
 *   其中的 enc:v1 值仍由 lib/account/zcode-credential.js 按既有规则解密。
 */
function readZcodeDesktopCredential(fs, aiHomeDir, accountRef) {
  const file = getBusinessDatabasePath(aiHomeDir);
  if (!file || !fs || !fs.existsSync(file)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000');
    const row = db.prepare(`
      SELECT a.provider_id, c.auth_kind, c.credential_json
      FROM accounts a
      JOIN account_credentials c ON c.account_ref = a.account_ref
      WHERE a.account_ref = ? AND a.enabled = 1
      LIMIT 1
    `).get(String(accountRef || '').trim());
    if (!row) return null;
    const provider = String(row.provider_id || '').trim();
    if (row.auth_kind === API_KEY_AUTH_KIND) {
      return { provider, apiKey: true, nativeAuth: {} };
    }
    const document = parseCredentialDocument(row.credential_json);
    const nativeAuth = document.native_auth_json && typeof document.native_auth_json === 'object'
      ? document.native_auth_json
      : {};
    return { provider, apiKey: false, nativeAuth };
  } finally {
    db.close();
  }
}

module.exports = { readZcodeDesktopCredential };