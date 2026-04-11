'use strict';

const path = require('node:path');
const os = require('node:os');
const fsExtra = require('fs-extra');
const { ensureDirSync } = require('./fs-compat');

const { AI_CLI_CONFIGS } = require('../cli/services/ai-cli/provider-registry');
const { createCliproxyapiExportService } = require('../cli/services/backup/cliproxyapi-export');
const { createCodexBulkImportService } = require('../cli/services/ai-cli/codex-bulk-import');
const { createUnifiedImportService } = require('../cli/services/import/unified-import');

const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function parseJsonFileSafe(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function decodeBase64UrlJsonSegment(segment) {
  const text = String(segment || '').trim();
  if (!text) return null;
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function decodeJwtPayloadUnsafe(jwt) {
  const text = String(jwt || '').trim();
  const parts = text.split('.');
  if (parts.length < 2) return null;
  return decodeBase64UrlJsonSegment(parts[1]);
}

function parseIsoTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const epochMs = Date.parse(text);
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  return epochMs;
}

function parseJwtExpiryMs(token) {
  const payload = decodeJwtPayloadUnsafe(token);
  const expSeconds = Number(payload && payload.exp);
  if (!Number.isFinite(expSeconds) || expSeconds <= 0) return null;
  return expSeconds * 1000;
}

function normalizeCodexAuthPayload(input) {
  const payload = input && typeof input === 'object' ? input : null;
  if (!payload) return null;

  const existingTokens = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : null;
  const accessToken = String(payload.access_token || payload.accessToken || (existingTokens && existingTokens.access_token) || '').trim();
  const refreshToken = String(payload.refresh_token || payload.refreshToken || (existingTokens && existingTokens.refresh_token) || '').trim();
  const idToken = String(payload.id_token || payload.idToken || (existingTokens && existingTokens.id_token) || '').trim();
  const accountId = String(
    payload.chatgpt_account_id
    || payload.account_id
    || payload.accountId
    || (existingTokens && existingTokens.account_id)
    || ''
  ).trim();
  if (!refreshToken.startsWith('rt_')) return null;

  const lastRefresh = String(payload.last_refresh || payload.lastRefresh || '').trim() || new Date().toISOString();
  const authJson = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      account_id: accountId || ''
    },
    last_refresh: lastRefresh
  };
  return authJson;
}

function extractCodexMetadata(authJson) {
  const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : {};
  const accessPayload = decodeJwtPayloadUnsafe(tokens.access_token);
  const idPayload = decodeJwtPayloadUnsafe(tokens.id_token);
  const authClaim = (accessPayload && accessPayload['https://api.openai.com/auth']) || (idPayload && idPayload['https://api.openai.com/auth']) || {};
  const profileClaim = (accessPayload && accessPayload['https://api.openai.com/profile']) || {};
  const organizations = Array.isArray(authClaim.organizations) ? authClaim.organizations : [];
  const defaultOrg = organizations.find((item) => item && item.is_default) || organizations[0] || null;

  return {
    email: String((profileClaim && profileClaim.email) || (idPayload && idPayload.email) || '').trim(),
    planType: String(authClaim.chatgpt_plan_type || '').trim(),
    clientId: String((accessPayload && accessPayload.client_id) || DEFAULT_CODEX_CLIENT_ID).trim(),
    chatgptAccountId: String(authClaim.chatgpt_account_id || authJson.chatgpt_account_id || tokens.account_id || '').trim(),
    chatgptUserId: String(authClaim.chatgpt_user_id || authJson.chatgpt_user_id || '').trim(),
    userId: String(authClaim.user_id || '').trim(),
    organizationId: String(authJson.organization_id || (defaultOrg && defaultOrg.id) || '').trim(),
    expiresAt: parseJwtExpiryMs(tokens.access_token) || parseIsoTimestampMs(authJson.expired) || null
  };
}

