'use strict';

// Go 账号库 → Node 原生凭据投影的只读桥。
//
// 账号是两份库：Go 是写入方（浏览器登录 / 导入），Node 侧只认识自己建过的账号。
// CLI 启动要按 accountRef 把原生登录态物化到沙箱，于是「Go 独有账号」（例如用 Go
// 完成的 agy 登录）在 Node 侧解析不到账号、也读不到凭据，`aih agy 1` 直接失败。
//
// 这里把 Go 的 credential_json 还原成 Node 的 native_auth_json 形状，供
// native-auth-projection 物化使用。只读、只做形状转换，不写任何账号库。

const { readGoAccounts } = require('./go-account-store-reader');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// agy 的 Go 凭据是 typed OAuth（authKind=oauth / authMode=consumer）：
// { email, access_token, refresh_token, token_type, expires_at_ms, refreshed_at_ms, auth_method }。
// Node 侧的沙箱投影吃的是 { email, oauthToken: { auth_method, token } }。
function agyNativeAuthFromCredential(credential, profile) {
  const expiresAtMs = Number(credential.expires_at_ms);
  const refreshedAtMs = Number(credential.refreshed_at_ms);
  const token = {
    access_token: text(credential.access_token),
    refresh_token: text(credential.refresh_token),
    token_type: text(credential.token_type) || 'Bearer'
  };
  if (Number.isFinite(expiresAtMs) && expiresAtMs > 0) {
    token.expires_at_ms = Math.trunc(expiresAtMs);
    token.expiry = new Date(expiresAtMs).toISOString();
  }
  if (Number.isFinite(refreshedAtMs) && refreshedAtMs > 0) token.refreshed_at_ms = Math.trunc(refreshedAtMs);
  const email = text((profile && profile.email) || credential.email);
  if (!token.access_token && !token.refresh_token) return null;
  return {
    ...(email ? { email } : {}),
    oauthToken: {
      auth_method: text(credential.auth_method) || 'consumer',
      token
    }
  };
}

// goNativeAuthForAccount 把一条 Go 账号快照转成 Node 的 native_auth_json。
// 认识的形态：native_auth_json 信封（Go 原样承接的 Provider）与 agy 的 typed OAuth。
function goNativeAuthForAccount(account) {
  if (!account || !isObject(account)) return null;
  const credential = isObject(account.credential) ? account.credential : {};
  if (isObject(credential.native_auth_json) && Object.keys(credential.native_auth_json).length > 0) {
    return credential.native_auth_json;
  }
  if (account.provider === 'agy' && account.authKind === 'oauth') {
    return agyNativeAuthFromCredential(credential, account.profile);
  }
  return null;
}

// readGoAccountRecord 按 ref 读一条 Go 账号（含凭据与资料快照）。
function readGoAccountRecord(aiHomeDir, accountRef, deps = {}) {
  const ref = text(accountRef);
  if (!ref) return null;
  try {
    const store = readGoAccounts(aiHomeDir, { fs: deps.fs });
    if (!store || !store.exists) return null;
    return store.accounts.find((account) => account.accountRef === ref) || null;
  } catch (_error) {
    return null;
  }
}

// readGoAccountByCliId 按 (provider, 数字别名) 读 Go 账号 —— Node 别名表没有记录时用。
function readGoAccountByCliId(aiHomeDir, provider, cliAccountId, deps = {}) {
  const normalizedProvider = text(provider).toLowerCase();
  const normalizedId = text(cliAccountId);
  if (!normalizedProvider || !/^\d+$/.test(normalizedId)) return null;
  try {
    const store = readGoAccounts(aiHomeDir, { fs: deps.fs });
    if (!store || !store.exists) return null;
    return store.accounts.find((account) => account.provider === normalizedProvider
      && String(account.cliAccountId || '') === normalizedId) || null;
  } catch (_error) {
    return null;
  }
}

// readGoNativeAuth 返回该 Go 账号的 native_auth_json；不认识的形态返回 null。
function readGoNativeAuth(aiHomeDir, accountRef, deps = {}) {
  return goNativeAuthForAccount(readGoAccountRecord(aiHomeDir, accountRef, deps));
}

module.exports = {
  goNativeAuthForAccount,
  readGoAccountByCliId,
  readGoAccountRecord,
  readGoNativeAuth
};
