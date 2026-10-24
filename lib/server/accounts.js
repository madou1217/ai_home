'use strict';

const { resolveCodexWorkspaceFields } = require('../account/codex-auth-metadata');
const { codexCredentialFingerprint } = require('../account/codex-credential-freshness');
const { describeKiroAccount } = require('../account/kiro-account-label');

const path = require('path');
const {
  listAccountCredentialRecords,
  readAccountCredentialRecord,
  readAccountCredentials,
  readAccountNativeAuth
} = require('./account-credential-store');
const { resolveEffectiveAccountStatus } = require('../account/status-file');
const { readAccountUsageSnapshot } = require('../account/usage-snapshot-store');
const { readEffectiveUpstreamErrorRules } = require('../account/upstream-error-rules');
const { readAliasPoolParticipationMap } = require('../account/alias-pool-store');
const { readUpstreamErrorMappingGroups } = require('./upstream-error-mapping-store');
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
  deriveSchedulableState,
  resolveMinimumRemainingPct
} = require('../account/derived-state');
const { isLoopbackUrl } = require('./http-utils');
const { resolveUpstreamProfileFromEnv } = require('./upstream-account-profile');
const { readGrokAuthProfile } = require('../account/grok-auth-profile');
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
const { isCodebuddyFamilyProvider } = require('../account/codebuddy-billing');
const { selectCodebuddyCredential, inspectCodebuddyCredential } = require('../account/codebuddy-credential-source');
const {
  clearRecoverableAgyAuthInvalidBlock
} = require('../account/agy-auth-recovery');
const {
  applyAgyUsageSnapshotToAccount
} = require('./agy-usage-snapshot');
const { summarizeOpenCodeAuth } = require('../account/opencode-auth-metadata');
const { summarizeQoderAuth, resolveQoderNativeAuthPayload } = require('../account/qoder-auth-metadata');
const { decryptQoderCredential } = require('../account/qoder-credential-decrypt');
const { createKimiHostCredentialReconciler } = require('../account/kimi-host-credentials');
const { resolveKimiBaseUrl } = require('../account/kimi-endpoints');
const { readKimiApiKey } = require('../profile/credential-config');
const {
  ZCODE_DEFAULT_BASE_URL,
  ZCODE_PLAN_ANTHROPIC_BASE_URL,
  resolveZcodeInferenceBaseUrl
} = require('../account/provider-api-base-url');
const { readZcodeLiveOAuthCredential } = require('../account/zcode-credential');
const {
  CLINE_DEFAULT_BASE_URL
} = require('../account/provider-api-base-url');
const {
  readClineAccountId,
  resolveClineAccountName,
  selectClineOAuthCredential
} = require('../account/cline-credentials');
const {
  formatKimiOAuthAccountName,
  hasUsableKimiOAuth,
  readKimiAccessToken,
  readKimiOAuthCredentials,
  readKimiRefreshToken,
  readKimiTokenExpiry,
  resolveKimiOAuthDeviceId
} = require('../account/kimi-auth');
const { readUsageThresholdPct } = require('../usage/config-store');
const { isTrustedQuotaSnapshot } = require('../usage/quota');

const USAGE_SNAPSHOT_SCHEMA_VERSION = 2;
const USAGE_SOURCE_GEMINI = 'gemini_refresh_user_quota';
const USAGE_SOURCE_CODEX = 'codex_app_server';
const USAGE_SOURCE_AGY_CODE_ASSIST = 'agy_fetch_available_models';
const USAGE_SOURCE_CLAUDE_OAUTH = 'claude_oauth_usage_api';
const USAGE_SOURCE_CLAUDE_AUTH_TOKEN = 'claude_auth_token_usage_api';
const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_GROK, USAGE_SOURCE_KIRO, USAGE_SOURCE_KIMI, USAGE_SOURCE_ZCODE, USAGE_SOURCE_CODEBUDDY } = require('../account/usage-remaining');
const { CODEBUDDY_FAMILY_PROVIDERS } = require('../account/codebuddy-billing');

const CODEBUDDY_FAMILY_CLI_NAMES = new Set(CODEBUDDY_FAMILY_PROVIDERS);

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

function snapshotAccountValue(snapshot, key) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const account = snapshot.account;
  if (!account || typeof account !== 'object') return '';
  return String(account[key] || '').trim();
}

// zcode 的套餐标识数组（可能多套餐叠加，如「领臭鸡蛋」叠加的试用套餐）。
function readZcodePlanIdsFromSnapshot(snapshot) {
  const account = snapshot && typeof snapshot === 'object' ? snapshot.account : null;
  const ids = Array.isArray(account && account.planIds) ? account.planIds : [];
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

// zcode 的套餐标识（plan_id，如 `zcode-v3-start-plan-1024`）。
// 它是**可判定的事实**（推理端点按它分叉）；展示名 "ZCode 1024 Dev Day" 判不出来。
// 快照里存 planIds 数组（可能多套餐叠加，如「领臭鸡蛋」叠加的试用套餐）。
function readZcodePlanIdFromSnapshot(snapshot) {
  const account = snapshot && typeof snapshot === 'object' ? snapshot.account : null;
  const ids = Array.isArray(account && account.planIds) ? account.planIds : [];
  // 优先返回含 start-plan 的（start-plan 的端点与 coding-plan 不同，必须优先命中）。
  const startPlan = ids.find((id) => String(id || '').toLowerCase().includes('start-plan'));
  return String(startPlan || ids[0] || '').trim();
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

function isTrustedKimiUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) return false;
  if (snapshot.kind !== 'kimi_oauth_usage') return false;
  if (snapshot.source !== USAGE_SOURCE_KIMI) return false;
  if (!Array.isArray(snapshot.entries)) return false;
  return true;
}

function isTrustedZcodeUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) return false;
  if (snapshot.kind !== 'zcode_plan_balance') return false;
  if (snapshot.source !== USAGE_SOURCE_ZCODE) return false;
  if (!Array.isArray(snapshot.entries)) return false;
  return true;
}

// CodeBuddy 家族四支共用一个 kind / source：同地区 work/code 是同一账号、同一余额接口、
// 同一种快照形状（见 lib/account/codebuddy-billing.js）。
function isTrustedCodebuddyUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) return false;
  if (snapshot.kind !== 'codebuddy_credit_balance') return false;
  if (snapshot.source !== USAGE_SOURCE_CODEBUDDY) return false;
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
  if (cliName === 'kimi') {
    return isTrustedKimiUsageSnapshot(snapshot) ? snapshot : null;
  }
  if (cliName === 'grok') {
    return snapshot && snapshot.schemaVersion === USAGE_SNAPSHOT_SCHEMA_VERSION
      && snapshot.kind === USAGE_SNAPSHOT_KINDS.grok && snapshot.source === USAGE_SOURCE_GROK
      && Array.isArray(snapshot.entries) ? snapshot : null;
  }
  if (cliName === 'kiro') {
    return snapshot && snapshot.schemaVersion === USAGE_SNAPSHOT_SCHEMA_VERSION
      && snapshot.kind === USAGE_SNAPSHOT_KINDS.kiro && snapshot.source === USAGE_SOURCE_KIRO
      && Array.isArray(snapshot.entries) ? snapshot : null;
  }
  if (cliName === 'zcode') {
    return isTrustedZcodeUsageSnapshot(snapshot) ? snapshot : null;
  }
  if (CODEBUDDY_FAMILY_CLI_NAMES.has(cliName)) {
    return isTrustedCodebuddyUsageSnapshot(snapshot) ? snapshot : null;
  }
  // 插件型额度源（当前是 Cline Pass）：可信规则由额度源注册表给出（kind / source / shape），
  // 这里不再为每个新 provider 补一支分支。native 分支保留在上面，因为它们还带归一化语义
  // （codex 的 auth_json 回退、agy/kimi 的专用校验等），不是纯粹的 kind/source 匹配。
  if (isTrustedQuotaSnapshot(cliName, snapshot, { schemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION })) {
    return snapshot;
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
  const configuredMinRemainingPct = resolveMinimumRemainingPct(thresholdPct);
  return Number.isFinite(configuredMinRemainingPct) && remainingPct <= configuredMinRemainingPct;
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
        credentialUpdatedAt: Number(record.envUpdatedAt) || 0,
        displayName: getApiKeyDisplayName('codex', { baseUrl: openaiBaseUrl }),
        openaiBaseUrl,
        ...resolveUpstreamProfileFromEnv(envData)
      });
      return;
    }

    if (payload) {
      out.push({
        accountRef,
        email: snapshotAccountValue(usageSnapshot, 'email'),
        // 工作区从凭据本身按 Go 语义解析（codex-workspace.js），不读可能过期的用量快照。
        ...resolveCodexWorkspaceFields(authJson),
        accessToken: String(payload.tokens.access_token || ''),
        idToken: String(payload.tokens.id_token || ''),
        refreshToken: String(payload.tokens.refresh_token || ''),
        tokenExpiresAt: resolveCodexTokenExpiryMs(authJson),
        oauthClientId: resolveCodexOauthClientId(authJson),
        codexAuthPath: authPath,
        // A metadata-only DB write must not clear a credential rejection.
        credentialUpdatedAt: record.nativeAuth.codexNativeObservation
          && record.nativeAuth.codexNativeObservation.fingerprint === codexCredentialFingerprint(authJson)
          ? Number(record.nativeAuth.codexNativeObservation.capturedAt) || 0 : 0,
        profileDir: resolveAccountRuntimeDir(deps, 'codex', accountRef),
        remainingPct: Number.isFinite(remainingPct) ? Number(remainingPct) : null,
        usageSnapshot,
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
      refreshTokenExpiresAt: authType === 'oauth' && oauthCredential.refreshTokenExpiresAt > 0
        ? oauthCredential.refreshTokenExpiresAt
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

// qoder 池记录的可用凭据：PAT 账号用 env；OAuth 账号从凭据里取（可读载荷 → CLI opaque
// blob 解密）。**必须非空**，否则 account-capabilities 的 hasUsableCredential 判该账号
// 「没有可用凭据」→ 不进模型索引的可调度集合 → 裸模型名路由时它拿不到绑定分，
// 请求会被甩到别的 provider（实测：Qwen3.8-Flash 被送到 opencode 并 503）。
function resolveQoderPoolAccessToken(provider, record, envToken) {
  const pat = String(envToken || '').trim();
  if (pat) return pat;
  const nativeAuth = record && record.nativeAuth && typeof record.nativeAuth === 'object'
    ? record.nativeAuth
    : {};
  const payload = resolveQoderNativeAuthPayload(provider, nativeAuth);
  const fromPayload = payload
    ? String(payload.security_oauth_token || payload.access_token || payload.token || '').trim()
    : '';
  if (fromPayload) return fromPayload;
  const decrypted = decryptQoderCredential(provider, nativeAuth);
  return decrypted && decrypted.token ? String(decrypted.token).trim() : '';
}

function loadQoderServerAccounts(deps, providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  if (provider !== 'qoder' && provider !== 'qodercn') return [];
  const { accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, provider).forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    const envToken = String(record.env && record.env.QODER_PERSONAL_ACCESS_TOKEN || '').trim();
    const authSummary = summarizeQoderAuth(provider, record.nativeAuth, { envToken });
    const status = typeof checkStatus === 'function'
      ? checkStatus(provider, accountRef)
      : null;
    if (!authSummary.configured && !(status && status.configured)) return;
    const apiKeyMode = Boolean(envToken);
    const poolAccessToken = resolveQoderPoolAccessToken(provider, record, envToken);
    const profileDir = resolveAccountRuntimeDir(deps, provider, accountRef);
    out.push({
      accountRef,
      email: authSummary.email || '',
      provider,
      authType: apiKeyMode ? 'api-key' : 'oauth',
      apiKeyMode,
      accessToken: poolAccessToken,
      displayName: authSummary.accountName || status && status.accountName || 'Qoder Account',
      profileDir,
      configDir: profileDir,
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

/**
 * CodeBuddy / WorkBuddy 家族进入推理池。
 *
 * 家族与 qoder 的区别是决定性的：**家族有真实可直连的 HTTP 推理端点**
 * （`{base}/v2/chat/completions`，契约见 `lib/account/codebuddy-family-inference.js`），
 * 所以它能像 grok/kimi 一样被网关调度，不需要 CLI 子进程桥接。
 *
 * token 的来源分两种（与 `authOptions` 的两种登录方式一一对应）：
 *   - api-key 账号：`CODEBUDDY_API_KEY`（可配 `CODEBUDDY_BASE_URL` 覆盖端点）；
 *   - OAuth/桌面账号：共享 `.info` 里那个 accessToken（App 与内嵌 CLI 共写的那一份，
 *     见 docs/architecture/codebuddy-family-credential-model.md §3.1）。
 *
 * 读不出 OAuth token 时**不入池**，而不是塞一个空 token：空 token 会让每次调度都撞一次
 * 401，把「账号其实不可用」伪装成「上游在报错」，既污染熔断计数也误导排查。
 * macOS 上 WorkBuddy 的凭据经 safeStorage 加密、当前平台无法离线解密时就会走到这里
 * （实测 2026-10-14：codebuddy 的 `.info` 是明文可读，workbuddy/workbuddycn 不可读）。
 */
function loadCodebuddyFamilyServerAccounts(deps, providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  if (!isCodebuddyFamilyProvider(provider)) return [];
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, provider).forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    const status = typeof checkStatus === 'function' ? checkStatus(provider, accountRef) : null;
    const envData = record.env || {};
    const apiKey = String(envData.CODEBUDDY_API_KEY || '').trim();
    const apiKeyMode = Boolean(apiKey);
    const profileDir = resolveAccountRuntimeDir(deps, provider, accountRef);

    let accessToken = apiKey;
    let identity = null;
    if (!apiKeyMode) {
      const credential = selectCodebuddyCredential(fs, profileDir, provider);
      if (credential && credential.ok) {
        accessToken = String(credential.credential && credential.credential.auth
          && credential.credential.auth.accessToken || '').trim();
        identity = credential;
      } else {
        // 账号投影里还没有凭据文件（账号刚被自动识别登记、还没启动过）：用库里那份已登记的凭据 ——
        // 它正是刚从宿主 .info 采纳的最新一份；否则自动识别出来的账号要等到第一次启动才进池。
        const stored = record.nativeAuth && record.nativeAuth.credentials;
        const inspection = stored ? inspectCodebuddyCredential(stored, provider) : null;
        if (!inspection || !inspection.ok) return;
        accessToken = String(stored.auth && stored.auth.accessToken || '').trim();
        identity = { ...inspection, credential: stored };
      }
      if (!accessToken) return;
    }
    if (!accessToken && !(status && status.configured)) return;

    const baseUrl = String(envData.CODEBUDDY_BASE_URL || '').trim();
    // 账号名：真实昵称优先于状态服务的兜底名（`<provider> OAuth` / `<provider> Account`）。
    // WorkBuddy 的昵称在宿主文件里是加密信封，解码后才有值 —— 少了这一步，自动识别出来的
    // 账号在账号页上只有兜底名。
    const nickname = identity && identity.credential && identity.credential.account
      && typeof identity.credential.account.nickname === 'string' ? identity.credential.account.nickname : '';
    const statusName = String(status && status.accountName || '').trim();
    const genericStatusName = !statusName || statusName === `${provider} Account` || statusName.endsWith(' OAuth');
    out.push({
      accountRef,
      email: (identity && identity.uid) || status && status.email || '',
      provider,
      authType: apiKeyMode ? 'api-key' : 'oauth',
      apiKeyMode,
      accessToken,
      openaiBaseUrl: baseUrl,
      displayName: (genericStatusName ? nickname : statusName) || statusName || nickname || `${provider} Account`,
      profileDir,
      configDir: profileDir,
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
    const oauthProfile = readGrokAuthProfile(nativeAuth);
    const oauthToken = oauthProfile.accessToken;
    const accessToken = apiKey || oauthToken;
    if (!accessToken && !oauthProfile.refreshToken) return;
    const apiKeyMode = Boolean(apiKey);
    const profileDir = resolveAccountRuntimeDir(deps, 'grok', accountRef);
    const usageSnapshot = apiKeyMode ? null : readTrustedUsageSnapshot(deps, 'grok', accountRef);
    const remainingPct = getMinRemainingPctFromUsageSnapshot(usageSnapshot);
    const planType = snapshotAccountValue(usageSnapshot, 'planType');
    const quotaState = deriveQuotaState({ provider: 'grok', configured: true, apiKeyMode, planType, remainingPct, usageSnapshot });
    const schedulableState = deriveSchedulableState({ provider: 'grok', configured: true, apiKeyMode,
      accountStatus: 'up', planType, remainingPct: quotaState.remainingPct, usageSnapshot, quotaState });
    out.push({
      accountRef,
      email: oauthProfile.email,
      provider: 'grok',
      authType: apiKeyMode ? 'api-key' : 'oauth',
      apiKeyMode,
      // grok exposes three product boundaries (web / console / build) with
      // different upstream protocols. The loaded account type is tagged here so
      // future SSO web/console accounts can route to the grok.com protocol
      // while build-cli / api-key accounts stay on the official api.x.ai REST
      // API. See docs/architecture/grok-provider-boundaries.md.
      grokBoundary: apiKeyMode ? 'api-key' : 'build-cli',
      accessToken,
      refreshToken: apiKeyMode ? '' : oauthProfile.refreshToken,
      oauthClientId: apiKeyMode ? '' : oauthProfile.oauthClientId,
      tokenExpiresAt: apiKeyMode ? null : oauthProfile.tokenExpiresAt,
      credentialUpdatedAt: apiKeyMode ? record.envUpdatedAt : record.nativeAuthUpdatedAt,
      openaiBaseUrl: baseUrl,
      displayName: apiKeyMode ? `API Key (${baseUrl})` : (oauthProfile.email || 'Grok OAuth'),
      profileDir,
      configDir: profileDir ? path.join(profileDir, '.grok') : '',
      availableModels: [],
      usageSnapshot,
      planType,
      remainingPct: quotaState.remainingPct,
      quotaStatus: quotaState.status,
      quotaReason: quotaState.reason || '',
      schedulableStatus: schedulableState.status,
      schedulableReason: schedulableState.reason || '',
      cooldownUntil: 0,
      consecutiveFailures: 0,
      successCount: 0,
      failCount: 0,
      lastError: ''
    });
  });
  return out;
}

function loadKimiServerAccounts(deps) {
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  const reconcileKimiHostCredentials = typeof deps.reconcileKimiHostCredentials === 'function'
    ? deps.reconcileKimiHostCredentials
    : (deps.hostHomeDir
      ? createKimiHostCredentialReconciler({
        fs,
        path,
        aiHomeDir: deps.aiHomeDir,
        hostHomeDir: deps.hostHomeDir
      })
      : null);
  listProviderCredentialRecords(deps, 'kimi').forEach((record) => {
    let effectiveRecord = record;
    if (reconcileKimiHostCredentials) {
      const reconciliation = reconcileKimiHostCredentials(record.accountRef);
      if (reconciliation && reconciliation.ok === true && reconciliation.adopted === true) {
        const refreshedRecord = readAccountCredentialRecord(fs, deps.aiHomeDir, record.accountRef);
        if (refreshedRecord && refreshedRecord.provider === 'kimi') effectiveRecord = refreshedRecord;
      }
    }
    const accountRef = effectiveRecord.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    let status = null;
    if (typeof checkStatus === 'function') {
      status = checkStatus('kimi', accountRef);
      if (!status || !status.configured) return;
    }
    const envData = effectiveRecord.env || {};
    const apiKey = readKimiApiKey(envData);
    const baseUrl = resolveKimiBaseUrl({
      baseUrl: envData.KIMI_BASE_URL,
      apiKeyMode: Boolean(apiKey)
    });
    // kimi 的 OAuth 凭证落在 native_auth_json 的 $.credentials（access_token/refresh_token），
    // 早期版本写入 $.auth；两者都兼容，否则账号永远取不到 token 而进不了运行池。
    // 用 effectiveRecord（可能经 host 凭证 reconcile 刷新）而不是原始 record。
    const nativeAuth = readKimiOAuthCredentials(effectiveRecord.nativeAuth);
    const oauthToken = readKimiAccessToken(nativeAuth);
    const refreshToken = readKimiRefreshToken(nativeAuth);
    const accessToken = apiKey || oauthToken;
    if (!apiKey && !hasUsableKimiOAuth(nativeAuth)) return;
    const apiKeyMode = Boolean(apiKey);
    const usageSnapshot = readTrustedUsageSnapshot(deps, 'kimi', accountRef);
    const remainingPct = getMinRemainingPctFromUsageSnapshot(usageSnapshot);
    const planType = normalizeLowerText(snapshotAccountValue(usageSnapshot, 'planType'));
    const quotaState = deriveQuotaState({
      provider: 'kimi',
      configured: true,
      apiKeyMode,
      planType,
      remainingPct,
      usageSnapshot
    });
    const schedulableState = deriveSchedulableState({
      provider: 'kimi',
      configured: true,
      apiKeyMode,
      accountStatus: 'up',
      planType,
      remainingPct: quotaState.remainingPct,
      usageSnapshot,
      quotaState
    });
    const profileDir = resolveAccountRuntimeDir(deps, 'kimi', accountRef);
    const deviceId = apiKeyMode
      ? ''
      : resolveKimiOAuthDeviceId(effectiveRecord.nativeAuth);
    out.push({
      accountRef,
      email: '',
      provider: 'kimi',
      authType: apiKeyMode ? 'api-key' : 'oauth',
      apiKeyMode,
      accessToken,
      refreshToken: apiKeyMode ? '' : refreshToken,
      tokenType: apiKeyMode
        ? 'Bearer'
        : String(nativeAuth && (nativeAuth.token_type || nativeAuth.tokenType) || 'Bearer').trim() || 'Bearer',
      tokenExpiresAt: apiKeyMode ? 0 : readKimiTokenExpiry(nativeAuth),
      deviceId,
      openaiBaseUrl: baseUrl,
      displayName: apiKeyMode
        ? `API Key (${baseUrl})`
        : String(status && status.accountName || '').trim()
          || formatKimiOAuthAccountName(nativeAuth, accountRef),
      profileDir,
      configDir: profileDir || '',
      availableModels: apiKeyMode ? [] : ['k3-256k', 'k3', 'kimi-for-coding', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
      remainingPct: quotaState.remainingPct,
      quotaStatus: quotaState.status,
      quotaReason: quotaState.reason || '',
      schedulableStatus: schedulableState.status,
      schedulableReason: schedulableState.reason || '',
      cooldownUntil: 0,
      consecutiveFailures: 0,
      successCount: 0,
      failCount: 0,
      lastError: ''
    });
  });
  return out;
}

// kiro 的推理面是 CodeWhisperer 的流式 RPC（`codewhisperer.<region>.amazonaws.com` +
// `x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`）。
// **不是** `q.<region>.amazonaws.com`——那是 Amazon Q 的其它面，chat 操作在上面全部
// UnknownOperationException（2026-10-16 实测），旧默认值因此让 kiro 会话永远失败。
const KIRO_DEFAULT_BASE_URL = 'https://codewhisperer.us-east-1.amazonaws.com';

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
    // 区域决定 CodeWhisperer 端点；IdC / social 账号的流式 RPC 需要 profileArn（Builder ID 不需要）。
    const kiroRegion = /^[a-z]{2}-[a-z]+-\d$/.test(String(nativeAuth && nativeAuth.region || '').trim())
      ? String(nativeAuth.region).trim()
      : 'us-east-1';
    const profileArn = String(
      (record.nativeAuth && (record.nativeAuth.profileArn || record.nativeAuth.profile_arn))
      || (nativeAuth && (nativeAuth.profileArn || nativeAuth.profile_arn))
      || ''
    ).trim();
    const profileDir = resolveAccountRuntimeDir(deps, 'kiro', accountRef);
    out.push({
      accountRef,
      email: '',
      provider: 'kiro',
      authType: 'oauth',
      apiKeyMode: false,
      accessToken: oauthToken,
      openaiBaseUrl: baseUrl,
      kiroRegion,
      profileArn,
      displayName: describeKiroAccount(record.nativeAuth).accountName,
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

// cline 网关池收两类账号，都能直接推理（api.cline.bot/api/v1 是标准 OpenAI Chat
// Completions，Bearer 鉴权）：
// - API Key 账号：env 里的 CLINE_API_KEY（CLINE_API_BASE_URL 可覆盖端点）。
// - Cline Pass 订阅（OAuth）：native_auth.auth 里的 cline 槽位。
//   注意 accessToken 必须**带 `workos:` 前缀**出网——2026-10-14 实测前缀是 wire 格式
//   的一部分（裸 JWT 一律 401，见 account/cline-credentials.js 的说明），所以这里直接
//   用 selectClineOAuthCredential 给的 wire 形态，不做任何剥离。
// 上游没有用量/额度接口（manifest 也没有 quota_usage 能力），因此配额状态由
// deriveQuotaState 按能力缺席给出 not_applicable，账号只要凭据可用即可调度。
function loadClineServerAccounts(deps) {
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, 'cline').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    const envData = record.env || {};
    const apiKey = String(envData.CLINE_API_KEY || '').trim();
    const baseUrl = String(envData.CLINE_API_BASE_URL || '').trim() || CLINE_DEFAULT_BASE_URL;
    const doc = record.nativeAuth && record.nativeAuth.auth;
    const credential = selectClineOAuthCredential(doc);
    const oauthToken = credential ? credential.accessToken : '';
    const accessToken = apiKey || oauthToken;
    // 只有 refresh token 的账号也要留在池里：token-refresh-daemon 的 cline 策略能把它救回来。
    const hasStoredCredential = Boolean(accessToken) || Boolean(credential && credential.refreshToken);
    // 账号投影里还没有凭据文件（账号刚被自动识别登记、还没启动过）时投影状态是「未配置」，
    // 而库里那份已登记的凭据正是刚从宿主 providers.json 采纳的最新一份 —— 直接进池。
    // 少了这一步，自动识别出来的账号要等到第一次启动才可用（与 codebuddy 家族的既有语义一致）；
    // 推理链路（general transport）读的就是池里的 accessToken，不依赖投影文件。
    if (typeof checkStatus === 'function') {
      const st = checkStatus('cline', accountRef);
      if (!(st && st.configured) && !hasStoredCredential) return;
    }
    if (!hasStoredCredential) return;
    const apiKeyMode = Boolean(apiKey);
    const usageSnapshot = readTrustedUsageSnapshot(deps, 'cline', accountRef);
    const quotaState = deriveQuotaState({
      provider: 'cline',
      configured: true,
      apiKeyMode,
      usageSnapshot
    });
    const schedulableState = deriveSchedulableState({
      provider: 'cline',
      configured: true,
      apiKeyMode,
      accountStatus: 'up',
      usageSnapshot,
      quotaState
    });
    const profileDir = resolveAccountRuntimeDir(deps, 'cline', accountRef);
    const accountId = apiKeyMode ? '' : readClineAccountId(doc);
    const email = apiKeyMode
      ? ''
      : String(credential && credential.userInfo && credential.userInfo.email || '').trim();
    out.push({
      accountRef,
      email,
      provider: 'cline',
      authType: apiKeyMode ? 'api-key' : 'oauth',
      apiKeyMode,
      accessToken,
      refreshToken: apiKeyMode ? '' : String(credential && credential.refreshToken || '').trim(),
      tokenType: 'Bearer',
      tokenExpiresAt: apiKeyMode ? 0 : Number(credential && credential.expiresAt) || 0,
      accountId,
      credentialUpdatedAt: apiKeyMode ? record.envUpdatedAt : record.nativeAuthUpdatedAt,
      openaiBaseUrl: baseUrl,
      displayName: apiKeyMode
        ? `API Key (${baseUrl})`
        : (resolveClineAccountName(doc) || accountId || 'Cline Pass'),
      profileDir,
      configDir: profileDir ? path.join(profileDir, '.cline') : '',
      availableModels: [],
      usageSnapshot,
      remainingPct: quotaState.remainingPct,
      quotaStatus: quotaState.status,
      quotaReason: quotaState.reason || '',
      schedulableStatus: schedulableState.status,
      schedulableReason: schedulableState.reason || '',
      cooldownUntil: 0,
      consecutiveFailures: 0,
      successCount: 0,
      failCount: 0,
      lastError: ''
    });
  });
  return out;
}

// zcode 网关池收两类账号：
// - API-key 账号：参与推理调度（anthropic 协议透传，x-api-key 鉴权）。
// - OAuth 计划账号：保留在池中供模型探测 / 用量展示 / WebUI 运行时状态使用，
//   但标记 schedulableStatus='relay_disabled'——推理选择器（account-selector）
//   会跳过一切非 schedulable 账号，relay 自 2026-08-19 取消（Start Plan 推理
//   准入门由 Z.ai 服务端活动窗口控制，405/3012，官方桌面端同待遇，客户端侧无解）。
//   注意：探测和展示链路（findScopedAccount、buildRuntimeAccountMap）直接读本池，
//   把 OAuth 账号移出池会导致 WebUI「刷新模型」404 account_not_found——勿再移除。
//   模型探测：GET zcode-plan billing/balance 以 zcodeJwtToken 为准（桌面端同款）；
//   accessToken（zai OAuth token）只是 paas 探测的回退凭据，它会过期且无 refresh
//   token，过期后 api.z.ai 实测 401。jwtToken 过期只能重新 login 导入。

function loadZcodeServerAccounts(deps) {
  const { fs, accountStateIndex, checkStatus } = deps;
  const out = [];
  listProviderCredentialRecords(deps, 'zcode').forEach((record) => {
    const accountRef = record.accountRef;
    const stateRow = readStateRow(accountStateIndex, accountRef);
    if (getPersistedOperationalStatus(stateRow) === 'down') return;
    if (typeof checkStatus === 'function') {
      const st = checkStatus('zcode', accountRef);
      if (!st || !st.configured) return;
    }
    const envData = record.env || {};
    const apiKey = String(envData.ZCODE_API_KEY || '').trim();
    const profileDir = resolveAccountRuntimeDir(deps, 'zcode', accountRef);
    if (!apiKey) {
      // OAuth 计划账号：在池但不可调度（relay_disabled），仅供探测/展示。
      // 桌面端运行期会在沙箱 profile 里刷新 token 但不回写 DB；优先采用比 DB
      // 快照新的活凭据（readZcodeLiveOAuthCredential），缺失/损坏时回退 DB，
      // 避免模型目录探测拿着数天前的 JWT 稳定 401。
      const oauth = readZcodeLiveOAuthCredential(deps.fs, deps.aiHomeDir, accountRef, record).oauth;
      if (!oauth.configured || (!oauth.accessToken && !oauth.jwtToken)) return;
      const email = String(oauth.userInfo && oauth.userInfo.email || '').trim();
      const usageSnapshot = readTrustedUsageSnapshot(deps, 'zcode', accountRef);
      const remainingPct = getMinRemainingPctFromUsageSnapshot(usageSnapshot);
      const planType = normalizeLowerText(snapshotAccountValue(usageSnapshot, 'planType'));
      const quotaState = deriveQuotaState({
        provider: 'zcode',
        configured: true,
        apiKeyMode: false,
        planType,
        remainingPct,
        usageSnapshot
      });
      out.push({
        accountRef,
        email,
        provider: 'zcode',
        authType: 'oauth',
        apiKeyMode: false,
        accessToken: oauth.accessToken,
        zcodeJwtToken: oauth.jwtToken,
        // 推理端点按套餐分叉：start-plan 与 coding-plan 是两个不同的 host。
        // planId 来自额度快照（billing/balance 的 data.plans[].plan_id），
        // 它是可判定的事实；展示名（"ZCode 1024 Dev Day"）判不出来。
        openaiBaseUrl: resolveZcodeInferenceBaseUrl(
          readZcodePlanIdFromSnapshot(usageSnapshot) || ''
        ),
        // planIds 供 relay 的凭据形态判定（start-plan 用长期 jwt 直通）。
        // 与 openaiBaseUrl 同源（都来自额度快照的 plan_id），避免两处判定漂移。
        planIds: readZcodePlanIdsFromSnapshot(usageSnapshot),
        displayName: email || String(oauth.userInfo && oauth.userInfo.name || '').trim() || 'ZCode OAuth',
        profileDir,
        configDir: profileDir ? path.join(profileDir, '.zcode') : '',
        availableModels: [],
        usageSnapshot,
        remainingPct: quotaState.remainingPct,
        quotaStatus: quotaState.status,
        quotaReason: quotaState.reason || '',
        // OAuth 计划账号可参与推理：relay 前由 upstream-credential-resolver 按
        // 描述符声明（capabilities.relay.auth = business_token）把 access_token
        // 换成业务 token 再发。此前这里硬编码 relay_disabled，OAuth 账号永不进路由池，
        // 是「网关推理需使用 Coding Plan API Key 账号」那句话的来源。
        schedulableStatus: '',
        schedulableReason: '',
        cooldownUntil: 0,
        consecutiveFailures: 0,
        successCount: 0,
        failCount: 0,
        lastError: ''
      });
      return;
    }
    const baseUrl = String(envData.ZCODE_BASE_URL || '').trim() || ZCODE_DEFAULT_BASE_URL;
    out.push({
      accountRef,
      email: '',
      provider: 'zcode',
      authType: 'api-key',
      apiKeyMode: true,
      accessToken: apiKey,
      openaiBaseUrl: baseUrl,
      displayName: `API Key (${baseUrl})`,
      profileDir,
      configDir: profileDir ? path.join(profileDir, '.zcode') : '',
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

// 运行态恢复统一走门禁（见 account-runtime-gate 的 observeRecovery）；未装配门禁时
// 退回直接调账号状态服务（单测/降级装配）。
function runAccountRecovery(runtimeDeps, options) {
  const gate = runtimeDeps && runtimeDeps.accountRuntimeGate;
  const accountStateService = runtimeDeps && runtimeDeps.accountStateService;
  const baseState = buildRuntimeBaseStateForAccount(options.account);
  if (gate && typeof gate.observeRecovery === 'function') {
    return gate.observeRecovery({
      account: options.account,
      provider: options.provider,
      evidence: options.evidence,
      clear: options.clear,
      scope: options.scope,
      usageSnapshot: options.usageSnapshot,
      baseState,
      source: options.source || 'server.account.recovery'
    });
  }
  if (!accountStateService || typeof accountStateService.clearRuntimeBlock !== 'function') return false;
  return Boolean(accountStateService.clearRuntimeBlock(options.account.accountRef, options.provider, {
    ...baseState,
    evidence: options.evidence,
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.usageSnapshot ? { usageSnapshot: options.usageSnapshot } : {})
  }));
}

function clearStaleCredentialAuthInvalidBlock(provider, account, runtimeDeps) {
  return runAccountRecovery(runtimeDeps, {
    provider,
    account,
    evidence: 'credential_config_verified',
    clear: 'auth_invalid'
  });
}

function clearStaleAgyAuthInvalidBlock(provider, account, row, runtimeDeps) {
  if (!row || !row.runtimeState) return false;
  return clearRecoverableAgyAuthInvalidBlock({
    provider,
    accountRef: account && account.accountRef,
    runtimeStatus: deriveAccountRuntimeStatus(row.runtimeState),
    authMetadata: account && account.authMetadata,
    accountStateService: runtimeDeps && runtimeDeps.accountStateService,
    accountRuntimeGate: runtimeDeps && runtimeDeps.accountRuntimeGate,
    baseState: buildRuntimeBaseStateForAccount(account)
  });
}

// OAuth tokens and API keys alike: credentials saved after the failure invalidate
// the evidence against the old ones. The next request re-verifies them.
function clearAuthInvalidOnFreshCredential(provider, account, row, runtimeDeps) {
  if (!['grok', 'codex'].includes(String(provider || '').trim().toLowerCase())) return false;
  if (!row || !row.runtimeState || !account) return false;
  if (deriveAccountRuntimeStatus(row.runtimeState).status !== 'auth_invalid') return false;
  const credentialUpdatedAt = Number(account.credentialUpdatedAt) || 0;
  const lastFailureAt = Number(row.runtimeState.lastFailureAt) || 0;
  if (credentialUpdatedAt <= 0 || lastFailureAt <= 0 || credentialUpdatedAt <= lastFailureAt) return false;
  return runAccountRecovery(runtimeDeps, {
    provider,
    account,
    evidence: 'credential_update_after_failure',
    clear: 'auth_invalid'
  });
}

// 探测成功自动清 auth_invalid：agy 账号若在被标记 auth_invalid 之后又有一次成功的用量快照
// （codeAssistQuotaCapturedAt 晚于 lastFailureAt），说明凭据现已有效、该 auth_invalid 是过时状态，直接清除。
// 这是"探测成功即证明已登录"的直接证据，能推翻早前的 agy_not_signed_in 等误判，无需用户手动清冷却。
function clearAgyAuthInvalidOnFreshUsageProbe(provider, account, row, runtimeDeps) {
  if (String(provider || '').trim().toLowerCase() !== 'agy') return false;
  if (!row || !row.runtimeState || !account) return false;
  if (deriveAccountRuntimeStatus(row.runtimeState).status !== 'auth_invalid') return false;
  const capturedAt = Number(account.codeAssistQuotaCapturedAt) || 0;
  const lastFailureAt = Number(row.runtimeState.lastFailureAt) || 0;
  // 成功探测必须晚于失败记录，才能确认是"失败后又成功"（避免清掉真实的新失败）。
  if (capturedAt <= 0 || capturedAt < lastFailureAt) return false;
  return runAccountRecovery(runtimeDeps, {
    provider,
    account,
    evidence: 'agy_usage_probe_verified',
    clear: 'auth_invalid'
  });
}

// 探测成功自动清 agy 地区资格块（permission_denied / agy_region_not_eligible）：与上面的 auth_invalid
// 规则同形 —— 被标记之后又有一次成功的 code-assist 用量探测（codeAssistQuotaCapturedAt 不早于
// lastFailureAt），说明当前地区已可用、该路由阻塞已过时（用户改区后刷新/后台探测即恢复，无需人工
// "恢复调度"）。清账号级阻塞 + routingBlock；判定谓词与 account/state-service 的 agy 分支同源。
function clearAgyRegionBlockOnFreshUsageProbe(provider, account, row, runtimeDeps) {
  if (String(provider || '').trim().toLowerCase() !== 'agy') return false;
  if (!row || !row.runtimeState || !account || !account.usageSnapshot) return false;
  const runtimeStatus = deriveAccountRuntimeStatus(row.runtimeState);
  if (runtimeStatus.status !== 'permission_denied') return false;
  if (!String(runtimeStatus.reason || '').includes('agy_region_not_eligible')) return false;
  const capturedAt = Number(account.codeAssistQuotaCapturedAt) || 0;
  const lastFailureAt = Number(row.runtimeState.lastFailureAt) || 0;
  // 成功探测必须晚于失败记录，才能确认是"失败后又成功"（避免清掉真实的新失败）。
  if (capturedAt <= 0 || capturedAt < lastFailureAt) return false;
  return runAccountRecovery(runtimeDeps, {
    provider,
    account,
    evidence: 'agy_usage_probe_verified',
    clear: 'account',
    usageSnapshot: account.usageSnapshot
  });
}

function mergePersistedRuntimeFields(accounts, provider, accountStateIndex, runtimeDeps) {
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
    if (provider === 'codex' && account.usageSnapshot
      && runAccountRecovery(runtimeDeps, {
        provider,
        account,
        evidence: 'verified_usage_success',
        // 内存侧交给随后按 row.runtimeState 重建（state-service 只做额度字段恢复，
        // 不能整账号清空），所以这里声明 clear: 'none'。
        clear: 'none',
        usageSnapshot: account.usageSnapshot
      })) {
      const current = runtimeDeps.accountStateService.getAccountState(account.accountRef);
      row.runtimeState = current && current.runtimeState;
      if (!row.runtimeState) return account;
    }
    if (
      isMigratableCredentialAuthInvalidBlock(account, row)
      && clearStaleCredentialAuthInvalidBlock(provider, account, runtimeDeps)
    ) {
      return account;
    }
    if (clearAuthInvalidOnFreshCredential(provider, account, row, runtimeDeps)) {
      const current = runtimeDeps.accountStateService && typeof runtimeDeps.accountStateService.getAccountState === 'function'
        ? runtimeDeps.accountStateService.getAccountState(account.accountRef) : null;
      return current && current.runtimeState
        ? applyPersistedAccountRuntimeState(account, current.runtimeState) : account;
    }
    if (clearStaleAgyAuthInvalidBlock(provider, account, row, runtimeDeps)) {
      return account;
    }
    if (clearAgyAuthInvalidOnFreshUsageProbe(provider, account, row, runtimeDeps)) {
      return account;
    }
    if (clearAgyRegionBlockOnFreshUsageProbe(provider, account, row, runtimeDeps)) {
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
  }), 'codex'), 'codex', deps.accountStateIndex, deps);
  const gemini = mergePersistedRuntimeFields(withRuntimeFields(loadGeminiServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'gemini'), 'gemini', deps.accountStateIndex, deps);
  const claude = mergePersistedRuntimeFields(withRuntimeFields(loadClaudeServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir,
    serverPort: deps.serverPort
  }), 'claude'), 'claude', deps.accountStateIndex, deps);
  const agy = mergePersistedRuntimeFields(withRuntimeFields(loadAgyServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'agy'), 'agy', deps.accountStateIndex, deps);
  const opencode = mergePersistedRuntimeFields(withRuntimeFields(loadOpenCodeServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'opencode'), 'opencode', deps.accountStateIndex, deps);
  const qoder = mergePersistedRuntimeFields(withRuntimeFields(loadQoderServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }, 'qoder'), 'qoder'), 'qoder', deps.accountStateIndex, deps);
  const qodercn = mergePersistedRuntimeFields(withRuntimeFields(loadQoderServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }, 'qodercn'), 'qodercn'), 'qodercn', deps.accountStateIndex, deps);
  const grok = mergePersistedRuntimeFields(withRuntimeFields(loadGrokServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'grok'), 'grok', deps.accountStateIndex, deps);
  const kimi = mergePersistedRuntimeFields(withRuntimeFields(loadKimiServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir,
    hostHomeDir: deps.hostHomeDir,
    reconcileKimiHostCredentials: deps.reconcileKimiHostCredentials
  }), 'kimi'), 'kimi', deps.accountStateIndex, deps);
  const kiro = mergePersistedRuntimeFields(withRuntimeFields(loadKiroServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'kiro'), 'kiro', deps.accountStateIndex, deps);
  const zcode = mergePersistedRuntimeFields(withRuntimeFields(loadZcodeServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'zcode'), 'zcode', deps.accountStateIndex, deps);
  const cline = mergePersistedRuntimeFields(withRuntimeFields(loadClineServerAccounts({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    aiHomeDir: deps.aiHomeDir
  }), 'cline'), 'cline', deps.accountStateIndex, deps);
  const pools = {
    codex,
    gemini,
    claude,
    agy,
    opencode,
    qoder,
    qodercn,
    grok,
    kimi,
    kiro,
    zcode,
    // Cline（API Key 与 Cline Pass 订阅）有真实 HTTP 推理端点，与 grok/kimi 同列进池。
    cline,
    // CodeBuddy / WorkBuddy 家族：有真实 HTTP 推理端点，因此与 grok/kimi 同列进入
    // 推理池（详见 loadCodebuddyFamilyServerAccounts 的说明）。四支从布局模块展开，
    // 新增成员自动进池，不会静默漏掉一支。
    ...Object.fromEntries(
      CODEBUDDY_FAMILY_PROVIDERS.map((provider) => [provider, loadCodebuddyFamilyServerAccounts(deps, provider)])
    )
  };
  const credentialsByRef = new Map(listAccountCredentialRecords(deps.fs, deps.aiHomeDir)
    .map(record => [record.accountRef, record.env]));
  const mappingGroups = readUpstreamErrorMappingGroups(deps.fs, deps.aiHomeDir);
  const aliasPoolParticipation = readAliasPoolParticipationMap(deps.fs, deps.aiHomeDir);
  for (const pool of Object.values(pools)) {
    for (const account of pool) {
      account.upstreamErrorRules = readEffectiveUpstreamErrorRules(credentialsByRef.get(account.accountRef), {
        groups: mappingGroups,
        provider: account.provider
      });
      // 账号级「是否进入别名自动选号池」：没有记录 = 默认参与（见 alias-pool-store）。
      account.aliasPoolParticipates = aliasPoolParticipation.get(account.accountRef) !== false;
    }
  }
  return pools;
}

module.exports = {
  loadCodexServerAccounts,
  loadGeminiServerAccounts,
  loadClaudeServerAccounts,
  loadAgyServerAccounts,
  loadOpenCodeServerAccounts,
  loadQoderServerAccounts,
  loadGrokServerAccounts,
  loadKimiServerAccounts,
  loadKiroServerAccounts,
  loadZcodeServerAccounts,
  loadClineServerAccounts,
  loadCodebuddyFamilyServerAccounts,
  readTrustedUsageSnapshot,
  readUsageThresholdPct,
  getMinRemainingPctFromUsageSnapshot,
  readCodexRemainingPctSnapshot,
  withRuntimeFields,
  loadServerRuntimeAccounts
};