function readAccountExportRecord({ provider, accountId, profileDir, configDir, fs }) {
  const envPath = path.join(profileDir, '.aih_env.json');
  const envConfig = parseJsonFileSafe(fs, envPath) || {};
  const base = {
    provider,
    accountId,
    profileDir,
    configDir,
    config: envConfig,
    auth: {},
    meta: {}
  };

  if (provider === 'codex') {
    const authPath = path.join(configDir, 'auth.json');
    const authJson = parseJsonFileSafe(fs, authPath) || {};
    base.auth = authJson;
    base.meta = extractCodexMetadata(authJson);
    return base;
  }

  if (provider === 'gemini') {
    const oauthPath = path.join(profileDir, '.gemini', 'oauth_creds.json');
    const authJson = parseJsonFileSafe(fs, oauthPath) || {};
    base.auth = authJson;
    base.meta = {
      clientId: String(authJson.client_id || '').trim(),
      expiresAt: parseJwtExpiryMs(authJson.access_token) || null
    };
    return base;
  }

  if (provider === 'claude') {
    const credPath = path.join(configDir, '.credentials.json');
    const authJson = parseJsonFileSafe(fs, credPath) || {};
    const oauth = authJson.claudeAiOauth || authJson.claude_ai_oauth || {};
    base.auth = authJson;
    base.meta = {
      expiresAt: parseJwtExpiryMs(oauth.accessToken || oauth.access_token) || null
    };
    return base;
  }

  return base;
}

function parseManualImportText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const tryJson = () => {
    try {
      return [JSON.parse(raw)];
    } catch (_error) {
      return null;
    }
  };
  const direct = tryJson();
  if (direct) return direct;

  return raw
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function inferImportProvider(record) {
  const payload = record && typeof record === 'object' ? record : null;
  if (!payload) return '';
  const provider = String(payload.provider || '').trim().toLowerCase();
  if (provider) return provider;
  if (payload.refresh_token || payload.chatgpt_account_id || payload.chatgpt_user_id || payload.plan_type) return 'codex';
  if (payload.claudeAiOauth || payload.claude_ai_oauth) return 'claude';
  if (payload.client_id && payload.access_token && !payload.chatgpt_account_id) return 'gemini';
  return '';
}

function buildRuntimeImportTools(deps) {
  const hostHomeDir = os.homedir();
  const importCodexTokensFromOutput = createCodexBulkImportService({
    path,
    fs: deps.fs,
    crypto: require('node:crypto'),
    profilesDir: path.join(deps.aiHomeDir, 'profiles'),
    getDefaultParallelism: () => 4,
    getToolAccountIds: deps.getToolAccountIds,
    ensureDir: (target) => ensureDirSync(deps.fs, target),
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir
  }).importCodexTokensFromOutput;

  const cliproxyapi = createCliproxyapiExportService({
    fs: deps.fs,
    path,
    aiHomeDir: deps.aiHomeDir,
    hostHomeDir
  });

  const unifiedImport = createUnifiedImportService({
    fs: deps.fs,
    path,
    os,
    fse: fsExtra,
    execSync: require('node:child_process').execSync,
    spawnImpl: require('node:child_process').spawn,
    processImpl: process,
    cryptoImpl: require('node:crypto'),
    aiHomeDir: deps.aiHomeDir,
    cliConfigs: AI_CLI_CONFIGS,
    getDefaultParallelism: () => 4,
    runGlobalAccountImport: require('../cli/services/ai-cli/account-import-orchestrator').runGlobalAccountImport,
    importCliproxyapiCodexAuths: cliproxyapi.importCliproxyapiCodexAuths,
    parseCodexBulkImportArgs: createCodexBulkImportService({
      path,
      fs: deps.fs,
      crypto: require('node:crypto'),
      profilesDir: path.join(deps.aiHomeDir, 'profiles'),
      getDefaultParallelism: () => 4,
      getToolAccountIds: deps.getToolAccountIds,
      ensureDir: (target) => ensureDirSync(deps.fs, target),
      getProfileDir: deps.getProfileDir,
      getToolConfigDir: deps.getToolConfigDir
    }).parseCodexBulkImportArgs,
    importCodexTokensFromOutput
  });

  return {
    importCodexTokensFromOutput,
    runUnifiedImport: unifiedImport.runUnifiedImport
  };
}

module.exports = {
  normalizeCodexAuthPayload,
  extractCodexMetadata,
  readAccountExportRecord,
  parseManualImportText,
  inferImportProvider,
  buildRuntimeImportTools
};
