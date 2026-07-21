'use strict';

const path = require('path');
const {
  listAccountCredentialRecords,
  readAccountCredentials,
  readAccountNativeAuth
} = require('./account-credential-store');
const { resolveEffectiveAccountStatus } = require('../account/status-file');
const { readAccountUsageSnapshot } = require('../account/usage-snapshot-store');
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
  readClaudeOauthCredential,
  readClaudeCredential
} = require('../account/claude-credential');
const {
  isApiCredentialAccount,
  resolveRuntimeAuthMode
} = require('../account/runtime-auth-mode');
const { readAgyAuthMetadata } = require('../account/agy-auth-metadata');
const {
  clearRecoverableAgyAuthInvalidBlock
} = require('../account/agy-auth-recovery');
const {
  applyAgyUsageSnapshotToAccount
} = require('./agy-usage-snapshot');
const { summarizeOpenCodeAuth } = require('../account/opencode-auth-metadata');
const { getUsageConfig } = require('../usage/config-store');

const USAGE_SNAPSHOT_SCHEMA_VERSION = 2;
const USAGE_SOURCE_GEMINI = 'gemini_refresh_user_quota';
const USAGE_SOURCE_CODEX = 'codex_app_server';
const USAGE_SOURCE_AGY_CODE_ASSIST = 'agy_fetch_available_models';
const USAGE_SOURCE_CLAUDE_OAUTH = 'claude_oauth_usage_api';
const USAGE_SOURCE_CLAUDE_AUTH_TOKEN = 'claude_auth_token_usage_api';
const DEFAULT_THRESHOLD_PCT = 95;

function readTokenFromAccountEnv(fs, aiHomeDir, accountRef, keys) {
  var envJson = readAccountCredentials(fs, aiHomeDir, accountRef);
  if (!envJson || typeof envJson !== 'object') return '';
  for (var i = 0; i < keys.length; i++) {
    var value = String(envJson[keys[i]] || '').trim();
    if (value) return value;
  }
  return '';
}

function readGeminiAvailableModels(fs, aiHomeDir, accountRef) {
  const usage = readAccountUsageSnapshot(fs, aiHomeDir, accountRef);
  if (!usage || usage.kind !== 'gemini_oauth_stats' || !Array.isArray(usage.models)) return [];
  return usage.models
    .map((item) => String(item && item.model || '').trim())
    .filter(Boolean);
}

function readGeminiTokenCredentials(fs, aiHomeDir, accountRef) {
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
  const oauth = nativeAuth.oauthCreds;
  return {
    accessToken: String(oauth && oauth.access_token || '').trim(),
    refreshToken: String(oauth && oauth.refresh_token || '').trim()
  };
}

function readAgyTokenCredentials(fs, aiHomeDir, accountRef) {
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
  const oauth = nativeAuth.oauthToken;
  const token = oauth && oauth.token && typeof oauth.token === 'object'
    ? oauth.token
    : {};
  return {
    accessToken: String(token.access_token || '').trim(),
    refreshToken: String(token.refresh_token || '').trim()
  };
}

function readAgyBaseUrl(fs, aiHomeDir, accountRef) {
  var envJson = readAccountCredentials(fs, aiHomeDir, accountRef);
  return String(envJson && envJson.AGY_BASE_URL || '').trim();
}

function readClaudeBaseUrl(fs, aiHomeDir, accountRef) {
  var envJson = readAccountCredentials(fs, aiHomeDir, accountRef);
  var envBaseUrl = String(envJson && envJson.ANTHROPIC_BASE_URL || '').trim();
  return envBaseUrl;
}

