'use strict';

const path = require('path');
const {
  readAccountStatusFile,
  resolveEffectiveAccountStatus
} = require('../account/status-file');
const {
  normalizeAccountRuntime,
  applyPersistedAccountRuntimeState
} = require('./account-runtime-state');
const {
  decodeJwtPayloadUnsafe,
  parseJwtExpiryMs,
  buildCodexSnapshotAccount,
  buildCodexMetadataFallbackSnapshot
} = require('../account/codex-auth-metadata');
const {
  getMinRemainingPctFromUsageSnapshot,
  deriveQuotaState,
  deriveSchedulableState
} = require('../account/derived-state');
const { isLoopbackUrl } = require('./http-utils');
const { cleanOauthDisplayName } = require('./account-display-identity');

const USAGE_SNAPSHOT_SCHEMA_VERSION = 2;
const USAGE_SOURCE_GEMINI = 'gemini_refresh_user_quota';
const USAGE_SOURCE_CODEX = 'codex_app_server';
const DEFAULT_THRESHOLD_PCT = 95;

function parseJsonFileSafe(filePath, fs) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readTokenFromProfileEnv(fs, profileDir, keys) {
  const envPath = path.join(profileDir, '.aih_env.json');
  const envJson = parseJsonFileSafe(envPath, fs);
  if (!envJson || typeof envJson !== 'object') return '';
  for (const key of keys) {
    const value = String(envJson[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function readGeminiAvailableModels(fs, profileDir) {
  const usagePath = path.join(profileDir, '.aih_usage.json');
  const usage = parseJsonFileSafe(usagePath, fs);
  if (!usage || usage.kind !== 'gemini_oauth_stats' || !Array.isArray(usage.models)) return [];
  return usage.models
    .map((item) => String(item && item.model || '').trim())
    .filter(Boolean);
}

function readGeminiAuthType(fs, configDir) {
  if (!configDir) return '';
  const settingsPath = path.join(configDir, 'settings.json');
  const settings = parseJsonFileSafe(settingsPath, fs);
  const selectedType = String(
    settings
    && settings.security
    && settings.security.auth
    && settings.security.auth.selectedType
    || ''
  ).trim().toLowerCase();
  return selectedType;
}

function readTokenFromGeminiConfig(fs, configDir) {
  if (!configDir) return '';
  const oauthPath = path.join(configDir, 'oauth_creds.json');
  const oauth = parseJsonFileSafe(oauthPath, fs);
  const token = String(oauth && oauth.access_token || '').trim();
  return token;
}

function readTokenFromClaudeConfig(fs, configDir) {
  if (!configDir) return '';
  const credentialsPath = path.join(configDir, '.credentials.json');
  const credentials = parseJsonFileSafe(credentialsPath, fs);
  const oauth = credentials && (credentials.claudeAiOauth || credentials.claude_ai_oauth);
  const oauthToken = String(
    (oauth && (oauth.accessToken || oauth.access_token))
    || ''
  ).trim();
  if (oauthToken) return oauthToken;

  const settingsPath = path.join(configDir, 'settings.json');
  const settings = parseJsonFileSafe(settingsPath, fs);
  const env = settings && settings.env && typeof settings.env === 'object' ? settings.env : null;
  if (!env) return '';
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '').trim();
  return authToken;
}

function readClaudeBaseUrl(fs, profileDir, configDir) {
  const envPath = path.join(profileDir, '.aih_env.json');
  const envJson = parseJsonFileSafe(envPath, fs);
  const envBaseUrl = String(envJson && envJson.ANTHROPIC_BASE_URL || '').trim();
  if (envBaseUrl) return envBaseUrl;
  if (!configDir) return '';
  const settingsPath = path.join(configDir, 'settings.json');
  const settings = parseJsonFileSafe(settingsPath, fs);
  const settingsEnv = settings && settings.env && typeof settings.env === 'object' ? settings.env : null;
  const settingsBaseUrl = String(settingsEnv && settingsEnv.ANTHROPIC_BASE_URL || '').trim();
  return settingsBaseUrl;
}

function readClaudePreferredModels(fs, configDir) {
  if (!configDir) return [];
  const settingsPath = path.join(configDir, 'settings.json');
  const settings = parseJsonFileSafe(settingsPath, fs);
  if (!settings || typeof settings !== 'object') return [];
  const out = new Set();
  const topModel = String(settings.model || settings.defaultModel || '').trim();
  if (topModel) out.add(topModel);
  const env = settings.env && typeof settings.env === 'object' ? settings.env : null;
  const envModel = String(env && (env.ANTHROPIC_MODEL || env.CLAUDE_MODEL) || '').trim();
  if (envModel) out.add(envModel);
  return Array.from(out);
}

function buildServerCodexUploadPayload(authJson) {
  if (!authJson || typeof authJson !== 'object') return null;
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  if (!tokens) return null;
  const refreshToken = String(tokens.refresh_token || '').trim();
  if (!refreshToken.startsWith('rt_')) return null;
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: String(tokens.id_token || ''),
      access_token: String(tokens.access_token || ''),
      refresh_token: refreshToken,
      account_id: String(tokens.account_id || '')
    },
    last_refresh: String(authJson.last_refresh || new Date().toISOString())
  };
}

function parseIsoTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const epochMs = Date.parse(text);
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  return epochMs;
}

