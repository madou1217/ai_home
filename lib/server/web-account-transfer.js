'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fsExtra = require('fs-extra');
const { ensureDirSync } = require('./fs-compat');
const { extractCodexMetadata, parseJwtExpiryMs } = require('../account/codex-auth-metadata');

const { AI_CLI_CONFIGS } = require('../cli/services/ai-cli/provider-registry');
const { createCliproxyapiExportService } = require('../cli/services/backup/cliproxyapi-export');
const { createCodexBulkImportService } = require('../cli/services/ai-cli/codex-bulk-import');
const { createUnifiedImportService } = require('../cli/services/import/unified-import');

function parseJsonFileSafe(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
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
      return flattenImportRecords(JSON.parse(raw));
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
    .flatMap((line) => flattenImportRecords(JSON.parse(line)));
}

function inferImportProvider(record) {
  const payload = record && typeof record === 'object' ? record : null;
  if (!payload) return '';
  const provider = String(payload.provider || payload.type || '').trim().toLowerCase();
  if (provider) return provider;
  const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth : null;
  const tokens = payload.tokens && typeof payload.tokens === 'object'
    ? payload.tokens
    : (auth && auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null);
  if (
    payload.refresh_token
    || payload.chatgpt_account_id
    || payload.chatgpt_user_id
    || payload.plan_type
    || (tokens && tokens.refresh_token)
  ) {
    return 'codex';
  }
  if (
    payload.claudeAiOauth
    || payload.claude_ai_oauth
    || (auth && (auth.claudeAiOauth || auth.claude_ai_oauth))
  ) {
    return 'claude';
  }
  if (payload.OPENAI_API_KEY || (payload.config && payload.config.OPENAI_API_KEY)) return 'codex';
  if (payload.ANTHROPIC_API_KEY || (payload.config && payload.config.ANTHROPIC_API_KEY)) return 'claude';
  if (
    payload.GEMINI_API_KEY
    || payload.GOOGLE_API_KEY
    || (payload.config && (payload.config.GEMINI_API_KEY || payload.config.GOOGLE_API_KEY))
  ) {
    return 'gemini';
  }
  if (
    (payload.client_id && payload.access_token && !payload.chatgpt_account_id)
    || (auth && auth.client_id && auth.access_token && !auth.chatgpt_account_id)
  ) {
    return 'gemini';
  }
  return '';
}

function looksLikeAiHomeAccountBundle(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.accounts)) return false;
  if (payload.version != null || payload.exportedAt || payload.kind === 'ai-home-accounts') return true;
  return payload.accounts.some((item) => {
    const account = item && typeof item === 'object' ? item : null;
    return Boolean(account && (account.provider || account.auth || account.config || account.accountId));
  });
}

function flattenImportRecords(value) {
  const out = [];
  const visit = (item) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const payload = item && typeof item === 'object' ? item : null;
    if (!payload) return;
    if (looksLikeAiHomeAccountBundle(payload)) {
      payload.accounts.forEach(visit);
      return;
    }
    out.push(payload);
  };
  visit(value);
  return out;
}

function extractImportRecords(payload) {
  const input = payload && typeof payload === 'object' ? payload : null;
  if (!input) return null;
  if (Array.isArray(input.accounts)) return flattenImportRecords(input.accounts);
  if (input.account && typeof input.account === 'object') return flattenImportRecords(input.account);
  if (typeof input.content === 'string' && input.content.trim()) return parseManualImportText(input.content);
  return null;
}

function buildCodexAuthIdentityKey(authJson) {
  const auth = authJson && typeof authJson === 'object' ? authJson : null;
  if (!auth) return '';
  const meta = extractCodexMetadata(auth);
  const email = String(meta.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
  const accountId = String(meta.chatgptAccountId || tokens.account_id || '').trim().toLowerCase();
  if (accountId) return `account_id:${accountId}`;
  const refreshToken = String(tokens.refresh_token || '').trim();
  if (!refreshToken) return '';
  return `refresh_sha256:${crypto.createHash('sha256').update(refreshToken).digest('hex')}`;
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
  flattenImportRecords,
  extractImportRecords,
  inferImportProvider,
  buildCodexAuthIdentityKey,
  buildRuntimeImportTools
};