function readOpenCodeAuthSummary(fs, aiHomeDir, accountRef) {
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
  const auth = nativeAuth.auth;
  return {
    authPath: 'app-state.db',
    auth,
    ...summarizeOpenCodeAuth(auth, { accountRef })
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
  const parsed = getUsageConfig({ fs, aiHomeDir });
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

function readTrustedUsageSnapshot(deps, cliName, accountRef) {
  const { fs, aiHomeDir } = deps;
  const snapshot = readAccountUsageSnapshot(fs, aiHomeDir, accountRef);
  if (cliName === 'codex') {
    return normalizeTrustedCodexUsageSnapshot(fs, aiHomeDir, accountRef, isTrustedCodexUsageSnapshot(snapshot) ? snapshot : null);
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
    || String(account.upstreamAccountId || '').trim()
    || String(account.organizationId || '').trim()
  );
}

function normalizeTrustedCodexUsageSnapshot(fs, aiHomeDir, accountRef, snapshot) {
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
  const authJson = nativeAuth.auth || null;
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

function readCodexRemainingPctSnapshot(deps, accountRef) {
  return getMinRemainingPctFromUsageSnapshot(readTrustedUsageSnapshot(deps, 'codex', accountRef));
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

function getPersistedOperationalStatus(stateRow) {
  return resolveEffectiveAccountStatus(stateRow && stateRow.status);
}

function listProviderCredentialRecords(deps, provider) {
  return listAccountCredentialRecords(deps.fs, deps.aiHomeDir, provider)
    .filter((record) => record && record.accountRef && record.provider === provider);
}

function readStateRow(accountStateIndex, accountRef) {
  return accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
}

function resolveAccountRuntimeDir(deps, provider, accountRef) {
  return typeof deps.getProfileDir === 'function'
    ? String(deps.getProfileDir(provider, accountRef) || '').trim()
    : '';
}

function loadCodexServerAccounts(deps) {
  const {
    fs,
    accountStateIndex,
    checkStatus,
    serverPort
  } = deps;
  const thresholdPct = readUsageThresholdPct(deps);
  const out = [];
  listProviderCredentialRecords(deps, 'codex').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    if (typeof checkStatus === 'function') {
      const st = checkStatus('codex', accountRef);
      if (!st || !st.configured) return;
    }
    const authPath = 'app-state.db';
    const authJson = record.nativeAuth.auth || null;
    const envData = record.env;
    const openaiBaseUrl = envData && envData.OPENAI_BASE_URL ? String(envData.OPENAI_BASE_URL).trim() : '';
    const apiKey = String((envData && envData.OPENAI_API_KEY) || '').trim()
      || String((authJson && authJson.OPENAI_API_KEY) || '').trim();
    const payload = buildServerCodexUploadPayload(authJson);
    const usageSnapshot = readTrustedUsageSnapshot(deps, 'codex', accountRef);
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
        accountRef,
        email: '',
        accessToken: apiKey,
        idToken: '',
        refreshToken: '',
        tokenExpiresAt: null,
        oauthClientId: '',
        codexAuthPath: authPath,
        profileDir: resolveAccountRuntimeDir(deps, 'codex', accountRef),
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
        accountRef,
        email: snapshotAccountValue(usageSnapshot, 'email'),
        upstreamAccountId: snapshotAccountValue(usageSnapshot, 'upstreamAccountId') || String(payload.tokens.account_id || ''),
        accessToken: String(payload.tokens.access_token || ''),
        idToken: String(payload.tokens.id_token || ''),
        refreshToken: String(payload.tokens.refresh_token || ''),
        tokenExpiresAt: resolveCodexTokenExpiryMs(authJson),
        oauthClientId: resolveCodexOauthClientId(authJson),
        codexAuthPath: authPath,
        profileDir: resolveAccountRuntimeDir(deps, 'codex', accountRef),
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
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, 'gemini').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    const st = checkStatus('gemini', accountRef);
    const configured = !!(st && st.configured);
    const accountName = st && st.accountName;
    if (!configured) return;
    const pDir = resolveAccountRuntimeDir(deps, 'gemini', accountRef);
    const configDir = pDir ? path.join(pDir, '.gemini') : '';
    const envToken = readTokenFromAccountEnv(fs, deps.aiHomeDir, accountRef, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    const oauthCredentials = readGeminiTokenCredentials(fs, deps.aiHomeDir, accountRef);
    const oauthToken = oauthCredentials.accessToken;
    const accessToken = envToken || oauthToken;
    const selectedAuthType = '';
    const geminiCodeAssistOverageStrategy = '';
    const apiKeyMode = Boolean(envToken)
      || selectedAuthType === 'gemini-api-key'
      || selectedAuthType === 'api-key';
    const authType = apiKeyMode
      ? 'api-key'
      : (selectedAuthType || ((oauthToken || oauthCredentials.refreshToken) ? 'oauth-personal' : ''));
    const availableModels = readGeminiAvailableModels(fs, deps.aiHomeDir, accountRef);
    out.push({
      accountRef,
      email: cleanOauthDisplayName(accountName),
      provider: 'gemini',
      authType,
      apiKeyMode,
      accessToken,
      refreshToken: oauthCredentials.refreshToken,
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
  const { fs, accountStateIndex, checkStatus, serverPort } = deps;
  const out = [];
  listProviderCredentialRecords(deps, 'claude').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    const status = checkStatus('claude', accountRef);
    if (!status || !status.configured) return;
    const accountName = String(status.accountName || '').trim();
    const profileDir = resolveAccountRuntimeDir(deps, 'claude', accountRef);
    const configDir = profileDir ? path.join(profileDir, '.claude') : '';
    const envJson = record.env || {};
    const credential = readClaudeCredential({ env: envJson });
    const oauthCredential = readClaudeOauthCredential(record.nativeAuth);
    const accessToken = credential.token || oauthCredential.accessToken;
    const baseUrl = readClaudeBaseUrl(fs, deps.aiHomeDir, accountRef);
    if (isSelfRelayApiKeyInfo({ apiKeyMode: Boolean(accessToken || accountName.startsWith('API Key')), baseUrl }, serverPort)) {
      return;
    }
    const availableModels = [];
    const apiKeyMode = Boolean(credential.apiKey || credential.authToken) || accountName.startsWith('API Key');
    const authType = credential.credentialType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN
      ? 'auth-token'
      : (apiKeyMode ? 'api-key' : 'oauth');
    out.push({
      accountRef,
      email: cleanOauthDisplayName(accountName),
      provider: 'claude',
      apiKeyMode,
      authType,
      credentialType: authType,
      accessToken,
      refreshToken: authType === 'oauth' ? oauthCredential.refreshToken : '',
      tokenExpiresAt: authType === 'oauth' && oauthCredential.expiresAt > 0
        ? oauthCredential.expiresAt
        : null,
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
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, 'agy').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    const status = typeof checkStatus === 'function'
      ? checkStatus('agy', accountRef)
      : readAgyAuthMetadata({ credentialRecord: record, accountRef });
    if (!status || !status.configured) return;

    const profileDir = resolveAccountRuntimeDir(deps, 'agy', accountRef);
    const configDir = profileDir ? path.join(profileDir, '.gemini', 'antigravity-cli') : '';
    const agyMetadata = readAgyAuthMetadata({ credentialRecord: record, accountRef });
    const envToken = readTokenFromAccountEnv(fs, deps.aiHomeDir, accountRef, ['AGY_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']);
    const oauthTokens = readAgyTokenCredentials(fs, deps.aiHomeDir, accountRef);
    const accessToken = envToken || oauthTokens.accessToken;
    // Allow accounts with only a refresh_token into the pool so the token daemon
    // can discover and refresh them. Without access_token the account will not
    // be dispatched by the router (accessToken guard), but it will be refreshed
    // on the next daemon tick and then start serving requests automatically.
    if (!accessToken && !oauthTokens.refreshToken) return;

    const accountName = String(status.accountName || '').trim();
    const displayName = cleanOauthDisplayName(accountName);
    const usageSnapshot = readTrustedUsageSnapshot(deps, 'agy', accountRef);
    const account = {
      accountRef,
      email: displayName.includes('@') ? displayName : '',
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
      baseUrl: readAgyBaseUrl(fs, deps.aiHomeDir, accountRef),
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
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, 'opencode').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    const status = typeof checkStatus === 'function'
      ? checkStatus('opencode', accountRef)
      : { configured: false };
    const authSummary = readOpenCodeAuthSummary(fs, deps.aiHomeDir, accountRef);
    if (!(status && status.configured) && !authSummary.configured) return;
    const providers = authSummary.providers.length > 0
      ? authSummary.providers
      : (Array.isArray(status && status.providers) ? status.providers : []);
    const profileDir = resolveAccountRuntimeDir(deps, 'opencode', accountRef);
    out.push({
      accountRef,
      email: '',
      provider: 'opencode',
      authType: 'opencode-auth',
      apiKeyMode: false,
      accessToken: 'opencode-local',
      displayName: authSummary.accountName || status.accountName || 'OpenCode Account',
      profileDir,
      configDir: profileDir ? path.join(profileDir, '.config', 'opencode') : '',
      dataDir: path.join(profileDir, '.local', 'share', 'opencode'),
      authPath: authSummary.authPath,
      opencodeAuth: authSummary.auth,
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

const GROK_DEFAULT_BASE_URL = 'https://api.x.ai/v1';

function loadGrokServerAccounts(deps) {
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, 'grok').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    if (typeof checkStatus === 'function') {
      const st = checkStatus('grok', accountRef);
      if (!st || !st.configured) return;
    }
    const envData = record.env || {};
    const apiKey = String(envData.XAI_API_KEY || '').trim();
    const baseUrl = String(envData.XAI_BASE_URL || '').trim() || GROK_DEFAULT_BASE_URL;
    const nativeAuth = record.nativeAuth && record.nativeAuth.auth;
    const oauthToken = nativeAuth && String(nativeAuth.access_token || nativeAuth.accessToken || '').trim();
    const accessToken = apiKey || oauthToken;
    if (!accessToken) return;
    const apiKeyMode = Boolean(apiKey);
    const profileDir = resolveAccountRuntimeDir(deps, 'grok', accountRef);
    out.push({
      accountRef,
      email: '',
      provider: 'grok',
      authType: apiKeyMode ? 'api-key' : 'oauth',
      apiKeyMode,
      accessToken,
      openaiBaseUrl: baseUrl,
      displayName: apiKeyMode ? `API Key (${baseUrl})` : 'Grok OAuth',
      profileDir,
      configDir: profileDir ? path.join(profileDir, '.grok') : '',
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

const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1';

function loadKimiServerAccounts(deps) {
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, 'kimi').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    if (typeof checkStatus === 'function') {
      const st = checkStatus('kimi', accountRef);
      if (!st || !st.configured) return;
    }
    const envData = record.env || {};
    const apiKey = String(envData.MOONSHOT_API_KEY || '').trim();
    const baseUrl = String(envData.KIMI_BASE_URL || '').trim() || KIMI_DEFAULT_BASE_URL;
    const nativeAuth = record.nativeAuth && record.nativeAuth.auth;
    const oauthToken = nativeAuth && String(nativeAuth.access_token || nativeAuth.accessToken || '').trim();
    const accessToken = apiKey || oauthToken;
    if (!accessToken) return;
    const apiKeyMode = Boolean(apiKey);
    const profileDir = resolveAccountRuntimeDir(deps, 'kimi', accountRef);
    out.push({
      accountRef,
      email: '',
      provider: 'kimi',
      authType: apiKeyMode ? 'api-key' : 'oauth',
      apiKeyMode,
      accessToken,
      openaiBaseUrl: baseUrl,
      displayName: apiKeyMode ? `API Key (${baseUrl})` : 'Kimi OAuth',
      profileDir,
      configDir: profileDir ? path.join(profileDir, '.kimi-code') : '',
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

const KIRO_DEFAULT_BASE_URL = 'https://q.us-east-1.amazonaws.com';

function loadKiroServerAccounts(deps) {
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, 'kiro').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    if (typeof checkStatus === 'function') {
      const st = checkStatus('kiro', accountRef);
      if (!st || !st.configured) return;
    }
    const envData = record.env || {};
    const baseUrl = String(envData.KIRO_BASE_URL || '').trim() || KIRO_DEFAULT_BASE_URL;
    const nativeAuth = record.nativeAuth && record.nativeAuth.auth;
    const oauthToken = nativeAuth && String(nativeAuth.access_token || nativeAuth.accessToken || '').trim();
    if (!oauthToken) return;
    const profileDir = resolveAccountRuntimeDir(deps, 'kiro', accountRef);
    out.push({
      accountRef,
      email: '',
      provider: 'kiro',
      authType: 'oauth',
      apiKeyMode: false,
      accessToken: oauthToken,
      openaiBaseUrl: baseUrl,
      displayName: 'Kiro (AWS Builder ID)',
      profileDir,
      configDir: profileDir ? path.join(profileDir, '.kiro') : '',
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
      lastError: '',
      experimental: true
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
  return String(row.authMode || '').trim().toLowerCase();
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
  return accountStateService.clearRuntimeBlock(account.accountRef, provider, {
    ...buildRuntimeBaseStateForAccount(account),
    evidence: 'credential_config_verified'
  });
}

function clearStaleAgyAuthInvalidBlock(provider, account, row, accountStateService) {
  if (!row || !row.runtimeState) return false;
  return clearRecoverableAgyAuthInvalidBlock({
    provider,
    accountRef: account && account.accountRef,
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
  return accountStateService.clearRuntimeBlock(account.accountRef, provider, {
    ...buildRuntimeBaseStateForAccount(account),
    evidence: 'agy_usage_probe_verified'
  });
}

function mergePersistedRuntimeFields(accounts, provider, accountStateIndex, accountStateService) {
  if (!accountStateIndex || typeof accountStateIndex.listStates !== 'function') {
    return Array.isArray(accounts) ? accounts : [];
  }
  const stateRows = accountStateIndex.listStates(provider);
  const stateByRef = new Map(
    (Array.isArray(stateRows) ? stateRows : []).map((row) => [String(row.accountRef || '').trim(), row])
  );
  return (Array.isArray(accounts) ? accounts : []).map((account) => {
    const row = stateByRef.get(String(account && account.accountRef || '').trim());
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
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir,
    serverPort: deps.serverPort
  }), 'codex'), 'codex', deps.accountStateIndex, deps.accountStateService);
  const gemini = mergePersistedRuntimeFields(withRuntimeFields(loadGeminiServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'gemini'), 'gemini', deps.accountStateIndex, deps.accountStateService);
  const claude = mergePersistedRuntimeFields(withRuntimeFields(loadClaudeServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir,
    serverPort: deps.serverPort
  }), 'claude'), 'claude', deps.accountStateIndex, deps.accountStateService);
  const agy = mergePersistedRuntimeFields(withRuntimeFields(loadAgyServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'agy'), 'agy', deps.accountStateIndex, deps.accountStateService);
  const opencode = mergePersistedRuntimeFields(withRuntimeFields(loadOpenCodeServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'opencode'), 'opencode', deps.accountStateIndex, deps.accountStateService);
  const grok = mergePersistedRuntimeFields(withRuntimeFields(loadGrokServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'grok'), 'grok', deps.accountStateIndex, deps.accountStateService);
  const kimi = mergePersistedRuntimeFields(withRuntimeFields(loadKimiServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'kimi'), 'kimi', deps.accountStateIndex, deps.accountStateService);
  const kiro = mergePersistedRuntimeFields(withRuntimeFields(loadKiroServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'kiro'), 'kiro', deps.accountStateIndex, deps.accountStateService);
  return { codex, gemini, claude, agy, opencode, grok, kimi, kiro };
}

module.exports = {
  loadCodexServerAccounts,
  loadGeminiServerAccounts,
  loadClaudeServerAccounts,
  loadAgyServerAccounts,
  loadOpenCodeServerAccounts,
  loadGrokServerAccounts,
  loadKimiServerAccounts,
  loadKiroServerAccounts,
  readTrustedUsageSnapshot,
  getMinRemainingPctFromUsageSnapshot,
  readCodexRemainingPctSnapshot,
  withRuntimeFields,
  loadServerRuntimeAccounts
};