function resolveCodexTokenExpiryMs(authJson) {
  if (!authJson || typeof authJson !== 'object') return null;
  const authLevelExpiry = parseIsoTimestampMs(authJson.expired);
  if (Number.isFinite(authLevelExpiry)) return authLevelExpiry;
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  const tokenLevelExpiry = parseIsoTimestampMs(tokens && tokens.expired);
  if (Number.isFinite(tokenLevelExpiry)) return tokenLevelExpiry;
  const accessToken = String(tokens && tokens.access_token || '').trim();
  return parseJwtExpiryMs(accessToken);
}

function resolveCodexOauthClientId(authJson) {
  if (!authJson || typeof authJson !== 'object') return '';
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  const accessToken = String(tokens && tokens.access_token || '').trim();
  const payload = decodeJwtPayloadUnsafe(accessToken);
  return String(payload && payload.client_id || '').trim();
}

function readUsageThresholdPct(deps) {
  const { fs, aiHomeDir } = deps;
  if (!aiHomeDir) return DEFAULT_THRESHOLD_PCT;
  const configPath = path.join(aiHomeDir, 'usage-config.json');
  const parsed = parseJsonFileSafe(configPath, fs);
  if (!parsed || typeof parsed !== 'object') return DEFAULT_THRESHOLD_PCT;
  const raw = parsed.threshold_pct ?? parsed.thresholdPct;
  const val = Number(raw);
  if (!Number.isFinite(val)) return DEFAULT_THRESHOLD_PCT;
  if (val < 1) return 1;
  if (val > 100) return 100;
  return Math.round(val);
}

function isTrustedGeminiUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) return false;
  if (snapshot.kind !== 'gemini_oauth_stats') return false;
  if (snapshot.source !== USAGE_SOURCE_GEMINI) return false;
  if (!Array.isArray(snapshot.models)) return false;
  return true;
}

function isTrustedCodexUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) return false;
  if (snapshot.kind !== 'codex_oauth_status') return false;
  if (snapshot.source !== USAGE_SOURCE_CODEX) return false;
  if (!Array.isArray(snapshot.entries)) return false;
  return true;
}

function readTrustedUsageSnapshot(deps, cliName, id) {
  const { fs, getProfileDir } = deps;
  const profileDir = getProfileDir(cliName, id);
  const cachePath = path.join(profileDir, '.aih_usage.json');
  const snapshot = parseJsonFileSafe(cachePath, fs);
  if (cliName === 'codex') {
    return normalizeTrustedCodexUsageSnapshot(fs, profileDir, isTrustedCodexUsageSnapshot(snapshot) ? snapshot : null);
  }
  if (cliName === 'gemini') {
    return isTrustedGeminiUsageSnapshot(snapshot) ? snapshot : null;
  }
  return null;
}

