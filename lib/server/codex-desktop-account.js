'use strict';

const path = require('node:path');
const { resolveHostHomeDir } = require('../runtime/host-home');
const { buildCodexSnapshotAccount } = require('../account/codex-auth-metadata');

const CODEX_DESKTOP_AUTH_TYPES = Object.freeze({
  API_KEY: 'apikey',
  CHATGPT: 'chatgpt'
});

function normalizeAccountId(value) {
  const id = String(value || '').trim();
  return /^\d+$/.test(id) ? id : '';
}

function readJsonFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8')).trim();
  } catch (_error) {
    return '';
  }
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

function pushUniqueAccountId(ids, value) {
  const id = normalizeAccountId(value);
  if (id && !ids.includes(id)) ids.push(id);
}

function readDefaultCodexAccountId(fs, codexProfilesDir) {
  return normalizeAccountId(readTextFileSafe(fs, path.join(codexProfilesDir, '.aih_default')));
}

function listCodexAccountIds(fs, codexProfilesDir) {
  try {
    return fs.readdirSync(codexProfilesDir)
      .filter((entryName) => {
        if (!/^\d+$/.test(entryName)) return false;
        try {
          return fs.statSync(path.join(codexProfilesDir, entryName)).isDirectory();
        } catch (_error) {
          return false;
        }
      })
      .sort((left, right) => Number(right) - Number(left));
  } catch (_error) {
    return [];
  }
}

function resolveCodexDesktopCandidateIds(fs, aiHomeDir, options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const codexProfilesDir = path.join(aiHomeDir, 'profiles', 'codex');
  const ids = [];

  pushUniqueAccountId(ids, env.AIH_CODEX_DESKTOP_ACCOUNT_ID);
  pushUniqueAccountId(ids, options.desktopAccountId);
  if (options.allowAccountFallback === true) {
    pushUniqueAccountId(ids, readDefaultCodexAccountId(fs, codexProfilesDir));
    listCodexAccountIds(fs, codexProfilesDir).forEach((id) => pushUniqueAccountId(ids, id));
  }

  return ids;
}

function readCodexAccountArtifacts(fs, aiHomeDir, accountId) {
  const id = normalizeAccountId(accountId);
  if (!id) return null;
  const profileDir = path.join(aiHomeDir, 'profiles', 'codex', id);
  const configDir = path.join(profileDir, '.codex');
  return {
    id,
    profileDir,
    configDir,
    envJson: readJsonFileSafe(fs, path.join(profileDir, '.aih_env.json')) || {},
    authJson: readJsonFileSafe(fs, path.join(configDir, 'auth.json')) || {}
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
  const account = buildChatGptAccount(buildCodexSnapshotAccount(null, artifacts.authJson));
  if (!account && options.requireAccount) return null;
  return {
    id: artifacts.id,
    authType: CODEX_DESKTOP_AUTH_TYPES.CHATGPT,
    account,
    accessToken,
    authJson: artifacts.authJson,
    profileDir: artifacts.profileDir,
    configDir: artifacts.configDir
  };
}

function buildCodexDesktopAccountIdentity(artifacts, options = {}) {
  return buildChatGptIdentity(artifacts, options);
}

function resolveCodexDesktopAccountIdentity(fs, options = {}) {
  const aiHomeDir = resolveAiHomeDir(options);
  if (!aiHomeDir) return null;

  for (const id of resolveCodexDesktopCandidateIds(fs, aiHomeDir, options)) {
    const identity = buildCodexDesktopAccountIdentity(
      readCodexAccountArtifacts(fs, aiHomeDir, id),
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
  const accountId = normalizeAccountId(options.accountId);
  if (!accountId) return { ok: false, code: 'invalid_account_id' };
  const aiHomeDir = resolveAiHomeDir(options);
  if (!aiHomeDir) return { ok: false, code: 'ai_home_unavailable' };
  const identity = buildCodexDesktopAccountIdentity(
    readCodexAccountArtifacts(fs, aiHomeDir, accountId),
    options
  );
  if (!identity) {
    return { ok: false, code: 'missing_codex_desktop_oauth' };
  }
  return {
    ok: true,
    accountId,
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
  resolveCodexDesktopCandidateIds,
  resolveCodexDesktopChatGptAccount,
  resolveCodexDesktopChatGptIdentity,
  validateCodexDesktopAccount,
  __private: {
    buildCodexDesktopAccountIdentity,
    isJwtUsableNow,
    readCodexAccountArtifacts,
    readDefaultCodexAccountId
  }
};
