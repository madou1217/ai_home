'use strict';

const path = require('path');
const {
  readAccountStatusFile,
  resolveEffectiveAccountStatus
} = require('../account/status-file');
const {
  normalizeAccountRuntime,
  applyPersistedAccountRuntimeState,
  deriveAccountRuntimeStatus
} = require('./account-runtime-state');
const {
  decodeJwtPayloadUnsafe,
  normalizeCodexRefreshToken,
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
const {
  cleanOauthDisplayName,
  getApiKeyDisplayName
} = require('./account-display-identity');
const {
  isSelfRelayApiKeyInfo
} = require('../account/self-relay-account');
const {
  CLAUDE_CREDENTIAL_TYPES,
  readClaudeCredential
} = require('../account/claude-credential');
const {
  isApiCredentialAccount,
  resolveRuntimeAuthMode
} = require('../account/runtime-auth-mode');
const { readAgyAuthMetadata } = require('../account/agy-auth-metadata');
const { resolveAccountUniqueKey } = require('../account/account-identity');
const { upsertAccountRef } = require('./account-ref-store');
const {
  clearRecoverableAgyAuthInvalidBlock
} = require('../account/agy-auth-recovery');
const {
  applyAgyUsageSnapshotToAccount
} = require('./agy-usage-snapshot');
const { summarizeOpenCodeAuth } = require('../account/opencode-auth-metadata');

const USAGE_SNAPSHOT_SCHEMA_VERSION = 2;
const USAGE_SOURCE_GEMINI = 'gemini_refresh_user_quota';
const USAGE_SOURCE_CODEX = 'codex_app_server';
const USAGE_SOURCE_AGY_CODE_ASSIST = 'agy_fetch_available_models';
const USAGE_SOURCE_CLAUDE_OAUTH = 'claude_oauth_usage_api';
const USAGE_SOURCE_CLAUDE_AUTH_TOKEN = 'claude_auth_token_usage_api';
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

function readGeminiBillingOverageStrategy(fs, configDir) {
  if (!configDir) return '';
  const settingsPath = path.join(configDir, 'settings.json');
  const settings = parseJsonFileSafe(settingsPath, fs);
  const strategy = String(
    settings
    && settings.billing
    && settings.billing.overageStrategy
    || ''
  ).trim().toLowerCase();
  if (strategy === 'always' || strategy === 'ask' || strategy === 'never') return strategy;
  return '';
}

function readTokenFromGeminiConfig(fs, configDir) {
  if (!configDir) return '';
  const oauthPath = path.join(configDir, 'oauth_creds.json');
  const oauth = parseJsonFileSafe(oauthPath, fs);
  const token = String(oauth && oauth.access_token || '').trim();
  return token;
}

function readAgyTokenCredentials(fs, configDir) {
  if (!configDir) return { accessToken: '', refreshToken: '' };
  const tokenPath = path.join(configDir, 'antigravity-oauth-token');
  const oauth = parseJsonFileSafe(tokenPath, fs);
  const token = oauth && oauth.token && typeof oauth.token === 'object'
    ? oauth.token
    : {};
  return {
    accessToken: String(token.access_token || '').trim(),
    refreshToken: String(token.refresh_token || '').trim()
  };
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
  return readClaudeCredential({ settingsEnv: env }).token;
}

function readAgyBaseUrl(fs, profileDir) {
  const envPath = path.join(profileDir, '.aih_env.json');
  const envJson = parseJsonFileSafe(envPath, fs);
  return String(envJson && envJson.AGY_BASE_URL || '').trim();
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

function readOpenCodeAuthSummary(fs, profileDir) {
  const authPath = path.join(profileDir, '.local', 'share', 'opencode', 'auth.json');
  const auth = parseJsonFileSafe(authPath, fs);
  return {
    authPath,
    ...summarizeOpenCodeAuth(auth, { accountId: path.basename(profileDir) })
  };
}

function buildServerCodexUploadPayload(authJson) {
  if (!authJson || typeof authJson !== 'object') return null;
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  if (!tokens) return null;
  const refreshToken = normalizeCodexRefreshToken(tokens.refresh_token);
  if (!refreshToken) return null;
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
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  const accessToken = String(tokens && tokens.access_token || '').trim();
  const accessTokenExpiry = parseJwtExpiryMs(accessToken);
  if (Number.isFinite(accessTokenExpiry)) return accessTokenExpiry;
  const authLevelExpiry = parseIsoTimestampMs(authJson.expired);
  if (Number.isFinite(authLevelExpiry)) return authLevelExpiry;
  const tokenLevelExpiry = parseIsoTimestampMs(tokens && tokens.expired);
  if (Number.isFinite(tokenLevelExpiry)) return tokenLevelExpiry;
  return null;
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

function isTrustedAgyUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) return false;
  if (snapshot.kind !== 'agy_code_assist_quota') return false;
  if (snapshot.source !== USAGE_SOURCE_AGY_CODE_ASSIST) return false;
  if (!Array.isArray(snapshot.models)) return false;
  return true;
}

function isTrustedClaudeUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) return false;
  if (snapshot.kind !== 'claude_oauth_usage') return false;
  if (snapshot.source !== USAGE_SOURCE_CLAUDE_OAUTH && snapshot.source !== USAGE_SOURCE_CLAUDE_AUTH_TOKEN) return false;
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
  if (cliName === 'agy') {
    return isTrustedAgyUsageSnapshot(snapshot) ? snapshot : null;
  }
  if (cliName === 'claude') {
    return isTrustedClaudeUsageSnapshot(snapshot) ? snapshot : null;
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
  const account = buildCodexSnapshotAccount(snapshot.account, authJson);
  if (!account) return snapshot;
  if (
    hasCodexSnapshotAccountMetadata(snapshot.account)
    && JSON.stringify(account) === JSON.stringify(snapshot.account)
  ) {
    return snapshot;
  }
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

function shouldBlockCodexAccountForRemainingPct(remainingPct, thresholdPct) {
  if (!Number.isFinite(remainingPct)) return false;
  const configuredMinRemainingPct = Math.max(0, 100 - thresholdPct);
  return remainingPct <= configuredMinRemainingPct;
}

function applyCodexServerUsageThreshold(schedulableState, remainingPct, thresholdPct) {
  if (!schedulableState || schedulableState.status !== 'schedulable') return schedulableState;
  if (!shouldBlockCodexAccountForRemainingPct(remainingPct, thresholdPct)) return schedulableState;
  return {
    status: 'blocked_by_policy',
    reason: 'codex_usage_below_server_threshold'
  };
}

function getPersistedOperationalStatus(fs, profileDir, stateRow) {
  return resolveEffectiveAccountStatus(
    stateRow && stateRow.status,
    readAccountStatusFile(fs, profileDir)
  );
}

function mergeAccountIds(...lists) {
  return Array.from(new Set(
    lists
      .flatMap((list) => Array.isArray(list) ? list : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  ));
}

function loadCodexServerAccounts(deps) {
  const {
    fs,
    getToolAccountIds,
    listUsageCandidateIds,
    listConfiguredIds,
    accountStateIndex,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    serverPort
  } = deps;
  const indexedIds = typeof listUsageCandidateIds === 'function' ? listUsageCandidateIds('codex') : [];
  const configuredIds = typeof listConfiguredIds === 'function' ? listConfiguredIds('codex') : [];
  const ids = mergeAccountIds(indexedIds, configuredIds, getToolAccountIds('codex'));
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
      openaiBaseUrl
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
    const schedulableState = applyCodexServerUsageThreshold(deriveSchedulableState({
      provider: 'codex',
      configured: true,
      apiKeyMode: Boolean(apiKey && !apiKeyTargetsSelf),
      accountStatus: 'up',
      planType,
      remainingPct,
      usageSnapshot,
      quotaState
    }), remainingPct, thresholdPct);
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
        displayName: getApiKeyDisplayName('codex', { baseUrl: openaiBaseUrl }),
        openaiBaseUrl
      });
      return;
    }

    if (payload) {
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
  const ids = mergeAccountIds(indexedIds, getToolAccountIds('gemini'));
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
    const geminiCodeAssistOverageStrategy = readGeminiBillingOverageStrategy(fs, configDir);
    const apiKeyMode = Boolean(envToken)
      || selectedAuthType === 'gemini-api-key'
      || selectedAuthType === 'api-key';
    const authType = apiKeyMode ? 'api-key' : (selectedAuthType || (oauthToken ? 'oauth-personal' : ''));
    const availableModels = readGeminiAvailableModels(fs, pDir);
    out.push({
      id: String(id),
      email: cleanOauthDisplayName(accountName),
      accountId: String(id),
      provider: 'gemini',
      authType,
      apiKeyMode,
      accessToken,
      profileDir: pDir,
      configDir,
      availableModels,
      geminiCodeAssistOverageStrategy,
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
  const { fs, getToolAccountIds, listConfiguredIds, accountStateIndex, getProfileDir, getToolConfigDir, checkStatus, serverPort } = deps;
  const indexedIds = typeof listConfiguredIds === 'function' ? listConfiguredIds('claude') : [];
  const ids = mergeAccountIds(indexedIds, getToolAccountIds('claude'));
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
    const envJson = parseJsonFileSafe(path.join(profileDir, '.aih_env.json'), fs) || {};
    const settings = parseJsonFileSafe(path.join(configDir, 'settings.json'), fs) || {};
    const settingsEnv = settings && settings.env && typeof settings.env === 'object' ? settings.env : {};
    const credential = readClaudeCredential({ env: envJson, settingsEnv });
    const accessToken = credential.token || readTokenFromClaudeConfig(fs, configDir);
    const baseUrl = readClaudeBaseUrl(fs, profileDir, configDir);
    if (isSelfRelayApiKeyInfo({ apiKeyMode: Boolean(accessToken || accountName.startsWith('API Key')), baseUrl }, serverPort)) {
      return;
    }
    const availableModels = readClaudePreferredModels(fs, configDir);
    const apiKeyMode = Boolean(credential.apiKey || credential.authToken) || accountName.startsWith('API Key');
    const authType = credential.credentialType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN
      ? 'auth-token'
      : (apiKeyMode ? 'api-key' : 'oauth');
    out.push({
      id: String(id),
      email: cleanOauthDisplayName(accountName),
      accountId: String(id),
      provider: 'claude',
      apiKeyMode,
      authType,
      credentialType: authType,
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

function loadAgyServerAccounts(deps) {
  const { fs, getToolAccountIds, listConfiguredIds, accountStateIndex, getProfileDir, getToolConfigDir, checkStatus } = deps;
  const indexedIds = typeof listConfiguredIds === 'function' ? listConfiguredIds('agy') : [];
  const ids = mergeAccountIds(indexedIds, getToolAccountIds('agy'));
  const out = [];
  ids.forEach((id) => {
    const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState('agy', id)
      : null;
    const profileDir = getProfileDir('agy', id);
    if (getPersistedOperationalStatus(fs, profileDir, stateRow) === 'down') return;
    const status = typeof checkStatus === 'function'
      ? checkStatus('agy', profileDir)
      : readAgyAuthMetadata(fs, path, profileDir);
    if (!status || !status.configured) return;

    const configDir = getToolConfigDir('agy', id);
    const agyMetadata = readAgyAuthMetadata(fs, path, profileDir);
    const envToken = readTokenFromProfileEnv(fs, profileDir, ['AGY_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']);
    const oauthTokens = readAgyTokenCredentials(fs, configDir);
    const accessToken = envToken || oauthTokens.accessToken;
    // Allow accounts with only a refresh_token into the pool so the token daemon
    // can discover and refresh them. Without access_token the account will not
    // be dispatched by the router (accessToken guard), but it will be refreshed
    // on the next daemon tick and then start serving requests automatically.
    if (!accessToken && !oauthTokens.refreshToken) return;

    const accountName = String(status.accountName || '').trim();
    const displayName = cleanOauthDisplayName(accountName);
    const usageSnapshot = readTrustedUsageSnapshot(deps, 'agy', id);
    const account = {
      id: String(id),
      email: displayName.includes('@') ? displayName : '',
      accountId: String(id),
      provider: 'agy',
      authType: 'oauth-personal',
      apiKeyMode: false,
      accessToken,
      refreshToken: oauthTokens.refreshToken,
      authMetadata: {
        ...agyMetadata,
        ...status
      },
      tokenExpiresAt: Number(status.tokenExpiresAt || agyMetadata.tokenExpiresAt) || null,
      baseUrl: readAgyBaseUrl(fs, profileDir),
      profileDir,
      configDir,
      availableModels: [],
      cooldownUntil: 0,
      consecutiveFailures: 0,
      successCount: 0,
      failCount: 0,
      lastError: ''
    };
    applyAgyUsageSnapshotToAccount(account, usageSnapshot);
    out.push(account);
  });
  return out;
}

function loadOpenCodeServerAccounts(deps) {
  const { fs, getToolAccountIds, listConfiguredIds, accountStateIndex, getProfileDir, getToolConfigDir, checkStatus } = deps;
  const indexedIds = typeof listConfiguredIds === 'function' ? listConfiguredIds('opencode') : [];
  const ids = mergeAccountIds(indexedIds, getToolAccountIds('opencode'));
  const out = [];
  ids.forEach((id) => {
    const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState('opencode', id)
      : null;
    const profileDir = getProfileDir('opencode', id);
    if (getPersistedOperationalStatus(fs, profileDir, stateRow) === 'down') return;
    const status = typeof checkStatus === 'function'
      ? checkStatus('opencode', profileDir)
      : { configured: false };
    const authSummary = readOpenCodeAuthSummary(fs, profileDir);
    if (!(status && status.configured) && !authSummary.configured) return;
    const providers = authSummary.providers.length > 0
      ? authSummary.providers
      : (Array.isArray(status && status.providers) ? status.providers : []);
    out.push({
      id: String(id),
      email: '',
      accountId: String(id),
      provider: 'opencode',
      authType: 'opencode-auth',
      apiKeyMode: false,
      accessToken: 'opencode-local',
      displayName: authSummary.accountName || status.accountName || 'OpenCode Account',
      profileDir,
      configDir: getToolConfigDir('opencode', id),
      dataDir: path.join(profileDir, '.local', 'share', 'opencode'),
      authPath: authSummary.authPath,
      connectedProviders: providers,
      availableModels: [],
      remainingPct: null,
      quotaStatus: 'not_applicable',
      quotaReason: '',
      schedulableStatus: 'schedulable',
      schedulableReason: '',
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

function readRowAuthMode(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.authMode || row.auth_mode || '').trim().toLowerCase();
}

function isApiCredentialRuntimeAccount(account) {
  return isApiCredentialAccount(account);
}

function isMigratableCredentialAuthInvalidBlock(account, row, nowMs = Date.now()) {
  const runtimeState = row && row.runtimeState;
  if (!isApiCredentialRuntimeAccount(account) || !runtimeState) return false;
  if (readRowAuthMode(row) === resolveRuntimeAuthMode(account)) return false;
  return deriveAccountRuntimeStatus(runtimeState, nowMs).status === 'auth_invalid';
}

function buildRuntimeBaseStateForAccount(account) {
  const authMode = resolveRuntimeAuthMode(account);
  return {
    status: String(account && account.status || 'up').trim() || 'up',
    configured: true,
    apiKeyMode: isApiCredentialRuntimeAccount(account),
    authMode,
    displayName: String(account && (account.displayName || account.email) || '').trim()
  };
}

function clearStaleCredentialAuthInvalidBlock(provider, account, accountStateService) {
  if (!accountStateService || typeof accountStateService.clearRuntimeBlock !== 'function') return false;
  return accountStateService.clearRuntimeBlock(provider, account.id, {
    ...buildRuntimeBaseStateForAccount(account),
    evidence: 'credential_config_verified'
  });
}

function clearStaleAgyAuthInvalidBlock(provider, account, row, accountStateService) {
  if (!row || !row.runtimeState) return false;
  return clearRecoverableAgyAuthInvalidBlock({
    provider,
    accountId: account && account.id,
    runtimeStatus: deriveAccountRuntimeStatus(row.runtimeState),
    authMetadata: account && account.authMetadata,
    accountStateService,
    baseState: buildRuntimeBaseStateForAccount(account)
  });
}

// 探测成功自动清 auth_invalid：agy 账号若在被标记 auth_invalid 之后又有一次成功的用量快照
// （codeAssistQuotaCapturedAt 晚于 lastFailureAt），说明凭据现已有效、该 auth_invalid 是过时状态，直接清除。
// 这是"探测成功即证明已登录"的直接证据，能推翻早前的 agy_not_signed_in 等误判，无需用户手动清冷却。
function clearAgyAuthInvalidOnFreshUsageProbe(provider, account, row, accountStateService) {
  if (String(provider || '').trim().toLowerCase() !== 'agy') return false;
  if (!row || !row.runtimeState || !account) return false;
  if (!accountStateService || typeof accountStateService.clearRuntimeBlock !== 'function') return false;
  if (deriveAccountRuntimeStatus(row.runtimeState).status !== 'auth_invalid') return false;
  const capturedAt = Number(account.codeAssistQuotaCapturedAt) || 0;
  const lastFailureAt = Number(row.runtimeState.lastFailureAt) || 0;
  // 成功探测必须晚于失败记录，才能确认是"失败后又成功"（避免清掉真实的新失败）。
  if (capturedAt <= 0 || capturedAt < lastFailureAt) return false;
  return accountStateService.clearRuntimeBlock(provider, account.id, {
    ...buildRuntimeBaseStateForAccount(account),
    evidence: 'agy_usage_probe_verified'
  });
}

function mergePersistedRuntimeFields(accounts, provider, accountStateIndex, accountStateService) {
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
    if (
      isMigratableCredentialAuthInvalidBlock(account, row)
      && clearStaleCredentialAuthInvalidBlock(provider, account, accountStateService)
    ) {
      return account;
    }
    if (clearStaleAgyAuthInvalidBlock(provider, account, row, accountStateService)) {
      return account;
    }
    if (clearAgyAuthInvalidOnFreshUsageProbe(provider, account, row, accountStateService)) {
      return account;
    }
    return applyPersistedAccountRuntimeState(account, row.runtimeState);
  });
}

function loadServerRuntimeAccounts(deps) {
  const codex = mergePersistedRuntimeFields(withRuntimeFields(loadCodexServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listUsageCandidateIds: deps.listUsageCandidateIds,
    listConfiguredIds: deps.listConfiguredIds,
    accountStateIndex: deps.accountStateIndex,
    getToolConfigDir: deps.getToolConfigDir,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir,
    serverPort: deps.serverPort
  }), 'codex'), 'codex', deps.accountStateIndex, deps.accountStateService);
  const gemini = mergePersistedRuntimeFields(withRuntimeFields(loadGeminiServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listConfiguredIds: deps.listConfiguredIds,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus
  }), 'gemini'), 'gemini', deps.accountStateIndex, deps.accountStateService);
  const claude = mergePersistedRuntimeFields(withRuntimeFields(loadClaudeServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listConfiguredIds: deps.listConfiguredIds,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    checkStatus: deps.checkStatus,
    serverPort: deps.serverPort
  }), 'claude'), 'claude', deps.accountStateIndex, deps.accountStateService);
  const agy = mergePersistedRuntimeFields(withRuntimeFields(loadAgyServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listConfiguredIds: deps.listConfiguredIds,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    checkStatus: deps.checkStatus
  }), 'agy'), 'agy', deps.accountStateIndex, deps.accountStateService);
  const opencode = mergePersistedRuntimeFields(withRuntimeFields(loadOpenCodeServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listConfiguredIds: deps.listConfiguredIds,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    checkStatus: deps.checkStatus
  }), 'opencode'), 'opencode', deps.accountStateIndex, deps.accountStateService);
  const result = { codex, gemini, claude, agy, opencode };
  stampRuntimeAccountUniqueKeys(result, deps);
  return result;
}