function hasCodexSnapshotAccountMetadata(account) {
  if (!account || typeof account !== 'object') return false;
  return Boolean(
    String(account.planType || '').trim()
    || String(account.email || '').trim()
    || String(account.accountId || '').trim()
    || String(account.organizationId || '').trim()
  );
}

function normalizeTrustedCodexUsageSnapshot(fs, profileDir, snapshot) {
  const authJson = parseJsonFileSafe(path.join(profileDir, '.codex', 'auth.json'), fs);
  if (!snapshot || typeof snapshot !== 'object') {
    return buildCodexMetadataFallbackSnapshot({
      schemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
      source: USAGE_SOURCE_CODEX,
      capturedAt: Date.now(),
      fallbackSource: 'auth_json',
      authJson
    });
  }
  if (hasCodexSnapshotAccountMetadata(snapshot.account)) return snapshot;
  const account = buildCodexSnapshotAccount(snapshot.account, authJson);
  if (!account) return snapshot;
  return {
    ...snapshot,
    account
  };
}

function readCodexRemainingPctSnapshot(deps, id) {
  return getMinRemainingPctFromUsageSnapshot(readTrustedUsageSnapshot(deps, 'codex', id));
}

function normalizeLowerText(value) {
  return String(value || '').trim().toLowerCase();
}

function shouldSkipCodexAccountForRemainingPct(remainingPct, thresholdPct) {
  if (!Number.isFinite(remainingPct)) return false;
  const configuredMinRemainingPct = Math.max(0, 100 - thresholdPct);
  return remainingPct <= configuredMinRemainingPct;
}

function getPersistedOperationalStatus(fs, profileDir, stateRow) {
  return resolveEffectiveAccountStatus(
    stateRow && stateRow.status,
    readAccountStatusFile(fs, profileDir)
  );
}

