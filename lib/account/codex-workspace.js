'use strict';

// Codex ChatGPT 工作区模型：逐条复刻 Go 的 core/accounts/codex（parseIDTokenProfile +
// applyExplicitAccountID + AccountID/UpstreamAccountID），让 Node 与 Go 对同一份 auth.json
// 得出同一个工作区结论。两端由 contracts/go-bridge/codex-workspace-vectors.json 共同守卫。
//
// 语义要点（与 Go 一致）：
//   - 工作区只来自 id_token 的 `https://api.openai.com/auth`.chatgpt_account_id；
//     access_token 的 claim 不参与（旧 Node 曾优先读 access_token）。
//   - claim 缺失即个人账号，领域值固定为 `personal`；上游协议值为空串（不发 chatgpt-account-id）。
//   - claim 字面量为 `personal` 或含 `:`/控制字符/U+FFFD 时整份凭据无效。
//   - 显式工作区（tokens.account_id）只能在 claim 为 personal 时补充，或与 claim 完全相同；
//     冲突时整份凭据无效，绝不静默择一。

const { isIdentityComponent, trimGoSpace } = require('./identity-components');

const CODEX_AUTH_CLAIM_NAMESPACE = 'https://api.openai.com/auth';
const CODEX_PROFILE_CLAIM_NAMESPACE = 'https://api.openai.com/profile';

const PERSONAL_WORKSPACE_ID = 'personal';

const WORKSPACE_ERRORS = Object.freeze({
  invalidIdToken: 'codex_workspace_invalid_id_token',
  invalidAccountId: 'codex_workspace_invalid_account_id',
  accountIdMismatch: 'codex_workspace_account_id_mismatch'
});

function failure(error) {
  return { ok: false, error, workspaceId: '', upstreamAccountId: '', source: '' };
}

// Go 的 decodeJWTPayload：恰好三段且每段非空，payload 为无填充 base64url 且是合法 UTF-8。
// 本模块自带解码器，不依赖 codex-auth-metadata（其解码更宽松，且二者需要互相引用）。
function readIdTokenPayload(idToken) {
  const parts = String(typeof idToken === 'string' ? idToken : '').split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1], 'base64url'));
    const payload = JSON.parse(text);
    if (!isPlainObject(payload) || !hasValidKnownClaims(payload)) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Go decodeOptionalStringClaim：字符串或 null，且不含 U+FFFD。
function isOptionalStringClaim(value) {
  return value === undefined || value === null || (typeof value === 'string' && !value.includes('�'));
}

// Go decodeCodexIDTokenClaims 对已知 claim 做严格类型校验，任一不合法则整个 id_token 无效。
function hasValidKnownClaims(payload) {
  if (!isOptionalStringClaim(payload.sub) || !isOptionalStringClaim(payload.email)) return false;
  const auth = payload[CODEX_AUTH_CLAIM_NAMESPACE];
  if (auth !== undefined && auth !== null) {
    if (!isPlainObject(auth)) return false;
    for (const key of ['chatgpt_user_id', 'user_id', 'chatgpt_account_id', 'chatgpt_plan_type']) {
      if (!isOptionalStringClaim(auth[key])) return false;
    }
    if (auth.chatgpt_account_is_fedramp !== undefined && typeof auth.chatgpt_account_is_fedramp !== 'boolean') return false;
  }
  const profile = payload[CODEX_PROFILE_CLAIM_NAMESPACE];
  if (profile !== undefined && profile !== null) {
    if (!isPlainObject(profile) || !isOptionalStringClaim(profile.email)) return false;
  }
  return true;
}

function readClaimString(value) {
  return typeof value === 'string' ? value : '';
}

function readExplicitAccountId(authJson) {
  const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : {};
  // tokens.account_id 是官方显式字段；顶层 chatgpt_account_id 是 Node 旧导入形态的同义值。
  return trimGoSpace(readClaimString(tokens.account_id) || readClaimString(authJson && authJson.chatgpt_account_id));
}

/**
 * 解析 Codex auth.json 的工作区。
 * @returns {{ok: boolean, error: string, workspaceId: string, upstreamAccountId: string, source: string}}
 *   workspaceId 为领域值（个人账号为 `personal`）；upstreamAccountId 为写入上游协议的值（个人账号为空）；
 *   source 为 `id_token` | `explicit` | `personal`。
 */
function resolveCodexWorkspace(authJson) {
  const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : {};
  const payload = readIdTokenPayload(tokens.id_token);
  if (!payload) return failure(WORKSPACE_ERRORS.invalidIdToken);
  const authClaim = payload[CODEX_AUTH_CLAIM_NAMESPACE];
  const claimed = trimGoSpace(readClaimString(isPlainObject(authClaim) ? authClaim.chatgpt_account_id : ''));
  if (claimed === PERSONAL_WORKSPACE_ID || (claimed && !isIdentityComponent(claimed))) {
    return failure(WORKSPACE_ERRORS.invalidAccountId);
  }
  let workspaceId = claimed || PERSONAL_WORKSPACE_ID;
  let source = claimed ? 'id_token' : 'personal';

  const explicit = readExplicitAccountId(authJson);
  if (explicit) {
    if (explicit === PERSONAL_WORKSPACE_ID || !isIdentityComponent(explicit)) {
      return failure(WORKSPACE_ERRORS.invalidAccountId);
    }
    if (workspaceId !== PERSONAL_WORKSPACE_ID && workspaceId !== explicit) {
      return failure(WORKSPACE_ERRORS.accountIdMismatch);
    }
    if (workspaceId === PERSONAL_WORKSPACE_ID) source = 'explicit';
    workspaceId = explicit;
  }

  return {
    ok: true,
    error: '',
    workspaceId,
    upstreamAccountId: workspaceId === PERSONAL_WORKSPACE_ID ? '' : workspaceId,
    source
  };
}

module.exports = {
  CODEX_AUTH_CLAIM_NAMESPACE,
  PERSONAL_WORKSPACE_ID,
  WORKSPACE_ERRORS,
  resolveCodexWorkspace
};
