'use strict';

const { spawn: spawnChild } = require('node:child_process');
const {
  DEFAULT_CODEX_CLIENT_ID,
  decodeJwtPayloadUnsafe,
  normalizeCodexRefreshToken,
  extractCodexMetadata,
  buildCodexSnapshotAccount,
  buildCodexMetadataFallbackSnapshot
} = require('../../../account/codex-auth-metadata');
const { withAuthRefreshLock } = require('../../../account/auth-refresh-lock');
const { buildAuthInvalidRuntimeState } = require('../../../account/runtime-state-builders');
const { deriveRuntimeStatus } = require('../../../account/runtime-view');
const { resolveCodexSqliteHome } = require('../../../runtime/codex-home');
const { buildPtyLaunch } = require('../../../runtime/pty-launch');
const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime,
  resolveProviderRuntimeScope
} = require('../ai-cli/provider-runtime-env');
const {
  fetchAgyCodeAssistQuotaSnapshot,
  resolveAgyQuotaBaseUrls
} = require('../../../server/code-assist-quota');
const {
  refreshAgyAccessToken: defaultRefreshAgyAccessToken
} = require('../../../server/agy-token-refresh');
const { refreshClaudeAccessToken } = require('../../../server/claude-token-refresh');
const {
  fetchWithTimeout: defaultFetchWithTimeout,
  __private: httpUtilsPrivate
} = require('../../../server/http-utils');
const {
  readAccountCredentials,
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../../../server/account-credential-store');
const { isAccountRef } = require('../../../server/account-ref-store');
const DEFAULT_OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

function createUsageSnapshotService(options = {}) {
  const {
    fs,
    path,
    spawn,
    spawnSync,
    fetchImpl,
    processObj,
    aiHomeDir,
    resolveCliPath,
    usageSnapshotSchemaVersion,
    usageRefreshStaleMs,
    usageSourceGemini,
    usageSourceCodex,
    usageSourceClaudeOauth,
    usageSourceClaudeAuthToken,
    usageSourceAgyCodeAssist,
    getProfileDir,
    getToolConfigDir,
    getAccountStateIndex,
    accountStateService,
    writeUsageCache,
    readUsageCache,
    accountArtifactHooks,
    refreshAgyAccessToken,
    fetchWithTimeout,
    codexAuthInvalidReconciler
  } = options;
  const spawnProcess = typeof spawn === 'function' ? spawn : spawnChild;
  const fetchWithImpl = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  const refreshAgyAccessTokenImpl = typeof refreshAgyAccessToken === 'function'
    ? refreshAgyAccessToken
    : defaultRefreshAgyAccessToken;
  const fetchWithTimeoutImpl = typeof fetchWithTimeout === 'function'
    ? fetchWithTimeout
    : defaultFetchWithTimeout;
  const probeStateByAccountKey = new Map();

  function makeProbeErrorKey(cliName, id) {
    return `${String(cliName || '').trim()}#${String(id || '').trim()}`;
  }

  function setProbeError(cliName, id, message) {
    const key = makeProbeErrorKey(cliName, id);
    if (!key) return;
    const text = String(message || '').trim();
    probeStateByAccountKey.set(key, {
      error: text ? text.slice(0, 500) : '',
      checkedAt: Date.now()
    });
  }

  function getLastUsageProbeError(cliName, id) {
    const state = probeStateByAccountKey.get(makeProbeErrorKey(cliName, id));
    return state && state.error ? state.error : '';
  }

  function getLastUsageProbeState(cliName, id) {
    const state = probeStateByAccountKey.get(makeProbeErrorKey(cliName, id));
    if (!state || typeof state !== 'object') return null;
    return {
      error: String(state.error || ''),
      checkedAt: Number(state.checkedAt) || 0
    };
  }

  function pickSnapshotDisplayName(snapshot) {
    const account = snapshot && snapshot.account && typeof snapshot.account === 'object'
      ? snapshot.account
      : null;
    if (!account) return '';
    return String(
      account.email
      || account.displayName
      || account.name
      || ''
    ).trim();
  }

  function clearRecoveredRuntimeState(cliName, id, snapshot, evidence = 'verified_usage_success') {
    const accountRef = String(id || '').trim();
    if (!cliName || !isAccountRef(accountRef)) return false;
    const baseState = {
      configured: true,
      apiKeyMode: false,
      displayName: pickSnapshotDisplayName(snapshot)
    };
    if (accountStateService && typeof accountStateService.clearRuntimeBlock === 'function') {
      return accountStateService.clearRuntimeBlock(accountRef, cliName, {
        ...baseState,
        evidence
      });
    }
    return false;
  }

  function isCodexAccountReadFallbackSnapshot(snapshot) {
    return Boolean(
      snapshot
      && snapshot.kind === 'codex_oauth_status'
      && String(snapshot.fallbackSource || '').trim() === 'account_read'
    );
  }

  function clearRuntimeStateForVerifiedSnapshot(cliName, id, snapshot) {
    if (cliName === 'codex' && isCodexAccountReadFallbackSnapshot(snapshot)) {
      return false;
    }
    return clearRecoveredRuntimeState(cliName, id, snapshot, 'verified_usage_success');
  }

  function markCodexAuthInvalidFromUsageProbe(cliName, id, reason) {
    if (cliName !== 'codex') return false;
    if (!accountStateService || typeof accountStateService.recordRuntimeFailure !== 'function') return false;
    const authJson = readCodexAuthJsonForSandbox(cliName, id);
    const snapshotAccount = buildCodexSnapshotAccount(null, authJson) || {};
    return accountStateService.recordRuntimeFailure(
      id,
      cliName,
      buildAuthInvalidRuntimeState(reason || 'auth_invalid_reauth_required'),
      {
        configured: true,
        apiKeyMode: false,
        displayName: String(snapshotAccount.email || snapshotAccount.upstreamAccountId || '').trim()
      }
    );
  }

  function enqueueCodexAuthInvalidReconcile(cliName, id, reason) {
    if (cliName !== 'codex') return false;
    if (!codexAuthInvalidReconciler || typeof codexAuthInvalidReconciler.enqueueUsageProbeFailure !== 'function') {
      return false;
    }
    return codexAuthInvalidReconciler.enqueueUsageProbeFailure(cliName, id, reason);
  }

  function markCodexAuthInvalidIfUsageProbeError(cliName, id, probeError) {
    const detail = String(probeError || '').trim();
    if (!isCodexAuthProbeError(detail)) return false;
    const reason = detail.includes('auth_invalid_reauth_required')
      ? detail
      : `auth_invalid_reauth_required:${detail.slice(0, 220)}`;
    const recorded = markCodexAuthInvalidFromUsageProbe(cliName, id, reason);
    enqueueCodexAuthInvalidReconcile(cliName, id, reason);
    return recorded;
  }

  function markFirstCodexAuthInvalidUsageProbeError(cliName, id, probeErrors) {
    const errors = Array.isArray(probeErrors) ? probeErrors : [];
    for (const probeError of errors) {
      if (markCodexAuthInvalidIfUsageProbeError(cliName, id, probeError)) return true;
    }
    return false;
  }

  function isCodexAuthProbeError(message) {
    const lower = String(message || '').trim().toLowerCase();
    return lower.includes('direct_http_status_401')
      || lower.includes('direct_http_status_403')
      || lower.includes('http_401')
      || lower.includes('http_403')
      || lower.includes('invalid_token')
      || lower.includes('unauthorized')
      || lower.includes('token_invalidated');
  }

  function isCodexDirectHttp401ProbeError(message) {
    return String(message || '').trim().toLowerCase().includes('direct_http_status_401');
  }

  function isCodexAuthInvalidReauthRequiredReason(message) {
    return String(message || '').trim().toLowerCase().includes('auth_invalid_reauth_required');
  }

  function getIndexedCodexRuntimeStatus(cliName, id) {
    if (cliName !== 'codex' || typeof getAccountStateIndex !== 'function') return null;
    try {
      const index = getAccountStateIndex();
      if (!index || typeof index.getAccountState !== 'function') return null;
      const state = index.getAccountState(id);
      if (!state) return null;
      return deriveRuntimeStatus(state);
    } catch (_error) {
      return null;
    }
  }

  function enqueueIndexedCodexAuthInvalidReconcile(cliName, id) {
    const runtimeStatus = getIndexedCodexRuntimeStatus(cliName, id);
    if (!runtimeStatus || runtimeStatus.status !== 'auth_invalid') return false;
    if (!isCodexAuthInvalidReauthRequiredReason(runtimeStatus.reason)) return false;
    if (!codexAuthInvalidReconciler || typeof codexAuthInvalidReconciler.enqueueAuthInvalidReauthRequired !== 'function') {
      return false;
    }
    return codexAuthInvalidReconciler.enqueueAuthInvalidReauthRequired(cliName, id, runtimeStatus.reason);
  }

  function normalizeGeminiModelId(modelId) {
    if (!modelId) return '';
    return String(modelId).replace(/_vertex$/i, '');
  }

  function formatResetInFromIso(resetTime) {
    const target = new Date(resetTime).getTime();
    if (!Number.isFinite(target)) return 'unknown';
    const diffMs = Math.max(0, target - Date.now());
    const totalMinutes = Math.ceil(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return 'soon';
  }

  function parseResetAtMsFromIso(resetTime) {
    const target = new Date(resetTime).getTime();
    if (!Number.isFinite(target) || target <= 0) return null;
    return target;
  }

  function formatResetInFromUnixSeconds(resetAtSeconds) {
    const resetSec = Number(resetAtSeconds);
    if (!Number.isFinite(resetSec) || resetSec <= 0) return 'unknown';
    const target = resetSec * 1000;
    const diffMs = Math.max(0, target - Date.now());
    const totalMinutes = Math.ceil(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return 'soon';
  }

  function parseResetAtMsFromUnixSeconds(resetAtSeconds) {
    const resetSec = Number(resetAtSeconds);
    if (!Number.isFinite(resetSec) || resetSec <= 0) return null;
    return resetSec * 1000;
  }

  function parseDurationMsFromResetIn(resetInText) {
    const text = String(resetInText || '').trim().toLowerCase();
    if (!text || text === 'unknown' || text === 'soon') return null;
    const re = /(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)/g;
    let totalMs = 0;
    let matched = false;
    let m = null;
    while ((m = re.exec(text)) !== null) {
      matched = true;
      const value = Number(m[1]);
      const unit = String(m[2] || '');
      if (!Number.isFinite(value) || value < 0) continue;
      if (unit.startsWith('d')) totalMs += value * 24 * 60 * 60 * 1000;
      else if (unit.startsWith('h')) totalMs += value * 60 * 60 * 1000;
      else if (unit.startsWith('m')) totalMs += value * 60 * 1000;
      else if (unit.startsWith('s')) totalMs += value * 1000;
    }
    if (!matched || totalMs <= 0) return null;
    return totalMs;
  }

  function deriveResetAtMsFromEntry(entry, capturedAt) {
    const direct = Number(entry && entry.resetAtMs);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const base = Number(capturedAt);
    if (!Number.isFinite(base) || base <= 0) return null;
    const fromText = parseDurationMsFromResetIn(entry && entry.resetIn);
    if (!Number.isFinite(fromText) || fromText <= 0) return null;
    return base + fromText;
  }

  function parseGeminiQuotaBuckets(buckets) {
    if (!Array.isArray(buckets)) return null;
    const modelMap = new Map();
    buckets.forEach((bucket) => {
      if (!bucket || typeof bucket.modelId !== 'string') return;
      if (!Number.isFinite(bucket.remainingFraction)) return;
      if (!bucket.resetTime) return;

      const model = normalizeGeminiModelId(bucket.modelId);
      if (!model.startsWith('gemini-')) return;

      const remainingPct = Math.max(0, Math.min(100, bucket.remainingFraction * 100));
      const next = {
        model,
        remainingPct,
        resetIn: formatResetInFromIso(bucket.resetTime),
        resetTime: bucket.resetTime
      };

      const prev = modelMap.get(model);
      if (!prev) {
        modelMap.set(model, next);
        return;
      }

      if (next.remainingPct < prev.remainingPct) {
        modelMap.set(model, next);
        return;
      }

      if (next.remainingPct === prev.remainingPct && String(next.resetTime) < String(prev.resetTime)) {
        modelMap.set(model, next);
      }
    });

    const models = Array.from(modelMap.values())
      .sort((a, b) => a.model.localeCompare(b.model))
      .map(({ model, remainingPct, resetIn, resetTime }) => ({
        model,
        remainingPct,
        resetIn,
        resetAtMs: parseResetAtMsFromIso(resetTime)
      }));

    if (models.length === 0) return null;
    return {
      schemaVersion: usageSnapshotSchemaVersion,
      kind: 'gemini_oauth_stats',
      source: usageSourceGemini,
      capturedAt: Date.now(),
      models
    };
  }

  function readAccountEnv(accountRef) {
    return readAccountCredentials(fs, aiHomeDir, accountRef);
  }

  function readAccountEnvToken(accountRef, keys) {
    const readToken = (env) => {
      if (!env || typeof env !== 'object') return '';
      for (const key of keys) {
        const token = sanitizeAccessToken(env[key] || '');
        if (token) return token;
      }
      return '';
    };

    const credentials = readAccountEnv(accountRef);
    const token = readToken(credentials);
    if (token) return { token, source: 'app-state.db' };
    return { token: '', source: '' };
  }

  function readAgyAccessTokenForSandbox(cliName, id, options = {}) {
    if (cliName !== 'agy') return null;
    const accountRef = String(id || '').trim();
    if (!isAccountRef(accountRef)) return null;
    const runtimeDir = getProfileDir(cliName, accountRef);
    const envTokenInfo = readAccountEnvToken(accountRef, ['AGY_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']);
    const envToken = envTokenInfo.token;
    const configDir = getToolConfigDir(cliName, accountRef);
    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
    const oauth = nativeAuth.oauthToken;
    const token = oauth && oauth.token && typeof oauth.token === 'object' ? oauth.token : {};
    const oauthToken = sanitizeAccessToken(token.access_token || '');
    const preferOAuthFile = !!(options && options.preferOAuthFile);
    const accessToken = preferOAuthFile ? (oauthToken || envToken) : (envToken || oauthToken);
    if (!accessToken) return null;
    return {
      accessToken,
      tokenSource: accessToken === oauthToken ? 'app-state.db:native-auth' : envTokenInfo.source,
      configDir,
      runtimeDir,
      accountRef,
      email: String(nativeAuth.email || '').trim(),
      tokenExpiresAt: parseResetAtMsFromIso(token.expiry)
    };
  }

  function formatIsoOrEmpty(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    return new Date(numeric).toISOString();
  }

  function buildAgyUsagePreflight(cliName, id) {
    if (cliName !== 'agy') return null;
    const accountRef = String(id || '').trim();
    if (!isAccountRef(accountRef)) return null;
    const runtimeDir = getProfileDir(cliName, accountRef);
    const configDir = getToolConfigDir(cliName, accountRef);
    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
    const oauth = nativeAuth.oauthToken;
    const token = oauth && oauth.token && typeof oauth.token === 'object' ? oauth.token : {};
    const envToken = readAccountEnvToken(accountRef, ['AGY_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']).token;
    const oauthToken = sanitizeAccessToken(token.access_token || '');
    const refreshToken = sanitizeAccessToken(token.refresh_token || '');
    const auth = readAgyAccessTokenForSandbox(cliName, id);
    const expiresAtMs = parseResetAtMsFromIso(token.expiry);
    const nowMs = Date.now();
    const refreshSkewMs = 5 * 60 * 1000;
    const cache = readUsageCache(cliName, id);
    const baseUrls = resolveAgyQuotaBaseUrls({
      agyQuotaBaseUrls: processObj.env.AIH_AGY_QUOTA_BASE_URLS,
      agyQuotaBaseUrl: processObj.env.AIH_AGY_QUOTA_BASE_URL,
      agyBaseUrl: processObj.env.AIH_AGY_BASE_URL,
      env: processObj.env
    }, {});

    return {
      provider: 'agy',
      accountRef,
      runtimeDir,
      configDir,
      nativeAuthPresent: !!oauth,
      envAccessTokenPresent: !!envToken,
      nativeAccessTokenPresent: !!oauthToken,
      refreshTokenPresent: !!refreshToken,
      selectedTokenSource: auth && auth.tokenSource || '',
      emailPresent: !!String(nativeAuth.email || '').trim(),
      tokenExpiresAt: formatIsoOrEmpty(expiresAtMs),
      tokenExpired: Number.isFinite(expiresAtMs) ? expiresAtMs <= nowMs : null,
      refreshDue: Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs <= refreshSkewMs : false,
      usageCachePresent: !!cache,
      usageCacheKind: cache && cache.kind || '',
      usageCacheCapturedAt: formatIsoOrEmpty(cache && cache.capturedAt),
      quotaBaseUrls: baseUrls,
      codeAssistClientVersion: httpUtilsPrivate.buildAgyCodeAssistClientVersion(),
      codeAssistUserAgent: httpUtilsPrivate.buildAgyCodeAssistUserAgent()
    };
  }

  async function refreshAgyTokenForUsageIfNeeded(cliName, id, auth, refreshOptions = {}) {
    if (cliName !== 'agy') return null;
    if (!auth || !auth.configDir || typeof refreshAgyAccessTokenImpl !== 'function') return null;
    if (typeof fetchWithTimeoutImpl !== 'function') return null;
    const result = await refreshAgyAccessTokenImpl({
      id: String(id || '').trim(),
      accountRef: String(id || '').trim(),
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: auth.accessToken,
      email: auth.email,
      configDir: auth.configDir,
      tokenExpiresAt: auth.tokenExpiresAt
    }, {
      force: !!(refreshOptions && refreshOptions.force),
      timeoutMs: Number(processObj.env.AIH_AGY_TOKEN_REFRESH_TIMEOUT_MS || processObj.env.AIH_AGY_USAGE_HTTP_TIMEOUT_MS || 15000),
      proxyUrl: processObj.env.AIH_SERVER_PROXY_URL || processObj.env.HTTPS_PROXY || processObj.env.HTTP_PROXY,
      noProxy: processObj.env.AIH_SERVER_NO_PROXY || processObj.env.NO_PROXY
    }, {
      fetchWithTimeout: fetchWithTimeoutImpl,
      accountArtifactHooks,
      fs,
      aiHomeDir
    });
    if (!result || !result.ok || !result.refreshed) return null;
    return readAgyAccessTokenForSandbox(cliName, id, { preferOAuthFile: true }) || auth;
  }

  function isAgyAuthProbeError(error) {
    const status = Number(error && error.status);
    if (status === 401 || status === 403) return true;
    const text = String((error && (error.code || error.message)) || error || '').toLowerCase();
    return text.includes('http_401')
      || text.includes('http 401')
      || text.includes('http_403')
      || text.includes('http 403')
      || text.includes('unauthorized')
      || text.includes('invalid_token');
  }

  async function refreshAgyUsageSnapshotAsync(cliName, id) {
    if (cliName !== 'agy') return null;
    let auth = readAgyAccessTokenForSandbox(cliName, id);
    if (!auth || !auth.accessToken) {
      setProbeError(cliName, id, 'missing_access_token');
      return null;
    }
    if (typeof fetchWithImpl !== 'function') {
      setProbeError(cliName, id, 'fetch_unavailable');
      return null;
    }

    const timeoutMsRaw = Number(processObj.env.AIH_AGY_USAGE_HTTP_TIMEOUT_MS || '8000');
    const timeoutMs = Number.isFinite(timeoutMsRaw)
      ? Math.max(1000, Math.min(30000, Math.floor(timeoutMsRaw)))
      : 8000;

    try {
      const refreshedAuth = await refreshAgyTokenForUsageIfNeeded(cliName, id, auth);
      if (refreshedAuth && refreshedAuth.accessToken) {
        auth = refreshedAuth;
      }
      const snapshot = await fetchAgyCodeAssistQuotaSnapshot({
        fetchImpl: fetchWithImpl,
        schemaVersion: usageSnapshotSchemaVersion,
        source: usageSourceAgyCodeAssist || 'agy_fetch_available_models',
        agyQuotaBaseUrls: processObj.env.AIH_AGY_QUOTA_BASE_URLS,
        agyQuotaBaseUrl: processObj.env.AIH_AGY_QUOTA_BASE_URL,
        agyBaseUrl: processObj.env.AIH_AGY_BASE_URL,
        env: processObj.env
      }, {
        provider: 'agy',
        authType: 'oauth-personal',
        accessToken: auth.accessToken,
        email: auth.email,
        configDir: auth.configDir,
        tokenExpiresAt: auth.tokenExpiresAt
      }, timeoutMs);
      if (!snapshot) {
        setProbeError(cliName, id, 'empty_parsed_snapshot');
        return null;
      }
      writeUsageCache(cliName, id, snapshot);
      setProbeError(cliName, id, '');
      clearRuntimeStateForVerifiedSnapshot(cliName, id, snapshot);
      return snapshot;
    } catch (error) {
      if (isAgyAuthProbeError(error)) {
        const refreshedAuth = await refreshAgyTokenForUsageIfNeeded(cliName, id, auth, { force: true });
        if (refreshedAuth && refreshedAuth.accessToken && refreshedAuth.accessToken !== auth.accessToken) {
          try {
            const snapshot = await fetchAgyCodeAssistQuotaSnapshot({
              fetchImpl: fetchWithImpl,
              schemaVersion: usageSnapshotSchemaVersion,
              source: usageSourceAgyCodeAssist || 'agy_fetch_available_models',
              agyQuotaBaseUrls: processObj.env.AIH_AGY_QUOTA_BASE_URLS,
              agyQuotaBaseUrl: processObj.env.AIH_AGY_QUOTA_BASE_URL,
              agyBaseUrl: processObj.env.AIH_AGY_BASE_URL,
              env: processObj.env
            }, {
              provider: 'agy',
              authType: 'oauth-personal',
              accessToken: refreshedAuth.accessToken,
              email: refreshedAuth.email,
              configDir: refreshedAuth.configDir,
              tokenExpiresAt: refreshedAuth.tokenExpiresAt
            }, timeoutMs);
            if (snapshot) {
              writeUsageCache(cliName, id, snapshot);
              setProbeError(cliName, id, '');
              clearRuntimeStateForVerifiedSnapshot(cliName, id, snapshot);
              return snapshot;
            }
          } catch (retryError) {
            setProbeError(cliName, id, String((retryError && retryError.message) || retryError || 'agy_quota_probe_failed_after_refresh'));
            return null;
          }
        }
      }
      setProbeError(cliName, id, String((error && error.message) || error || 'agy_quota_probe_failed'));
      return null;
    }
  }

  function refreshGeminiUsageSnapshot(cliName, id) {
    if (cliName !== 'gemini') return null;
    const accountRef = String(id || '').trim();
    if (!isAccountRef(accountRef)) return null;
    const oauthPayload = readAccountNativeAuth(fs, aiHomeDir, accountRef).oauthCreds;

    const token = oauthPayload && oauthPayload.access_token;
    if (!token) return null;

    const probeScript = `
const token = process.env.AIH_GEMINI_OAUTH_TOKEN;
const projectId = process.env.AIH_GEMINI_PROJECT_ID || '{{projectId}}';
const timeoutMs = 8000;

function print(payload) {
  console.log('AIH_QUOTA_JSON_START');
  console.log(JSON.stringify(payload));
  console.log('AIH_QUOTA_JSON_END');
}

(async () => {
  if (!token) {
    print({ ok: false, error: 'missing_token' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ project: projectId }),
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!res.ok) {
      print({ ok: false, status: res.status, error: (json && json.error && json.error.message) || text });
      return;
    }
    print({ ok: true, buckets: (json && json.buckets) || [] });
  } catch (e) {
    print({ ok: false, error: String((e && e.message) || e) });
  } finally {
    clearTimeout(timer);
  }
})();
`;

    try {
      const run = spawnSync(processObj.execPath, ['-e', probeScript], {
        cwd: processObj.cwd(),
        env: {
          ...processObj.env,
          AIH_GEMINI_OAUTH_TOKEN: token,
          AIH_GEMINI_PROJECT_ID: '{{projectId}}'
        },
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024
      });

      const joined = `${run.stdout || ''}\n${run.stderr || ''}`;
      const m = joined.match(/AIH_QUOTA_JSON_START\s*([\s\S]*?)\s*AIH_QUOTA_JSON_END/);
      if (!m) {
        setProbeError(cliName, id, joined || 'missing_probe_output');
        return null;
      }

      const parsedOutput = JSON.parse(m[1]);
      if (!parsedOutput || parsedOutput.ok !== true) {
        setProbeError(cliName, id, parsedOutput && parsedOutput.error ? String(parsedOutput.error) : 'probe_not_ok');
        return null;
      }

      const parsed = parseGeminiQuotaBuckets(parsedOutput.buckets || []);
      if (!parsed) {
        setProbeError(cliName, id, 'empty_parsed_snapshot');
        return null;
      }

      writeUsageCache(cliName, id, parsed);
      setProbeError(cliName, id, '');
      clearRuntimeStateForVerifiedSnapshot(cliName, id, parsed);
      return parsed;
    } catch (_error) {
      setProbeError(cliName, id, 'probe_exception');
      return null;
    }
  }

  function formatCodexWindow(windowMinutes) {
    const minutes = Number(windowMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return String(windowMinutes);
    if (minutes % 1440 === 0) return `${Math.round(minutes / 1440)}days`;
    if (minutes % 60 === 0) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes)}m`;
  }

  function normalizeCodexRateLimitWindow(bucket) {
    if (!bucket || typeof bucket !== 'object') return null;
    const windowMinutesRaw = bucket.window_minutes ?? bucket.windowDurationMins;
    const usedPctRaw = bucket.used_percent ?? bucket.usedPercent;
    const resetsAtRaw = bucket.resets_at ?? bucket.resetsAt;

    const windowMinutes = Number(windowMinutesRaw);
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;

    const usedPctNumber = Number(usedPctRaw);
    const usedPct = Number.isFinite(usedPctNumber)
      ? Math.max(0, Math.min(100, usedPctNumber))
      : null;

    return {
      windowMinutes,
      usedPct,
      resetsAt: resetsAtRaw
    };
  }

  function parseCodexRateLimits(rateLimits, capturedAt, source) {
    if (!rateLimits || typeof rateLimits !== 'object') return null;
    const entries = [];
    ['primary', 'secondary'].forEach((bucketName) => {
      const normalizedBucket = normalizeCodexRateLimitWindow(rateLimits[bucketName]);
      if (!normalizedBucket) return;
      const { windowMinutes, usedPct, resetsAt } = normalizedBucket;
      const remainingPct = typeof usedPct === 'number'
        ? Math.max(0, Math.min(100, 100 - usedPct))
        : null;

      entries.push({
        bucket: bucketName,
        windowMinutes,
        window: formatCodexWindow(windowMinutes),
        remainingPct,
        resetIn: formatResetInFromUnixSeconds(resetsAt),
        resetAtMs: parseResetAtMsFromUnixSeconds(resetsAt)
      });
    });

    if (entries.length === 0) return null;
    return {
      schemaVersion: usageSnapshotSchemaVersion,
      kind: 'codex_oauth_status',
      capturedAt: capturedAt || Date.now(),
      source: source || usageSourceCodex,
      account: null,
      entries
    };
  }

  function parseCodexAccountFallback(account, capturedAt, source, authJson) {
    return buildCodexMetadataFallbackSnapshot({
      schemaVersion: usageSnapshotSchemaVersion,
      capturedAt: capturedAt || Date.now(),
      source: source || usageSourceCodex,
      fallbackSource: 'account_read',
      account,
      authJson
    });
  }

  function readCodexAuthJsonForSandbox(cliName, id) {
    if (cliName !== 'codex') return null;
    return readAccountNativeAuth(fs, aiHomeDir, id).auth || null;
  }

  function resolveUsageRuntime(cliName, id) {
    const accountEnv = readAccountEnv(id);
    const projectionDir = getProfileDir(cliName, id);
    const runtime = resolveProviderRuntimeScope(cliName, projectionDir, processObj.env, {
      path,
      platform: processObj.platform,
      accountEnv
    });
    return { ...runtime, accountEnv };
  }

  function refreshCodexUsageSnapshotFromAppServer(cliName, id) {
    if (cliName !== 'codex') return null;
    const runtime = resolveUsageRuntime(cliName, id);
    const sandboxDir = runtime.runtimeDir;
    try {
      prepareProviderRuntime('codex', sandboxDir, processObj.env, {
        path,
        fs,
        aiHomeDir,
        accountRef: id,
        accountEnv: runtime.accountEnv,
        materializeAuth: runtime.projectionRequired
      });
    } catch (_error) {
      return null;
    }

    const codexBin = resolveCliPath('codex');
    if (!codexBin) return null;

    const probeScript = `
const { spawn } = require('child_process');

const codexBin = process.env.AIH_CODEX_BIN;
const codexHome = process.env.AIH_CODEX_HOME;

const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  CODEX_SQLITE_HOME: process.env.AIH_CODEX_SQLITE_HOME || ''
};

function print(payload) {
  console.log('AIH_CODEX_RATE_LIMIT_JSON_START');
  console.log(JSON.stringify(payload));
  console.log('AIH_CODEX_RATE_LIMIT_JSON_END');
}

let done = false;
function finish(payload) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try {
    child.kill('SIGTERM');
  } catch (e) {}
  print(payload);
}

function quoteForCmd(arg) {
  const text = String(arg || '');
  if (!text) return '""';
  if (/^[A-Za-z0-9._:/\\\\-]+$/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function startCodexAppServer() {
  if (process.platform === 'win32') {
    const line = [quoteForCmd(codexBin), 'app-server', '--listen', 'stdio://'].join(' ');
    return spawn('cmd.exe', ['/d', '/s', '/c', line], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });
  }
  return spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });
}

const child = startCodexAppServer();

let stdoutBuf = '';
let stderrBuf = '';
let accountReadRequested = false;
const timer = setTimeout(() => {
  finish({ ok: false, error: 'timeout' });
}, 9000);

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');

child.stderr.on('data', (chunk) => {
  stderrBuf += String(chunk || '');
});

child.stdout.on('data', (chunk) => {
  stdoutBuf += String(chunk || '');
  let idx = -1;
  while ((idx = stdoutBuf.indexOf('\\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (msg && msg.id === 'aih_init') {
      child.stdin.write(JSON.stringify({ method: 'account/rateLimits/read', id: 'aih_rate' }) + '\\n');
      continue;
    }
    if (msg && msg.id === 'aih_rate') {
      if (msg.result && msg.result.rateLimits) {
        finish({ ok: true, rateLimits: msg.result.rateLimits });
      } else {
        if (!accountReadRequested) {
          accountReadRequested = true;
          child.stdin.write(JSON.stringify({ method: 'account/read', id: 'aih_account', params: {} }) + '\\n');
        } else if (msg.error) {
          finish({ ok: false, error: String(msg.error.message || msg.error.code || 'rate_limit_read_failed') });
        } else {
          finish({ ok: false, error: 'empty_rate_limit_response' });
        }
      }
      return;
    }
    if (msg && msg.id === 'aih_account') {
      if (msg.result && msg.result.account) {
        finish({ ok: true, account: msg.result.account, fallback: 'account_read' });
      } else if (msg.error) {
        finish({ ok: false, error: String(msg.error.message || msg.error.code || 'account_read_failed') });
      } else {
        finish({ ok: false, error: 'empty_account_response' });
      }
      return;
    }
  }
});

child.on('error', (err) => {
  finish({ ok: false, error: String((err && err.message) || err) });
});

child.on('exit', (code) => {
  if (done) return;
  const detail = stderrBuf || stdoutBuf || '';
  finish({ ok: false, error: code === 0 ? 'no_rate_limit_response' : ('app_server_exit_' + String(code)), detail });
});

child.stdin.write(JSON.stringify({
  method: 'initialize',
  id: 'aih_init',
  params: {
    clientInfo: { name: 'aih-probe', version: '1.0.0' },
    capabilities: null
  }
}) + '\\n');
`;

    const codexSqliteHome = resolveCodexSqliteHome({ path, aiHomeDir });
    const envOverrides = buildProviderRuntimeEnv('codex', sandboxDir, processObj.env, {
      path,
      platform: processObj.platform,
      aiHomeDir,
      accountRef: id,
      accountEnv: runtime.accountEnv,
      codexSqliteHome,
      extraEnv: {
        AIH_CODEX_BIN: codexBin,
        AIH_CODEX_HOME: path.join(sandboxDir, '.codex'),
        AIH_CODEX_SQLITE_HOME: codexSqliteHome
      }
    });

    try {
      const run = spawnSync(processObj.execPath, ['-e', probeScript], {
        cwd: processObj.cwd(),
        env: envOverrides,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024
      });

      const joined = `${run.stdout || ''}\n${run.stderr || ''}`;
      const m = joined.match(/AIH_CODEX_RATE_LIMIT_JSON_START\s*([\s\S]*?)\s*AIH_CODEX_RATE_LIMIT_JSON_END/);
      if (!m) {
        setProbeError(cliName, id, joined || 'missing_probe_output');
        return null;
      }

      const parsedOutput = JSON.parse(m[1]);
      if (!parsedOutput || parsedOutput.ok !== true) {
        setProbeError(cliName, id, parsedOutput && (parsedOutput.error || parsedOutput.detail) ? `${parsedOutput.error || ''} ${parsedOutput.detail || ''}` : 'probe_not_ok');
        return null;
      }

      let parsed = null;
      if (parsedOutput.rateLimits) {
        parsed = parseCodexRateLimits(parsedOutput.rateLimits, Date.now(), usageSourceCodex);
      }
      if (!parsed && parsedOutput.account) {
        parsed = parseCodexAccountFallback(
          parsedOutput.account,
          Date.now(),
          usageSourceCodex,
          readCodexAuthJsonForSandbox(cliName, id)
        );
      }
      if (!parsed) {
        setProbeError(cliName, id, 'empty_parsed_snapshot');
        return null;
      }

      writeUsageCache(cliName, id, parsed);
      setProbeError(cliName, id, '');
      clearRuntimeStateForVerifiedSnapshot(cliName, id, parsed);
      return parsed;
    } catch (_error) {
      setProbeError(cliName, id, 'probe_exception');
      return null;
    }
  }

  function refreshCodexUsageSnapshot(cliName, id) {
    if (cliName !== 'codex') return null;
    return refreshCodexUsageSnapshotFromAppServer(cliName, id);
  }

  function sanitizeAccessToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token) return '';
    if (/[\r\n\0]/.test(token)) return '';
    return token;
  }

  async function fetchWithOptionalCustomFetch(url, init, timeoutMs) {
    const globalFetch = typeof fetch === 'function' ? fetch : null;
    const hasCustomFetch = typeof fetchWithImpl === 'function' && fetchWithImpl !== globalFetch;
    if (hasCustomFetch) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchWithImpl(url, {
          ...init,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
    }
    return fetchWithTimeoutImpl(url, init, timeoutMs);
  }

  function readCodexAuthForSandbox(cliName, id) {
    if (cliName !== 'codex') return null;
    const authJson = readCodexAuthJsonForSandbox(cliName, id);
    const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
    if (!tokens) return null;
    const accessToken = sanitizeAccessToken(tokens.access_token || '');
    if (!accessToken) return null;
    return {
      accessToken,
      upstreamAccountId: String(tokens.account_id || '').trim(),
      authJson
    };
  }

  async function refreshCodexTokenForSandbox(cliName, id) {
    if (cliName !== 'codex') return false;
    if (typeof fetchWithImpl !== 'function' && typeof fetchWithTimeoutImpl !== 'function') return false;
    const accountRef = String(id || '').trim();
    if (!isAccountRef(accountRef)) return false;
    const authPath = path.join(aiHomeDir, 'run', 'codex', `${accountRef}.auth`);

    const readAuth = () => {
      const authJson = readAccountNativeAuth(fs, aiHomeDir, accountRef).auth || null;
      const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
      return { authJson, tokens };
    };
    const initial = readAuth();
    const initialAccessToken = sanitizeAccessToken(initial.tokens && initial.tokens.access_token || '');
    if (!initial.tokens) return false;

    const timeoutRaw = Number(processObj.env.AIH_CODEX_TOKEN_REFRESH_TIMEOUT_MS || '7000');
    const timeoutMs = Number.isFinite(timeoutRaw)
      ? Math.max(2000, Math.min(30000, Math.floor(timeoutRaw)))
      : 7000;

    const refreshWithCurrentAuth = async () => {
      const current = readAuth();
      const authJson = current.authJson;
      const tokens = current.tokens;
      if (!tokens) return false;
      const accessToken = sanitizeAccessToken(tokens.access_token || '');
      if (initialAccessToken && accessToken && accessToken !== initialAccessToken) {
        return true;
      }
      const refreshToken = normalizeCodexRefreshToken(tokens.refresh_token);
      if (!refreshToken) return false;
      const payload = decodeJwtPayloadUnsafe(accessToken);
      const clientId = String(payload && payload.client_id || '').trim() || DEFAULT_CODEX_CLIENT_ID;

      try {
        const response = await fetchWithOptionalCustomFetch(String(processObj.env.AIH_CODEX_TOKEN_URL || DEFAULT_OPENAI_OAUTH_TOKEN_URL), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify({
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            scope: 'openid profile email offline_access'
          })
        }, timeoutMs);
        if (!response || !response.ok) return false;
        const text = await response.text();
        let next = null;
        try {
          next = JSON.parse(text);
        } catch (_error) {
          return false;
        }
        const nextAccess = sanitizeAccessToken(next && (next.access_token || next.accessToken) || '');
        if (!nextAccess) return false;
        const nextId = sanitizeAccessToken(next && (next.id_token || next.idToken) || '');
        const nextRefresh = normalizeCodexRefreshToken(next && (next.refresh_token || next.refreshToken) || '');

        const nextTokens = { ...tokens, access_token: nextAccess };
        if (nextId) nextTokens.id_token = nextId;
        if (nextRefresh) nextTokens.refresh_token = nextRefresh;
        const merged = {
          ...authJson,
          tokens: nextTokens,
          last_refresh: new Date().toISOString()
        };
        const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
        writeAccountNativeAuth(fs, aiHomeDir, accountRef, { ...nativeAuth, auth: merged });
        if (accountArtifactHooks && typeof accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
          accountArtifactHooks.notifyDefaultAccountAuthUpdated({
            provider: cliName,
            accountRef,
            artifactPath: 'app-state.db',
            source: 'usage_snapshot_token_refresh',
            reason: 'codex_oauth_token_refreshed'
          });
        }
        return true;
      } catch (_error) {
        return false;
      }
    };

    const locked = await withAuthRefreshLock(fs, path, authPath, refreshWithCurrentAuth, {
      timeoutMs: Math.max(timeoutMs, 30_000)
    });
    return locked.acquired ? !!locked.value : false;
  }

  function readCodexDirectMode() {
    return String(processObj.env.AIH_CODEX_USAGE_DIRECT || '1') !== '0';
  }

  function resolveCodexDirectBaseUrl(rateLimitPath = '') {
    const byUsage = String(processObj.env.AIH_CODEX_USAGE_BASE_URL || '').trim();
    if (byUsage) return byUsage.replace(/\/+$/, '');
    const byServer = String(processObj.env.AIH_SERVER_CODEX_BASE_URL || '').trim();
    if (byServer) return byServer.replace(/\/+$/, '');
    if (String(rateLimitPath || '').startsWith('/wham/')) return 'https://chatgpt.com/backend-api';
    return 'https://chatgpt.com/backend-api/codex';
  }

  function resolveCodexDirectRateLimitPath() {
    const byUsage = String(processObj.env.AIH_CODEX_USAGE_PATH || '').trim();
    if (byUsage) {
      if (byUsage.startsWith('/')) return byUsage;
      return `/${byUsage}`;
    }
    return '/wham/usage';
  }

  async function fetchCodexDirectUsage(url, init, timeoutMs) {
    return fetchWithOptionalCustomFetch(url, init, timeoutMs);
  }

  function normalizeCodexWhamUsageWindow(window) {
    if (!window || typeof window !== 'object') return null;
    const windowSeconds = Number(window.limit_window_seconds ?? window.limitWindowSeconds);
    const usedPct = Number(window.used_percent ?? window.usedPercent);
    const resetAt = window.reset_at ?? window.resetAt;
    const resetAfterSeconds = Number(window.reset_after_seconds ?? window.resetAfterSeconds);
    const normalized = {};

    if (Number.isFinite(windowSeconds) && windowSeconds > 0) {
      normalized.window_minutes = windowSeconds / 60;
    }
    if (Number.isFinite(usedPct)) {
      normalized.used_percent = usedPct;
    }
    if (resetAt != null && String(resetAt).trim() !== '') {
      normalized.resets_at = resetAt;
    } else if (Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0) {
      normalized.resets_at = Math.floor(Date.now() / 1000) + resetAfterSeconds;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  function extractRateLimitsFromWhamUsagePayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const usage = payload.rate_limit || payload.rateLimit;
    if (!usage || typeof usage !== 'object') return null;

    const primary = normalizeCodexWhamUsageWindow(usage.primary_window || usage.primaryWindow);
    const secondary = normalizeCodexWhamUsageWindow(usage.secondary_window || usage.secondaryWindow);
    const rateLimits = {};
    if (primary) rateLimits.primary = primary;
    if (secondary) rateLimits.secondary = secondary;
    return Object.keys(rateLimits).length > 0 ? rateLimits : null;
  }

  function extractRateLimitsFromDirectPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.rateLimits && typeof payload.rateLimits === 'object') return payload.rateLimits;
    if (payload.rate_limits && typeof payload.rate_limits === 'object') return payload.rate_limits;
    if (payload.result && payload.result.rateLimits && typeof payload.result.rateLimits === 'object') return payload.result.rateLimits;
    if (payload.result && payload.result.rate_limits && typeof payload.result.rate_limits === 'object') return payload.result.rate_limits;
    const whamRateLimits = extractRateLimitsFromWhamUsagePayload(payload);
    if (whamRateLimits) return whamRateLimits;
    return null;
  }

  function extractCodexAccountFromDirectPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const source = payload.account && typeof payload.account === 'object'
      ? payload.account
      : payload;
    const account = {
      planType: source.planType || source.plan_type,
      email: source.email,
      upstreamAccountId: source.upstreamAccountId || source.account_id,
      organizationId: source.organizationId || source.organization_id
    };
    return Object.values(account).some((value) => String(value || '').trim()) ? account : null;
  }

  async function refreshCodexUsageSnapshotFromDirectApiAsync(cliName, id, timeoutOverrideMs = null) {
    if (cliName !== 'codex') return null;
    if (!readCodexDirectMode()) return null;
    if (typeof fetchWithImpl !== 'function') return null;
    const auth = readCodexAuthForSandbox(cliName, id);
    if (!auth || !auth.accessToken) return null;

    const timeoutMsRaw = Number(timeoutOverrideMs) || Number(processObj.env.AIH_CODEX_USAGE_HTTP_TIMEOUT_MS || '60000');
    const timeoutMs = Number.isFinite(timeoutMsRaw)
      ? Math.max(1000, Math.min(60000, Math.floor(timeoutMsRaw)))
      : 60000;
    const rateLimitPath = resolveCodexDirectRateLimitPath();
    const url = `${resolveCodexDirectBaseUrl(rateLimitPath)}${rateLimitPath}`;

    try {
      const response = await fetchCodexDirectUsage(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          accept: 'application/json',
          version: '0.101.0',
          originator: 'codex_cli_rs',
          'user-agent': 'codex_cli_rs/0.101.0',
          ...(auth.upstreamAccountId ? { 'chatgpt-account-id': auth.upstreamAccountId } : {})
        }
      }, timeoutMs);
      if (!response || !response.ok) {
        setProbeError(cliName, id, `direct_http_status_${response ? response.status : 'unknown'}`);
        return null;
      }
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        setProbeError(cliName, id, 'direct_json_parse_failed');
        return null;
      }
      const rateLimits = extractRateLimitsFromDirectPayload(payload);
      if (!rateLimits) {
        setProbeError(cliName, id, 'direct_missing_rate_limits');
        return null;
      }
      return buildCodexSnapshotFromProbePayload(cliName, id, {
        ok: true,
        rateLimits,
        account: extractCodexAccountFromDirectPayload(payload)
      });
    } catch (error) {
      const code = String(error && (error.code || error.name || '') || '').trim();
      const message = String(error && error.message || '').trim();
      const detail = [code, message].filter(Boolean).join(': ').slice(0, 160);
      setProbeError(cliName, id, detail ? `direct_request_failed:${detail}` : 'direct_request_failed');
      return null;
    }
  }

  function buildCodexSnapshotFromProbePayload(cliName, id, payload) {
    if (!payload || payload.ok !== true) return null;
    const authJson = readCodexAuthJsonForSandbox(cliName, id);
    const snapshotAccount = buildCodexSnapshotAccount(payload.account, authJson);
    let parsed = null;
    if (payload.rateLimits) {
      parsed = parseCodexRateLimits(payload.rateLimits, Date.now(), usageSourceCodex);
      if (parsed && snapshotAccount) parsed.account = snapshotAccount;
    }
    if (!parsed && payload.account) {
      parsed = parseCodexAccountFallback(payload.account, Date.now(), usageSourceCodex, authJson);
    }
    if (!parsed) return null;
    writeUsageCache(cliName, id, parsed);
    setProbeError(cliName, id, '');
    clearRuntimeStateForVerifiedSnapshot(cliName, id, parsed);
    return parsed;
  }

  function createCodexProbeTimeoutMs(timeoutOverrideMs) {
    if (Number.isFinite(Number(timeoutOverrideMs)) && Number(timeoutOverrideMs) > 0) {
      return Math.max(1000, Math.min(60000, Math.floor(Number(timeoutOverrideMs))));
    }
    const value = Number(processObj.env.AIH_CODEX_USAGE_TIMEOUT_MS || '60000');
    if (!Number.isFinite(value)) return 60000;
    return Math.max(1000, Math.min(60000, Math.floor(value)));
  }

  function refreshCodexUsageSnapshotFromAppServerAsync(cliName, id, timeoutOverrideMs = null) {
    if (cliName !== 'codex') return Promise.resolve(null);
    const runtime = resolveUsageRuntime(cliName, id);
    const sandboxDir = runtime.runtimeDir;
    try {
      prepareProviderRuntime('codex', sandboxDir, processObj.env, {
        path,
        fs,
        aiHomeDir,
        accountRef: id,
        accountEnv: runtime.accountEnv,
        materializeAuth: runtime.projectionRequired
      });
    } catch (_error) {
      return Promise.resolve(null);
    }

    const codexBin = resolveCliPath('codex');
    if (!codexBin) return Promise.resolve(null);
    const codexSqliteHome = resolveCodexSqliteHome({ path, aiHomeDir });
    const codexEnv = buildProviderRuntimeEnv('codex', sandboxDir, processObj.env, {
      path,
      platform: processObj.platform,
      codexSqliteHome,
      aiHomeDir,
      accountRef: id,
      accountEnv: runtime.accountEnv
    });

    return new Promise((resolve) => {
      const timeoutMs = createCodexProbeTimeoutMs(timeoutOverrideMs);
      const launch = buildPtyLaunch(codexBin, ['app-server', '--listen', 'stdio://'], {
        platform: processObj.platform || process.platform
      });

      let child;
      try {
        child = spawnProcess(launch.command, launch.args, {
          cwd: processObj.cwd(),
          env: codexEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true  // Windows: 隐藏窗口
        });
      } catch (spawnError) {
        // 立即捕获 spawn 错误 (EINVAL 等)
        setProbeError(cliName, id, `spawn_error: ${String(spawnError.code || spawnError.message || spawnError)}`);
        resolve(null);
        return;
      }

      if (!child || !child.pid) {
        setProbeError(cliName, id, 'spawn_failed_no_pid');
        resolve(null);
        return;
      }

      let done = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let accountReadRequested = false;
      const finalize = (payload) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          child.stdin.end();
        } catch (_e) {}
        try {
          child.kill('SIGTERM');
        } catch (_e) {}
        const snapshot = buildCodexSnapshotFromProbePayload(cliName, id, payload);
        if (!snapshot) {
          setProbeError(cliName, id, payload && (payload.error || payload.detail) ? `${payload.error || ''} ${payload.detail || ''}` : 'probe_failed');
        } else {
          setProbeError(cliName, id, '');
        }
        resolve(snapshot || null);
      };

      const timer = setTimeout(() => {
        finalize({ ok: false, error: 'timeout' });
      }, timeoutMs);

      const writeRpc = (payload) => {
        if (done) return;
        try {
          if (!child.stdin || typeof child.stdin.write !== 'function' || child.stdin.destroyed || child.stdin.writableEnded) {
            finalize({ ok: false, error: 'stdin_write_failed' });
            return;
          }
          child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
            if (error) finalize({ ok: false, error: 'stdin_write_failed' });
          });
        } catch (_e) {
          finalize({ ok: false, error: 'stdin_write_failed' });
        }
      };

      const processLine = (lineText) => {
        if (!lineText || done) return;
        let msg = null;
        try {
          msg = JSON.parse(lineText);
        } catch (_e) {
          return;
        }
        if (msg && msg.id === 'aih_init') {
          writeRpc({ method: 'account/rateLimits/read', id: 'aih_rate' });
          return;
        }
        if (msg && msg.id === 'aih_rate') {
          if (msg.result && msg.result.rateLimits) {
            finalize({ ok: true, rateLimits: msg.result.rateLimits });
            return;
          }
          if (!accountReadRequested) {
            accountReadRequested = true;
            writeRpc({ method: 'account/read', id: 'aih_account', params: {} });
            return;
          }
          const err = msg && msg.error ? String(msg.error.message || msg.error.code || 'rate_limit_read_failed') : 'empty_rate_limit_response';
          finalize({ ok: false, error: err });
          return;
        }
        if (msg && msg.id === 'aih_account') {
          if (msg.result && msg.result.account) {
            finalize({ ok: true, account: msg.result.account, fallback: 'account_read' });
            return;
          }
          const err = msg && msg.error ? String(msg.error.message || msg.error.code || 'account_read_failed') : 'empty_account_response';
          finalize({ ok: false, error: err });
        }
      };

      if (child.stdout && typeof child.stdout.setEncoding === 'function') {
        child.stdout.setEncoding('utf8');
      }
      if (child.stderr && typeof child.stderr.setEncoding === 'function') {
        child.stderr.setEncoding('utf8');
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          stderrBuf += String(chunk || '');
        });
      }
      if (child.stdin && typeof child.stdin.on === 'function') {
        child.stdin.on('error', () => {
          finalize({ ok: false, error: 'stdin_write_failed' });
        });
      }
      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          stdoutBuf += String(chunk || '');
          let idx = -1;
          while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, idx).trim();
            stdoutBuf = stdoutBuf.slice(idx + 1);
            processLine(line);
          }
        });
      }

      child.on('error', (err) => {
        const errMsg = err && (err.code || err.message) ? `${err.code || 'UNKNOWN'}: ${err.message || ''}` : 'spawn_failed';
        finalize({ ok: false, error: errMsg });
      });
      child.on('exit', (code) => {
        if (done) return;
        const detail = stderrBuf || stdoutBuf || '';
        finalize({
          ok: false,
          error: code === 0 ? 'no_rate_limit_response' : `app_server_exit_${String(code)}`,
          detail
        });
      });

      writeRpc({
        method: 'initialize',
        id: 'aih_init',
        params: {
          clientInfo: { name: 'aih-probe', version: '1.0.0' },
          capabilities: null
        }
      });
    });
  }

  function toPercentNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (num <= 1) return Math.max(0, Math.min(100, num * 100));
    return Math.max(0, Math.min(100, num));
  }

  function readJsonFileSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  function parseClaudeProfileAccount(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const account = profile.account && typeof profile.account === 'object' ? profile.account : null;
    const organization = profile.organization && typeof profile.organization === 'object' ? profile.organization : null;
    const email = String((account && account.email) || '').trim();
    const fullName = String((account && (account.full_name || account.display_name)) || '').trim();
    let planType = '';
    if (account && account.has_claude_max) planType = 'max';
    else if (account && account.has_claude_pro) planType = 'pro';
    else if (organization && organization.organization_type) planType = String(organization.organization_type).trim();
    if (!email && !fullName && !planType) return null;
    return { email, fullName, planType };
  }

  function parseClaudeUsagePayload(payload, capturedAt, source, profile) {
    if (!payload || typeof payload !== 'object') return null;
    const fiveHourRaw = payload.five_hour || payload.fiveHour || null;
    const sevenDayRaw = payload.seven_day || payload.sevenDay || null;
    const entries = [];

    const fiveHourUtil = fiveHourRaw ? toPercentNumber(fiveHourRaw.utilization) : null;
    if (typeof fiveHourUtil === 'number') {
      entries.push({
        bucket: 'five_hour',
        windowMinutes: 300,
        window: '5h',
        remainingPct: Math.max(0, Math.min(100, 100 - fiveHourUtil)),
        resetIn: formatResetInFromIso(fiveHourRaw.resets_at || fiveHourRaw.resetsAt || null),
        resetAtMs: parseResetAtMsFromIso(fiveHourRaw.resets_at || fiveHourRaw.resetsAt || null)
      });
    }

    const sevenDayUtil = sevenDayRaw ? toPercentNumber(sevenDayRaw.utilization) : null;
    if (typeof sevenDayUtil === 'number') {
      entries.push({
        bucket: 'seven_day',
        windowMinutes: 10080,
        window: '7days',
        remainingPct: Math.max(0, Math.min(100, 100 - sevenDayUtil)),
        resetIn: formatResetInFromIso(sevenDayRaw.resets_at || sevenDayRaw.resetsAt || null),
        resetAtMs: parseResetAtMsFromIso(sevenDayRaw.resets_at || sevenDayRaw.resetsAt || null)
      });
    }

    if (entries.length === 0) return null;
    const snapshot = {
      schemaVersion: usageSnapshotSchemaVersion,
      kind: 'claude_oauth_usage',
      capturedAt: capturedAt || Date.now(),
      source: source || usageSourceClaudeOauth,
      entries
    };
    const account = parseClaudeProfileAccount(profile);
    if (account) snapshot.account = account;
    return snapshot;
  }

  function normalizeBaseUrl(baseUrlRaw, fallback) {
    if (typeof baseUrlRaw !== 'string') return fallback;
    const trimmed = baseUrlRaw.trim();
    return trimmed || fallback;
  }

  function isLocalHostBaseUrl(baseUrl) {
    return /^https?:\/\/(localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(baseUrl || ''));
  }

  function getClaudeUsageAuthForSandbox(cliName, id) {
    if (cliName !== 'claude') return null;
    const accountRef = String(id || '').trim();
    if (!isAccountRef(accountRef)) return null;
    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
    const credentials = nativeAuth.credentials || {};
    const oauth = credentials.claudeAiOauth || credentials.claude_ai_oauth;
    {
      const token = oauth && (oauth.accessToken || oauth.access_token);
      if (token && typeof token === 'string' && token.trim()) {
        return {
          token: token.trim(),
          baseUrl: 'https://api.anthropic.com',
          source: usageSourceClaudeOauth,
          mode: 'oauth_credentials'
        };
      }
    }

    const env = readAccountCredentials(fs, aiHomeDir, accountRef);
    const settingsToken = String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
    if (settingsToken) {
      const baseUrl = normalizeBaseUrl(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
      return {
        token: settingsToken,
        baseUrl,
        source: usageSourceClaudeAuthToken,
        mode: 'settings_env_token',
        isLocalProxy: isLocalHostBaseUrl(baseUrl)
      };
    }

    return null;
  }

  function isClaudeAuthProbeError(error) {
    const text = String(error || '').toLowerCase();
    return text.includes('"status":401')
      || text.includes('"status": 401')
      || text.includes('http_401')
      || text.includes('http 401')
      || text.includes('status 401')
      || text.includes('unauthorized')
      || text.includes('invalid_token')
      || text.includes('invalid_grant')
      || text.includes('"status":403')
      || text.includes('"status": 403');
  }

  // The claude usage probe calls /api/oauth/usage with the access token straight
  // from .credentials.json. When that token is expired the probe gets a 401 and
  // cannot recover on its own (the token-refresh daemon skips accounts marked
  // "down", so they deadlock). Refresh the OAuth token here — for both the CLI
  // `aih claude usage` path and the WebUI probe — mirroring the codex/agy flow.
  async function refreshClaudeTokenForUsageIfNeeded(cliName, id, opts = {}) {
    if (cliName !== 'claude') return false;
    if (typeof fetchWithTimeoutImpl !== 'function') return false;
    const accountRef = String(id || '').trim();
    if (!isAccountRef(accountRef)) return false;
    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
    const credentials = nativeAuth.credentials || {};
    const oauth = credentials.claudeAiOauth || credentials.claude_ai_oauth;
    if (!oauth) return false;
    const refreshToken = String(oauth.refreshToken || oauth.refresh_token || '').trim();
    if (!refreshToken) return false;
    const expiresAt = Number(oauth.expiresAt || oauth.expires_at) || 0;
    const force = !!opts.force;
    // Skip when the token still has comfortable runway, unless forced (post-401).
    if (!force && expiresAt && expiresAt - Date.now() > 60_000) return false;
    const account = {
      id: String(id),
      accountRef,
      provider: 'claude',
      accessToken: String(oauth.accessToken || oauth.access_token || ''),
      refreshToken,
      tokenExpiresAt: expiresAt
    };
    try {
      const result = await refreshClaudeAccessToken(account, {
        force: true,
        timeoutMs: Number(processObj.env.AIH_CLAUDE_TOKEN_REFRESH_TIMEOUT_MS || 15000),
        proxyUrl: processObj.env.AIH_SERVER_PROXY_URL || processObj.env.HTTPS_PROXY || processObj.env.HTTP_PROXY,
        noProxy: processObj.env.AIH_SERVER_NO_PROXY || processObj.env.NO_PROXY
      }, {
        fetchWithTimeout: fetchWithTimeoutImpl,
        accountArtifactHooks,
        fs,
        aiHomeDir
      });
      return !!(result && result.ok && result.refreshed);
    } catch (_error) {
      return false;
    }
  }

  function refreshClaudeUsageSnapshot(cliName, id) {
    if (cliName !== 'claude') return null;
    const sandboxDir = getProfileDir(cliName, id);
    const auth = getClaudeUsageAuthForSandbox(cliName, id);
    if (!auth || !auth.token) return null;

    const probeScript = `
const token = process.env.AIH_CLAUDE_OAUTH_TOKEN;
const baseUrlRaw = process.env.AIH_CLAUDE_API_BASE_URL || 'https://api.anthropic.com';
const baseUrl = String(baseUrlRaw).replace(/\\/+$/, '');
const url = baseUrl + '/api/oauth/usage';
const profileUrl = baseUrl + '/api/oauth/profile';
const timeoutMs = Number(process.env.AIH_CLAUDE_USAGE_TIMEOUT_MS || '8000');
const headers = {
  'Authorization': 'Bearer ' + token,
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'aih/1.0'
};

function print(payload) {
  console.log('AIH_CLAUDE_USAGE_JSON_START');
  console.log(JSON.stringify(payload));
  console.log('AIH_CLAUDE_USAGE_JSON_END');
}

// Best-effort identity lookup; never fails the usage probe.
async function fetchProfile() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(profileUrl, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  if (!token) {
    print({ ok: false, error: 'missing_token' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!res.ok) {
      print({ ok: false, status: res.status, body: json || text });
      return;
    }
    const profile = await fetchProfile();
    print({ ok: true, payload: json, profile });
  } catch (e) {
    print({ ok: false, error: String((e && e.message) || e) });
  } finally {
    clearTimeout(timer);
  }
})();
`;

    try {
      const envOverrides = buildProviderRuntimeEnv(cliName, sandboxDir, processObj.env, {
        path,
        platform: processObj.platform,
        aiHomeDir,
        accountRef: id,
        accountEnv: readAccountEnv(id),
        extraEnv: {
          AIH_CLAUDE_OAUTH_TOKEN: auth.token,
          AIH_CLAUDE_API_BASE_URL: auth.baseUrl || 'https://api.anthropic.com',
          AIH_CLAUDE_USAGE_TIMEOUT_MS: '8000'
        }
      });
      const run = spawnSync(processObj.execPath, ['-e', probeScript], {
        cwd: processObj.cwd(),
        env: envOverrides,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024
      });
      const joined = `${run.stdout || ''}\n${run.stderr || ''}`;
      const m = joined.match(/AIH_CLAUDE_USAGE_JSON_START\s*([\s\S]*?)\s*AIH_CLAUDE_USAGE_JSON_END/);
      if (!m) {
        setProbeError(cliName, id, joined || 'missing_probe_output');
        return null;
      }
      const parsed = JSON.parse(m[1]);
      if (!parsed || parsed.ok !== true || !parsed.payload) {
        setProbeError(cliName, id, parsed && (parsed.error || parsed.status) ? `${parsed.error || ''} ${parsed.status || ''}`.trim() : 'probe_not_ok');
        return null;
      }

      const snapshot = parseClaudeUsagePayload(parsed.payload, Date.now(), auth.source || usageSourceClaudeOauth, parsed.profile);
      if (!snapshot) {
        setProbeError(cliName, id, 'empty_parsed_snapshot');
        return null;
      }
      writeUsageCache(cliName, id, snapshot);
      setProbeError(cliName, id, '');
      clearRuntimeStateForVerifiedSnapshot(cliName, id, snapshot);
      return snapshot;
    } catch (_error) {
      setProbeError(cliName, id, 'probe_exception');
      return null;
    }
  }

  function ensureUsageSnapshot(cliName, id, cache, refreshOptions = {}) {
    const forceRefresh = !!(refreshOptions && refreshOptions.forceRefresh);
    if (cliName !== 'gemini' && cliName !== 'codex' && cliName !== 'claude' && cliName !== 'agy') return cache || null;
    if (cliName === 'agy') {
      const isMissing = !cache;
      const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
      if (!forceRefresh && !isMissing && !isStale) return cache;
      return cache || null;
    }
    if (cliName === 'claude') {
      const isMissing = !cache;
      const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
      if (!forceRefresh && !isMissing && !isStale) return cache;
      const refreshed = refreshClaudeUsageSnapshot(cliName, id);
      return refreshed || cache || null;
    }
    if (cliName === 'codex') {
      const isMissing = !cache;
      const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
      if (!forceRefresh && !isMissing && !isStale) return cache;
      const refreshed = refreshCodexUsageSnapshot(cliName, id);
      if (refreshed) return refreshed;
      if (shouldDiscardStaleDepletedCache(cache, isStale)) return null;
      return cache || null;
    }
    const isMissing = !cache;
    const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
    if (!forceRefresh && !isMissing && !isStale) return cache;
    const refreshed = refreshGeminiUsageSnapshot(cliName, id);
    return refreshed || cache || null;
  }

  async function ensureUsageSnapshotAsync(cliName, id, cache, refreshOptions = {}) {
    const forceRefresh = !!(refreshOptions && refreshOptions.forceRefresh);
    const probeTimeoutMs = Number(refreshOptions && refreshOptions.probeTimeoutMs) || null;
    if (cliName === 'agy') {
      const isMissing = !cache;
      const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
      if (!forceRefresh && !isMissing && !isStale) return cache;
      const refreshed = await refreshAgyUsageSnapshotAsync(cliName, id);
      return refreshed || cache || null;
    }
    if (cliName === 'codex') {
      const skipCodexAppServerFallback = Boolean(refreshOptions && refreshOptions.skipCodexAppServerFallback);
      const allowCodexTokenRefresh = !refreshOptions || refreshOptions.allowCodexTokenRefresh !== false;
      const isMissing = !cache;
      const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
      if (!forceRefresh && !isMissing && !isStale) return cache;
      const direct = await refreshCodexUsageSnapshotFromDirectApiAsync(cliName, id, probeTimeoutMs);
      if (direct) return direct;
      const directProbeError = getLastUsageProbeError(cliName, id);
      if (isCodexDirectHttp401ProbeError(directProbeError)) {
        markCodexAuthInvalidIfUsageProbeError(cliName, id, directProbeError);
        if (shouldDiscardStaleDepletedCache(cache, isStale)) return null;
        return cache || null;
      }
      enqueueIndexedCodexAuthInvalidReconcile(cliName, id);
      if (skipCodexAppServerFallback) {
        let authProbeError = directProbeError;
        if (allowCodexTokenRefresh && isCodexAuthProbeError(directProbeError)) {
          const tokenRefreshed = await refreshCodexTokenForSandbox(cliName, id);
          if (tokenRefreshed) {
            clearRecoveredRuntimeState(cliName, id, null, 'token_refresh_success');
            const directRetry = await refreshCodexUsageSnapshotFromDirectApiAsync(cliName, id, probeTimeoutMs);
            if (directRetry) return directRetry;
            authProbeError = getLastUsageProbeError(cliName, id);
            if (isCodexDirectHttp401ProbeError(authProbeError)) {
              markCodexAuthInvalidIfUsageProbeError(cliName, id, authProbeError);
              if (shouldDiscardStaleDepletedCache(cache, isStale)) return null;
              return cache || null;
            }
          } else {
            setProbeError(cliName, id, `${directProbeError || 'direct_auth_failed'} token_refresh_failed`);
            authProbeError = getLastUsageProbeError(cliName, id);
          }
        }
        markCodexAuthInvalidIfUsageProbeError(cliName, id, authProbeError);
        if (shouldDiscardStaleDepletedCache(cache, isStale)) return null;
        return cache || null;
      }
      const refreshed = await refreshCodexUsageSnapshotFromAppServerAsync(cliName, id);
      if (refreshed) {
        if (isCodexAccountReadFallbackSnapshot(refreshed) && isCodexAuthProbeError(directProbeError)) {
          if (allowCodexTokenRefresh) {
            const tokenRefreshedAfterFallback = await refreshCodexTokenForSandbox(cliName, id);
            if (tokenRefreshedAfterFallback) {
              clearRecoveredRuntimeState(cliName, id, refreshed, 'token_refresh_success');
              const directRetry = await refreshCodexUsageSnapshotFromDirectApiAsync(cliName, id);
              if (directRetry) return directRetry;
              const directRetryProbeError = getLastUsageProbeError(cliName, id);
              const appServerRetry = await refreshCodexUsageSnapshotFromAppServerAsync(cliName, id);
              if (appServerRetry) return appServerRetry;
              markCodexAuthInvalidIfUsageProbeError(cliName, id, directRetryProbeError);
            } else {
              setProbeError(
                cliName,
                id,
                `${directProbeError || 'direct_auth_failed'} refresh_failed_after_account_read_fallback`
              );
              markCodexAuthInvalidIfUsageProbeError(cliName, id, getLastUsageProbeError(cliName, id));
            }
          } else {
            markCodexAuthInvalidIfUsageProbeError(cliName, id, directProbeError);
          }
        }
        return refreshed;
      }

      const appServerProbeError = getLastUsageProbeError(cliName, id);
      let tokenRefreshed = false;
      let directRetryProbeError = '';
      if (allowCodexTokenRefresh) {
        tokenRefreshed = await refreshCodexTokenForSandbox(cliName, id);
      }
      if (tokenRefreshed) {
        clearRecoveredRuntimeState(cliName, id, null, 'token_refresh_success');
        const directRetry = await refreshCodexUsageSnapshotFromDirectApiAsync(cliName, id);
        if (directRetry) return directRetry;
        directRetryProbeError = getLastUsageProbeError(cliName, id);
        const appServerRetry = await refreshCodexUsageSnapshotFromAppServerAsync(cliName, id);
        if (appServerRetry) return appServerRetry;
      }
      if (!cache || forceRefresh) {
        const slowRetry = await refreshCodexUsageSnapshotFromAppServerAsync(cliName, id, Number(processObj.env.AIH_CODEX_USAGE_SLOW_RETRY_TIMEOUT_MS || '60000'));
        if (slowRetry) return slowRetry;
      }
      if (isCodexAuthProbeError(directRetryProbeError)) {
        markCodexAuthInvalidIfUsageProbeError(cliName, id, directRetryProbeError);
      } else if (!tokenRefreshed) {
        markFirstCodexAuthInvalidUsageProbeError(cliName, id, [directProbeError, appServerProbeError]);
      }
      if (shouldDiscardStaleDepletedCache(cache, isStale)) return null;
      return cache || null;
    }
    if (cliName === 'claude') {
      const isMissing = !cache;
      const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
      if (!forceRefresh && !isMissing && !isStale) return cache;
      // Proactively refresh an expired OAuth token before the probe runs.
      await refreshClaudeTokenForUsageIfNeeded(cliName, id);
      let refreshed = refreshClaudeUsageSnapshot(cliName, id);
      if (!refreshed && isClaudeAuthProbeError(getLastUsageProbeError(cliName, id))) {
        // Probe came back 401 — force a token refresh and retry once.
        if (await refreshClaudeTokenForUsageIfNeeded(cliName, id, { force: true })) {
          refreshed = refreshClaudeUsageSnapshot(cliName, id);
        }
      }
      return refreshed || cache || null;
    }
    return ensureUsageSnapshot(cliName, id, cache, refreshOptions);
  }

  function shouldDiscardStaleDepletedCache(cache, isStale) {
    if (!isStale || !cache || typeof cache !== 'object') return false;
    let values = [];
    if (cache.kind === 'gemini_oauth_stats' && Array.isArray(cache.models)) {
      values = cache.models
        .map((item) => Number(item && item.remainingPct))
        .filter((value) => Number.isFinite(value));
    } else if ((cache.kind === 'codex_oauth_status' || cache.kind === 'claude_oauth_usage') && Array.isArray(cache.entries)) {
      values = cache.entries
        .map((item) => Number(item && item.remainingPct))
        .filter((value) => Number.isFinite(value));
    } else if (cache.kind === 'agy_code_assist_quota' && Array.isArray(cache.models)) {
      values = cache.models
        .map((item) => Number(item && item.remainingPct))
        .filter((value) => Number.isFinite(value));
    }
    if (values.length === 0) return false;
    return Math.min(...values) <= 0;
  }

  return {
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    buildAgyUsagePreflight,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError,
    getLastUsageProbeState
  };
}

module.exports = {
  createUsageSnapshotService
};