function loadCodexServerAccounts(deps) {
  const {
    fs,
    getToolAccountIds,
    listUsageCandidateIds,
    accountStateIndex,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    serverPort
  } = deps;
  const indexedIds = typeof listUsageCandidateIds === 'function' ? listUsageCandidateIds('codex') : [];
  const ids = Array.isArray(indexedIds) && indexedIds.length > 0 ? indexedIds : getToolAccountIds('codex');
  const thresholdPct = readUsageThresholdPct(deps);
  const out = [];
  ids.forEach((id) => {
    const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState('codex', id)
      : null;
    const profileDir = getProfileDir('codex', id);
    if (getPersistedOperationalStatus(fs, profileDir, stateRow) === 'down') return;
    if (typeof checkStatus === 'function') {
      const st = checkStatus('codex', profileDir);
      if (!st || !st.configured) return;
    }
    const authPath = path.join(getToolConfigDir('codex', id), 'auth.json');
    const authJson = parseJsonFileSafe(authPath, fs);
    const envPath = path.join(profileDir, '.aih_env.json');
    const envData = parseJsonFileSafe(envPath, fs);
    const openaiBaseUrl = envData && envData.OPENAI_BASE_URL ? String(envData.OPENAI_BASE_URL).trim() : '';
    const apiKey = String((envData && envData.OPENAI_API_KEY) || '').trim()
      || String((authJson && authJson.OPENAI_API_KEY) || '').trim();
    const payload = buildServerCodexUploadPayload(authJson);
    const usageSnapshot = readTrustedUsageSnapshot(deps, 'codex', id);
    const remainingPct = getMinRemainingPctFromUsageSnapshot(usageSnapshot);
    const planType = normalizeLowerText(snapshotAccountValue(usageSnapshot, 'planType'));
    const apiKeyTargetsSelf = Boolean(
      apiKey
      && openaiBaseUrl
      && Number.isFinite(Number(serverPort))
      && isLoopbackUrl(openaiBaseUrl, Number(serverPort))
    );
    const quotaState = deriveQuotaState({
      provider: 'codex',
      configured: true,
      apiKeyMode: Boolean(apiKey && !apiKeyTargetsSelf),
      planType,
      remainingPct,
      usageSnapshot
    });
    const schedulableState = deriveSchedulableState({
      provider: 'codex',
      configured: true,
      apiKeyMode: Boolean(apiKey && !apiKeyTargetsSelf),
      accountStatus: 'up',
      planType,
      remainingPct,
      usageSnapshot,
      quotaState
    });
    if (apiKey && !apiKeyTargetsSelf) {
      out.push({
        id: String(id),
        email: '',
        accountId: String(id),
        accessToken: apiKey,
        idToken: '',
        refreshToken: '',
        tokenExpiresAt: null,
        oauthClientId: '',
        codexAuthPath: authPath,
        remainingPct: null,
        lastRefresh: '',
        cooldownUntil: 0,
        quotaStatus: 'not_applicable',
        quotaReason: '',
        schedulableStatus: 'schedulable',
        schedulableReason: '',
        apiKeyMode: true,
        authType: 'api-key',
        openaiBaseUrl
      });
      return;
    }

    if (payload) {
      if (shouldSkipCodexAccountForRemainingPct(remainingPct, thresholdPct)) return;
      out.push({
        id: String(id),
        email: snapshotAccountValue(usageSnapshot, 'email'),
        accountId: snapshotAccountValue(usageSnapshot, 'accountId') || String(payload.tokens.account_id || ''),
        accessToken: String(payload.tokens.access_token || ''),
        idToken: String(payload.tokens.id_token || ''),
        refreshToken: String(payload.tokens.refresh_token || ''),
        tokenExpiresAt: resolveCodexTokenExpiryMs(authJson),
        oauthClientId: resolveCodexOauthClientId(authJson),
        codexAuthPath: authPath,
        remainingPct: Number.isFinite(remainingPct) ? Number(remainingPct) : null,
        lastRefresh: String(payload.last_refresh || ''),
        cooldownUntil: 0,
        quotaStatus: quotaState.status,
        quotaReason: quotaState.reason || '',
        schedulableStatus: schedulableState.status,
        schedulableReason: schedulableState.reason || '',
        apiKeyMode: false,
        authType: 'oauth',
        openaiBaseUrl: ''
      });
      return;
    }

    if (apiKeyTargetsSelf) return;
  });
  return out;
}

function snapshotAccountValue(snapshot, field) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.account || typeof snapshot.account !== 'object') {
    return '';
  }
  return String(snapshot.account[field] || '').trim();
}

