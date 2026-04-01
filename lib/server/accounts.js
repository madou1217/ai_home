'use strict';

const path = require('path');

const USAGE_SNAPSHOT_SCHEMA_VERSION = 2;
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

function decodeJwtPayloadUnsafe(jwt) {
  const text = String(jwt || '').trim();
  const parts = text.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
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

function isTrustedCodexUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) return false;
  if (snapshot.kind !== 'codex_oauth_status') return false;
  if (snapshot.source !== USAGE_SOURCE_CODEX) return false;
  if (!Array.isArray(snapshot.entries)) return false;
  return true;
}

function readCodexRemainingPctSnapshot(deps, id) {
  const { fs, getProfileDir } = deps;
  const profileDir = getProfileDir('codex', id);
  const cachePath = path.join(profileDir, '.aih_usage.json');
  const snapshot = parseJsonFileSafe(cachePath, fs);
  if (!isTrustedCodexUsageSnapshot(snapshot)) return null;
  const values = snapshot.entries
    .map((x) => Number(x && x.remainingPct))
    .filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;
  return Math.max(0, Math.min(100, Math.min(...values)));
}

function loadCodexServerAccounts(deps) {
  const {
    fs,
    getToolAccountIds,
    listUsageCandidateIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus
  } = deps;
  const indexedIds = typeof listUsageCandidateIds === 'function' ? listUsageCandidateIds('codex') : [];
  const ids = Array.isArray(indexedIds) && indexedIds.length > 0 ? indexedIds : getToolAccountIds('codex');
  const thresholdPct = readUsageThresholdPct(deps);
  const minRemainingPct = Math.max(0, 100 - thresholdPct);
  const out = [];
  ids.forEach((id) => {
    const profileDir = getProfileDir('codex', id);
    if (typeof checkStatus === 'function') {
      const st = checkStatus('codex', profileDir);
      if (!st || !st.configured) return;
    }
    const authPath = path.join(getToolConfigDir('codex', id), 'auth.json');
    const authJson = parseJsonFileSafe(authPath, fs);
    const payload = buildServerCodexUploadPayload(authJson);
    if (!payload) return;
    const remainingPct = readCodexRemainingPctSnapshot(deps, id);
    if (Number.isFinite(remainingPct) && remainingPct <= minRemainingPct) return;
    const jwtPayload = decodeJwtPayloadUnsafe(payload.tokens.id_token);
    const email = jwtPayload && typeof jwtPayload.email === 'string' ? jwtPayload.email : '';
    out.push({
      id: String(id),
      email,
      accountId: String(payload.tokens.account_id || ''),
      accessToken: String(payload.tokens.access_token || ''),
      idToken: String(payload.tokens.id_token || ''),
      refreshToken: String(payload.tokens.refresh_token || ''),
      tokenExpiresAt: resolveCodexTokenExpiryMs(authJson),
      oauthClientId: resolveCodexOauthClientId(authJson),
      codexAuthPath: authPath,
      remainingPct: Number.isFinite(remainingPct) ? Number(remainingPct) : null,
      lastRefresh: String(payload.last_refresh || ''),
      cooldownUntil: 0
    });
  });
  return out;
}

function loadGeminiServerAccounts(deps) {
  const { fs, getToolAccountIds, listConfiguredIds, getProfileDir, checkStatus } = deps;
  const indexedIds = typeof listConfiguredIds === 'function' ? listConfiguredIds('gemini') : [];
  const ids = Array.isArray(indexedIds) && indexedIds.length > 0 ? indexedIds : getToolAccountIds('gemini');
  const out = [];
  ids.forEach((id) => {
    const pDir = getProfileDir('gemini', id);
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
      email: accountName && accountName !== 'Unknown' ? accountName : '',
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
  const { fs, getToolAccountIds, listConfiguredIds, getProfileDir, getToolConfigDir, checkStatus } = deps;
  const indexedIds = typeof listConfiguredIds === 'function' ? listConfiguredIds('claude') : [];
  const ids = Array.isArray(indexedIds) && indexedIds.length > 0 ? indexedIds : getToolAccountIds('claude');
  const out = [];
  ids.forEach((id) => {
    const profileDir = getProfileDir('claude', id);
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
      email: accountName && accountName !== 'Unknown' ? accountName : '',
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
    ...a,
    provider,
    consecutiveFailures: Number(a && a.consecutiveFailures || 0),
    successCount: Number(a && a.successCount || 0),
    failCount: Number(a && a.failCount || 0),
    lastError: String((a && a.lastError) || '')
  }));
}

function loadServerRuntimeAccounts(deps) {
  const codex = withRuntimeFields(loadCodexServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listUsageCandidateIds: deps.listUsageCandidateIds,
    getToolConfigDir: deps.getToolConfigDir,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'codex');
  const gemini = withRuntimeFields(loadGeminiServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listConfiguredIds: deps.listConfiguredIds,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus
  }), 'gemini');
  const claude = withRuntimeFields(loadClaudeServerAccounts({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    listConfiguredIds: deps.listConfiguredIds,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    checkStatus: deps.checkStatus
  }), 'claude');
  return { codex, gemini, claude };
}

module.exports = {
  loadCodexServerAccounts,
  loadGeminiServerAccounts,
  loadClaudeServerAccounts,
  withRuntimeFields,
  loadServerRuntimeAccounts
};