// Stamp each runtime account with its stable uniqueKey/accountRef once per reload, so the
// hot read paths (model-capability-index, gateway) can match persisted
// per-account settings by identity without re-reading creds per request.
function stampRuntimeAccountUniqueKeys(accountsByProvider, deps) {
  if (!deps || !deps.fs || !deps.aiHomeDir || typeof deps.getProfileDir !== 'function' || typeof deps.getToolConfigDir !== 'function') {
    return;
  }
  for (const provider of Object.keys(accountsByProvider)) {
    for (const account of accountsByProvider[provider]) {
      const accountId = String((account && (account.id || account.accountId)) || '').trim();
      if (!accountId) continue;
      try {
        const resolved = resolveAccountUniqueKey({
          fs: deps.fs,
          path,
          provider,
          accountId,
          getProfileDir: deps.getProfileDir,
          getToolConfigDir: deps.getToolConfigDir,
          identityKind: isApiCredentialAccount(account) ? resolveRuntimeAuthMode(account) : undefined
        });
        account.uniqueKey = resolved && !resolved.degraded ? resolved.uniqueKey : '';
        account.accountRef = account.uniqueKey
          ? upsertAccountRef(deps.fs, deps.aiHomeDir, {
            ...account,
            provider,
            accountId,
            uniqueKey: account.uniqueKey
          }, { bestEffort: true })
          : '';
      } catch (_error) {
        account.uniqueKey = '';
        account.accountRef = '';
      }
    }
  }
}

module.exports = {
  loadCodexServerAccounts,
  loadGeminiServerAccounts,
  loadClaudeServerAccounts,
  loadAgyServerAccounts,
  loadOpenCodeServerAccounts,
  readTrustedUsageSnapshot,
  getMinRemainingPctFromUsageSnapshot,
  readCodexRemainingPctSnapshot,
  withRuntimeFields,
  loadServerRuntimeAccounts
};