function loadGeminiServerAccounts(deps) {
  const { fs, getToolAccountIds, listConfiguredIds, accountStateIndex, getProfileDir, checkStatus } = deps;
  const indexedIds = typeof listConfiguredIds === 'function' ? listConfiguredIds('gemini') : [];
  const ids = Array.isArray(indexedIds) && indexedIds.length > 0 ? indexedIds : getToolAccountIds('gemini');
  const out = [];
  ids.forEach((id) => {
    const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState('gemini', id)
      : null;
    const pDir = getProfileDir('gemini', id);
    if (getPersistedOperationalStatus(fs, pDir, stateRow) === 'down') return;
    const st = checkStatus('gemini', pDir);
    const configured = !!(st && st.configured);
    const accountName = st && st.accountName;
    if (!configured) return;
    const configDir = path.join(pDir, '.gemini');
    const envToken = readTokenFromProfileEnv(fs, pDir, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    const oauthToken = readTokenFromGeminiConfig(fs, configDir);
    const accessToken = envToken || oauthToken;
    const selectedAuthType = readGeminiAuthType(fs, configDir);
    const authType = selectedAuthType || (envToken ? 'gemini-api-key' : (oauthToken ? 'oauth-personal' : ''));
    const availableModels = readGeminiAvailableModels(fs, pDir);
    out.push({
      id: String(id),
      email: cleanOauthDisplayName(accountName),
      accountId: String(id),
      provider: 'gemini',
      authType,
      accessToken,
      profileDir: pDir,
      configDir,
      availableModels,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      successCount: 0,
      failCount: 0,
      lastError: ''
    });
  });
  return out;
}

function loadClaudeServerAccounts(deps) {
  const { fs, getToolAccountIds, listConfiguredIds, accountStateIndex, getProfileDir, getToolConfigDir, checkStatus } = deps;
  const indexedIds = typeof listConfiguredIds === 'function' ? listConfiguredIds('claude') : [];
  const ids = Array.isArray(indexedIds) && indexedIds.length > 0 ? indexedIds : getToolAccountIds('claude');
  const out = [];
  ids.forEach((id) => {
    const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState('claude', id)
      : null;
    const profileDir = getProfileDir('claude', id);
    if (getPersistedOperationalStatus(fs, profileDir, stateRow) === 'down') return;
    const status = checkStatus('claude', profileDir);
    if (!status || !status.configured) return;
    const accountName = String(status.accountName || '').trim();
    const configDir = getToolConfigDir('claude', id);
    const accessToken = readTokenFromProfileEnv(fs, profileDir, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
      || readTokenFromClaudeConfig(fs, configDir);
    const baseUrl = readClaudeBaseUrl(fs, profileDir, configDir);
    const availableModels = readClaudePreferredModels(fs, configDir);
    out.push({
      id: String(id),
      email: cleanOauthDisplayName(accountName),
      accountId: String(id),
      provider: 'claude',
      accessToken,
      baseUrl,
      profileDir,
      configDir,
      availableModels,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      successCount: 0,
      failCount: 0,
      lastError: ''
    });
  });
  return out;
}

function withRuntimeFields(accounts, provider) {
  return (Array.isArray(accounts) ? accounts : []).map((a) => ({
    ...normalizeAccountRuntime({
      ...a,
      provider,
      consecutiveFailures: Number(a && a.consecutiveFailures || 0),
      successCount: Number(a && a.successCount || 0),
      failCount: Number(a && a.failCount || 0),
      lastError: String((a && a.lastError) || '')
    }),
    provider,
  }));
}

function mergePersistedRuntimeFields(accounts, provider, accountStateIndex) {
  if (!accountStateIndex || typeof accountStateIndex.listStates !== 'function') {
    return Array.isArray(accounts) ? accounts : [];
  }
  const stateRows = accountStateIndex.listStates(provider);
  const stateById = new Map(
    (Array.isArray(stateRows) ? stateRows : []).map((row) => [String(row.accountId || '').trim(), row])
  );
  return (Array.isArray(accounts) ? accounts : []).map((account) => {
    const row = stateById.get(String(account && account.id || '').trim());
    if (!row || !row.runtimeState) return account;
    return applyPersistedAccountRuntimeState(account, row.runtimeState);
  });
}

function loadServerRuntimeAccounts(deps) {
  const codex = mergePersistedRuntimeFields(withRuntimeFields(loadCodexServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listUsageCandidateIds: deps.listUsageCandidateIds,
    accountStateIndex: deps.accountStateIndex,
    getToolConfigDir: deps.getToolConfigDir,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir,
    serverPort: deps.serverPort
  }), 'codex'), 'codex', deps.accountStateIndex);
  const gemini = mergePersistedRuntimeFields(withRuntimeFields(loadGeminiServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listConfiguredIds: deps.listConfiguredIds,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus
  }), 'gemini'), 'gemini', deps.accountStateIndex);
  const claude = mergePersistedRuntimeFields(withRuntimeFields(loadClaudeServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listConfiguredIds: deps.listConfiguredIds,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    checkStatus: deps.checkStatus
  }), 'claude'), 'claude', deps.accountStateIndex);
  return { codex, gemini, claude };
}

module.exports = {
  loadCodexServerAccounts,
  loadGeminiServerAccounts,
  loadClaudeServerAccounts,
  readTrustedUsageSnapshot,
  getMinRemainingPctFromUsageSnapshot,
  readCodexRemainingPctSnapshot,
  withRuntimeFields,
  loadServerRuntimeAccounts
};
