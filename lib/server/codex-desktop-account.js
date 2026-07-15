'use strict';

const path = require('node:path');
const { resolveHostHomeDir } = require('../runtime/host-home');
const { buildCodexSnapshotAccount } = require('../account/codex-auth-metadata');
const { readDefaultAccountRef } = require('../account/default-account-store');
const {
  listAccountCredentialRecords,
  readAccountCredentialRecord
} = require('./account-credential-store');
const { isAccountRef } = require('./account-ref-store');

const CODEX_DESKTOP_AUTH_TYPES = Object.freeze({
  API_KEY: 'apikey',
  CHATGPT: 'chatgpt'
});

function normalizeAccountRef(value) {
  const accountRef = String(value || '').trim();
  return isAccountRef(accountRef) ? accountRef : '';
}

function resolveAiHomeDir(options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const explicit = String(options.aiHomeDir || env.AI_HOME_DIR || env.AIH_HOME || '').trim();
  if (explicit) return explicit;
  const hostHome = resolveHostHomeDir({
    env,
    platform: processObj.platform,
    os: options.os
  });
  return hostHome ? path.join(hostHome, '.ai_home') : '';
}

function pushUniqueAccountRef(refs, value) {
  const accountRef = normalizeAccountRef(value);
  if (accountRef && !refs.includes(accountRef)) refs.push(accountRef);
}

function readDefaultCodexAccountRef(fs, aiHomeDir) {
  return readDefaultAccountRef(fs, aiHomeDir, 'codex');
}

function resolveCodexDesktopCandidateRefs(fs, aiHomeDir, options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const refs = [];

  pushUniqueAccountRef(refs, env.AIH_CODEX_DESKTOP_ACCOUNT_REF);
  pushUniqueAccountRef(refs, options.desktopAccountRef);
  if (options.allowAccountFallback === true) {
    pushUniqueAccountRef(refs, readDefaultCodexAccountRef(fs, aiHomeDir));
    listAccountCredentialRecords(fs, aiHomeDir, 'codex')
      .forEach((record) => pushUniqueAccountRef(refs, record.accountRef));
  }

  return refs;
}

function readCodexAccountArtifacts(fs, aiHomeDir, accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  if (!normalizedRef) return null;
  const record = readAccountCredentialRecord(fs, aiHomeDir, normalizedRef);
  if (!record || record.provider !== 'codex') return null;
  return {
    accountRef: normalizedRef,
    envJson: record.env,
    authJson: record.nativeAuth.auth || {}
  };
}

function readJwtPayload(token) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function isJwtUsableNow(token, options = {}) {
  const payload = readJwtPayload(token);
  if (!payload) return false;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) return true;
  const nowSeconds = Number.isFinite(Number(options.nowSeconds))
    ? Number(options.nowSeconds)
    : Math.floor(Date.now() / 1000);
  const skewSeconds = Number.isFinite(Number(options.skewSeconds))
    ? Number(options.skewSeconds)
    : 60;
  return exp > nowSeconds + skewSeconds;
}

function hasCodexOAuthTokens(authJson) {
  if (!authJson || typeof authJson !== 'object') return false;
  if (String(authJson.OPENAI_API_KEY || '').trim()) return false;
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  if (!tokens) return false;
  return Boolean(
    String(tokens.access_token || '').trim()
    || String(tokens.id_token || '').trim()
    || String(tokens.refresh_token || '').trim()
  );
}

function buildChatGptAccount(snapshotAccount) {
  if (!snapshotAccount || typeof snapshotAccount !== 'object') return null;
  const email = String(snapshotAccount.email || '').trim();
  if (!email) return null;
  return {
    type: 'chatgpt',
    email,
    planType: String(snapshotAccount.planType || '').trim() || 'unknown'
  };
}

function buildChatGptIdentity(artifacts, options = {}) {
  if (!artifacts || !hasCodexOAuthTokens(artifacts.authJson)) return null;
  const tokens = artifacts.authJson.tokens && typeof artifacts.authJson.tokens === 'object'
    ? artifacts.authJson.tokens
    : {};
  const accessToken = String(tokens.access_token || '').trim();
  if (options.requireAccessToken && !isJwtUsableNow(accessToken, options)) return null;
  const snapshotAccount = buildCodexSnapshotAccount(null, artifacts.authJson);
  const account = buildChatGptAccount(snapshotAccount);
  if (!account && options.requireAccount) return null;
  return {
    accountRef: artifacts.accountRef,
    authType: CODEX_DESKTOP_AUTH_TYPES.CHATGPT,
    account,
    accessToken,
    upstreamAccountId: String(snapshotAccount && snapshotAccount.upstreamAccountId || tokens.account_id || '').trim(),
    authJson: artifacts.authJson
  };
}

function buildCodexDesktopAccountIdentity(artifacts, options = {}) {
  return buildChatGptIdentity(artifacts, options);
}

function resolveCodexDesktopAccountIdentity(fs, options = {}) {
  const aiHomeDir = resolveAiHomeDir(options);
  if (!aiHomeDir) return null;

  for (const accountRef of resolveCodexDesktopCandidateRefs(fs, aiHomeDir, options)) {
    const identity = buildCodexDesktopAccountIdentity(
      readCodexAccountArtifacts(fs, aiHomeDir, accountRef),
      options
    );
    if (identity) return identity;
  }

  return null;
}

function resolveCodexDesktopChatGptIdentity(fs, options = {}) {
  const identity = resolveCodexDesktopAccountIdentity(fs, options);
  return identity && identity.authType === CODEX_DESKTOP_AUTH_TYPES.CHATGPT ? identity : null;
}

function resolveCodexDesktopChatGptAccount(fs, options = {}) {
  const identity = resolveCodexDesktopChatGptIdentity(fs, {
    ...options,
    requireAccessToken: true,
    requireAccount: true
  });
  return identity ? identity.account : null;
}

function validateCodexDesktopAccount(fs, options = {}) {
  const accountRef = normalizeAccountRef(options.accountRef);
  if (!accountRef) return { ok: false, code: 'invalid_account_ref' };
  const aiHomeDir = resolveAiHomeDir(options);
  if (!aiHomeDir) return { ok: false, code: 'ai_home_unavailable' };
  const identity = buildCodexDesktopAccountIdentity(
    readCodexAccountArtifacts(fs, aiHomeDir, accountRef),
    options
  );
  if (!identity) {
    return { ok: false, code: 'missing_codex_desktop_oauth' };
  }
  return {
    ok: true,
    accountRef,
    authType: identity.authType
  };
}

function buildCodexDesktopRuntimeAuth(identity) {
  if (!identity) return null;
  if (identity.authType !== CODEX_DESKTOP_AUTH_TYPES.CHATGPT) return null;
  const next = {
    ...identity.authJson,
    auth_mode: 'chatgpt'
  };
  delete next.OPENAI_API_KEY;
  return next;
}

module.exports = {
  CODEX_DESKTOP_AUTH_TYPES,
  buildCodexDesktopRuntimeAuth,
  resolveAiHomeDir,
  resolveCodexDesktopAccountIdentity,
  resolveCodexDesktopCandidateRefs,
  resolveCodexDesktopChatGptAccount,
  resolveCodexDesktopChatGptIdentity,
  validateCodexDesktopAccount,
  __private: {
    buildCodexDesktopAccountIdentity,
    isJwtUsableNow,
    readCodexAccountArtifacts,
    readDefaultCodexAccountRef
  }
};
