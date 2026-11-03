'use strict';

// 网关推理路径上的 kiro access token 刷新。
//
// 背景（2026-10-31 实测）：kiro access token 约 1 小时过期，而网关从凭据库加载账号时只取
// access_token、发请求前从不刷新 —— 只有额度探针和 WebUI「刷新账号」会换 token。token 一过期，
// CodeWhisperer 回 403 AccessDeniedException，被通用 401/403 分支判成 auth_invalid_reauth_required
// 并锁号一年；用户点「刷新」后又恢复。这里把刷新放到推理路径：
//   * 发请求前：token 临近过期就先刷新（ensureFreshKiroGrant 内部判断是否到期）；
//   * 上游 401/403：强制刷新一次，换到新 token 就重试同一账号，刷新本身被拒才算需要重新登录。
// 刷新实现与额度探针共用 kiro-grant-store（同一份 CAS 落库），不在这里另写一套。

const { readAccountCredentialRecord } = require('./account-credential-store');
const { ensureFreshKiroGrant } = require('../account/kiro-grant-store');

// 刷新端点明确拒绝 refresh_token（凭据真的失效）的错误码；其余（网络/超时/5xx）都不是凭据问题。
const UNRECOVERABLE_REFRESH_CODE_PATTERN = /^kiro_refresh_(?:http_(?:400|401|403)|missing_refresh_token|missing_client_registration)$/;

function normalizeString(value) {
  return String(value || '').trim();
}

function applyGrantToAccount(account, record) {
  const auth = record && record.nativeAuth && record.nativeAuth.auth;
  const accessToken = normalizeString(auth && (auth.access_token || auth.accessToken));
  if (!accessToken) return false;
  account.accessToken = accessToken;
  const profileArn = normalizeString(
    (record.nativeAuth && (record.nativeAuth.profileArn || record.nativeAuth.profile_arn))
    || (auth && (auth.profileArn || auth.profile_arn))
  );
  if (profileArn) account.profileArn = profileArn;
  return true;
}

/**
 * 确保账号对象上的 kiro access token 可用；必要时刷新并落库。
 * @param {object} account 网关内存池里的 kiro 账号（会被原地更新 accessToken / profileArn）
 * @param {{force?: boolean}} options force=true 时忽略过期时间强制刷新（上游已拒绝当前 token）
 * @param {{fs: object, aiHomeDir: string, ensureFreshKiroGrant?: Function, now?: () => number}} deps
 * @returns {Promise<{ok: boolean, refreshed: boolean, reason: string, unrecoverable?: boolean}>}
 */
async function refreshKiroAccountAccessToken(account, options = {}, deps = {}) {
  const accountRef = normalizeString(account && account.accountRef);
  if (!accountRef || !deps.fs || !deps.aiHomeDir) {
    return { ok: false, refreshed: false, reason: 'missing_account_context' };
  }
  const record = readAccountCredentialRecord(deps.fs, deps.aiHomeDir, accountRef);
  if (!record || record.provider !== 'kiro') {
    return { ok: false, refreshed: false, reason: 'credential_record_missing' };
  }
  const recordToken = normalizeString(record.nativeAuth && record.nativeAuth.auth
    && (record.nativeAuth.auth.access_token || record.nativeAuth.auth.accessToken));
  // 别的 writer（额度探针 / 刷新账号 / 重新登录）已经换过 token：直接吸收，不必再打刷新端点。
  if (recordToken && recordToken !== normalizeString(account.accessToken)) {
    applyGrantToAccount(account, record);
    return { ok: true, refreshed: true, reason: 'adopted_newer_credentials' };
  }
  const ensureFresh = deps.ensureFreshKiroGrant || ensureFreshKiroGrant;
  // force：把 expires_at 视为已过期，让 ensureFreshKiroGrant 走刷新分支。
  const nowMs = options.force ? Number.MAX_SAFE_INTEGER / 2 : (deps.now ? deps.now() : Date.now());
  let result;
  try {
    result = await ensureFresh(record, {
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir,
      now: nowMs,
      request: deps.request,
      timeoutMs: options.timeoutMs
    });
  } catch (error) {
    const code = normalizeString(error && error.code) || 'kiro_refresh_failed';
    return {
      ok: false,
      refreshed: false,
      reason: code,
      unrecoverable: UNRECOVERABLE_REFRESH_CODE_PATTERN.test(code)
    };
  }
  if (!result || result.error) {
    return { ok: false, refreshed: false, reason: normalizeString(result && result.error) || 'kiro_refresh_failed' };
  }
  if (!result.refreshed) return { ok: true, refreshed: false, reason: 'not_due' };
  applyGrantToAccount(account, result.record);
  return { ok: true, refreshed: true, reason: 'refreshed' };
}

module.exports = {
  refreshKiroAccountAccessToken
};
