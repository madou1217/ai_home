'use strict';

const fs = require('node:fs');
const {
  applyClineCredentialToDocument,
  ensureClineAccessTokenPrefix,
  normalizeClineExpiresAtMs,
  selectClineOAuthCredential
} = require('../account/cline-credentials');
const { CLINE_DEFAULT_BASE_URL } = require('../account/provider-api-base-url');
const {
  readAccountCredentialRecord,
  writeAccountNativeAuth
} = require('./account-credential-store');
const {
  describeAccountEgressFailure,
  resolveProviderAccountEgressRequestOptions
} = require('./account-egress-request-options');
const { readResponseJson, readResponseText } = require('./response-body');

// Cline 的 access token TTL 是 1 小时（`expiresAt` 落盘为毫秒字符串，刷新接口回 ISO）。
// 留 30 分钟余量：每小时最多两次续期，且一次瞬时失败还有下一轮兜底。
const DEFAULT_CLINE_REFRESH_SKEW_MS = 30 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 20_000;
const DEFAULT_MIN_ATTEMPT_INTERVAL_MS = 30_000;
// 刷新端点相对推理 base（默认 https://api.cline.bot/api/v1）的路径。
const CLINE_REFRESH_PATH = '/auth/refresh';

function sanitizeAccessToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return '';
  if (/[\r\n\0]/.test(token)) return '';
  return token;
}

// 刷新失败时的错误摘要：只保留可判定的错误码/短文案，token 本身一律抹掉。
function redactClineSecrets(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    const normalized = String(secret || '').trim();
    if (normalized) text = text.split(normalized).join('[redacted]');
  }
  return text
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[redacted]')
    .replace(/workos:[a-z0-9._-]+/gi, '[redacted]')
    .replace(/88_[a-z0-9]+/gi, '[redacted]')
    .replace(/[\r\n\0\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeRefreshErrorResponse(rawText, secrets = []) {
  let payload = null;
  try {
    payload = JSON.parse(String(rawText || '').slice(0, 16 * 1024));
  } catch (_error) {
    payload = null;
  }
  const rawError = payload && typeof payload === 'object'
    ? (typeof payload.error === 'string'
      ? payload.error
      : String(payload.error && (payload.error.code || payload.error.message) || payload.message || ''))
    : String(rawText || '');
  const detail = redactClineSecrets(rawError, secrets).slice(0, 240);
  return detail || 'cline_refresh_endpoint_error';
}

function resolveRefreshUrl(account, options = {}) {
  const explicit = String(options.tokenUrl || '').trim();
  if (explicit) return explicit;
  const base = String(account && account.openaiBaseUrl || '').trim() || CLINE_DEFAULT_BASE_URL;
  return `${base.replace(/\/+$/, '')}${CLINE_REFRESH_PATH}`;
}

function resolveTokenExpiryMs(account) {
  const direct = Number(account && account.tokenExpiresAt);
  return Number.isFinite(direct) && direct > 0 ? direct : 0;
}

function shouldRefreshToken(account, nowMs, skewMs) {
  const expiresAt = resolveTokenExpiryMs(account);
  // 有效期未知（0）时不主动续期：没有依据就刷新会把 grant 白轮换一次。
  if (!expiresAt) return false;
  return expiresAt - nowMs <= skewMs;
}

function resolveCredentialContext(account, deps = {}) {
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const accountRef = String(account && account.accountRef || '').trim();
  if (!aiHomeDir || !accountRef) return null;
  return { fs: deps.fs || fs, aiHomeDir, accountRef };
}

function readClineNativeAuthDoc(context, account) {
  const record = readAccountCredentialRecord(context.fs, context.aiHomeDir, account.accountRef);
  if (!record || record.provider !== 'cline') return null;
  return record.nativeAuth && typeof record.nativeAuth === 'object' ? record.nativeAuth : {};
}

// 运行池对象可能是几分钟前的快照；刷新前先把内存里的凭据对回账号库（CLI 在沙箱里
// 轮换过的 grant 已经由启动/退出链路写回 DB），否则会拿已消费的 refresh token 去撞接口。
function reloadClineTokensFromAuthSnapshot(account, deps = {}) {
  const context = resolveCredentialContext(account, deps);
  if (!context) return false;
  const nativeAuth = readClineNativeAuthDoc(context, account);
  if (!nativeAuth) return false;
  const credential = selectClineOAuthCredential(nativeAuth.auth);
  if (!credential) return false;
  let changed = false;
  if (credential.accessToken && credential.accessToken !== account.accessToken) {
    account.accessToken = credential.accessToken;
    changed = true;
  }
  if (credential.refreshToken && credential.refreshToken !== account.refreshToken) {
    account.refreshToken = credential.refreshToken;
    changed = true;
  }
  if (credential.expiresAt > 0 && credential.expiresAt !== account.tokenExpiresAt) {
    account.tokenExpiresAt = credential.expiresAt;
    changed = true;
  }
  return changed;
}

// 把新凭据写回账号库：**两个槽位都写**（CLI 自己就是两槽同步的，只更新一个会让另一个
// 持有已被消费的 grant），其它 provider 的条目在入库时已经收窄掉。
function persistClineOAuthSnapshot(account, credential, nowMs, deps = {}) {
  const context = resolveCredentialContext(account, deps);
  if (!context) return { updated: false, reason: 'missing_account_ref' };
  const nativeAuth = readClineNativeAuthDoc(context, account);
  if (!nativeAuth) return { updated: false, reason: 'missing_native_auth' };
  const nextDoc = applyClineCredentialToDocument(nativeAuth.auth, credential, nowMs);
  writeAccountNativeAuth(context.fs, context.aiHomeDir, account.accountRef, {
    ...nativeAuth,
    auth: nextDoc
  });
  return { updated: true, reason: 'persisted' };
}

/**
 * Cline Pass 订阅的续期策略。
 *
 * 上游契约（2026-10-14 实测）：
 *   POST {base}/auth/refresh
 *   {"refreshToken":"<...>","grantType":"refresh_token"}
 *   → 200 {"data":{"accessToken":"<裸 JWT>","tokenType":"Bearer","expiresAt":"<ISO>",
 *          "refreshToken":"<...>","userInfo":{...}},"success":true}
 *
 * 两个必须记住的点：
 *   1. 响应体带 `{success,data}` 信封（与 chat/completions 的非流式响应同构）；
 *   2. `data.accessToken` 是**裸 JWT**，而推理出网要求 `workos:` 前缀——写回磁盘前补前缀。
 *
 * 返回形状与其它 provider 一致：{ ok, refreshed, reason, expiresAt?, persisted? }。
 */
async function refreshClineAccessToken(account, options = {}, deps = {}) {
  if (!account || typeof account !== 'object') {
    return { ok: false, refreshed: false, reason: 'invalid_account' };
  }

  const provider = String(account.provider || 'cline').trim().toLowerCase();
  if (provider !== 'cline') {
    return { ok: false, refreshed: false, reason: 'not_cline' };
  }
  if (account.apiKeyMode || String(account.authType || '').trim().toLowerCase() === 'api-key') {
    return { ok: false, refreshed: false, reason: 'not_oauth' };
  }
  if (!resolveCredentialContext(account, deps)) {
    return { ok: false, refreshed: false, reason: 'missing_account_ref' };
  }

  const originalRefreshToken = String(account.refreshToken || '').trim();
  reloadClineTokensFromAuthSnapshot(account, deps);
  const refreshToken = String(account.refreshToken || '').trim();
  if (!refreshToken) {
    return { ok: false, refreshed: false, reason: 'missing_refresh_token' };
  }

  const fetchWithTimeout = deps.fetchWithTimeout;
  if (typeof fetchWithTimeout !== 'function') {
    return { ok: false, refreshed: false, reason: 'refresh_executor_missing' };
  }

  if (account._refreshPromise) return account._refreshPromise;

  const nowMs = Number(options.nowMs) || Date.now();
  const force = options.force === true;
  const skewMs = Math.max(30_000, Number(options.skewMs) || DEFAULT_CLINE_REFRESH_SKEW_MS);
  const minAttemptIntervalMs = Math.max(1_000, Number(options.minAttemptIntervalMs) || DEFAULT_MIN_ATTEMPT_INTERVAL_MS);

  if (!force && !shouldRefreshToken(account, nowMs, skewMs)) {
    return { ok: true, refreshed: false, reason: 'not_due' };
  }

  const lastAttemptAt = Number(account._lastRefreshAttemptAt || 0);
  if (!force && Number.isFinite(lastAttemptAt) && nowMs - lastAttemptAt < minAttemptIntervalMs) {
    return { ok: true, refreshed: false, reason: 'throttled' };
  }

  const refreshUrl = resolveRefreshUrl(account, options);
  if (!refreshUrl) {
    return { ok: false, refreshed: false, reason: 'missing_token_url' };
  }

  const timeoutMs = Math.max(2_000, Number(options.timeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS);
  account._lastRefreshAttemptAt = nowMs;

  const doRefresh = async () => {
    // 与上游握手前再对一次账：别的进程（CLI 在沙箱里、或另一个 server 实例）可能刚轮换过。
    reloadClineTokensFromAuthSnapshot(account, deps);
    const currentRefreshToken = String(account.refreshToken || '').trim();
    if (!currentRefreshToken) {
      return { ok: false, refreshed: false, reason: 'missing_refresh_token' };
    }
    const rotatedElsewhere = (originalRefreshToken && currentRefreshToken !== originalRefreshToken)
      || currentRefreshToken !== refreshToken;
    if (rotatedElsewhere && !shouldRefreshToken(account, nowMs, skewMs)) {
      return {
        ok: true,
        refreshed: false,
        reason: 'already_refreshed',
        expiresAt: resolveTokenExpiryMs(account) || null
      };
    }

    const requestOptionsResult = await resolveProviderAccountEgressRequestOptions({
      account,
      provider: 'cline',
      options,
      deps
    });
    if (!requestOptionsResult?.ok || !requestOptionsResult.options) {
      return {
        ok: false,
        refreshed: false,
        ...describeAccountEgressFailure(requestOptionsResult)
      };
    }
    const requestOptions = requestOptionsResult.options;

    const response = await fetchWithTimeout(refreshUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-encoding': 'identity'
      },
      body: JSON.stringify({ refreshToken: currentRefreshToken, grantType: 'refresh_token' })
    }, timeoutMs, {
      proxyUrl: requestOptions.proxyUrl,
      noProxy: requestOptions.noProxy
    });

    if (!response.ok) {
      const rawText = await readResponseText(response).catch(() => '');
      const detail = summarizeRefreshErrorResponse(rawText, [currentRefreshToken, account.accessToken]);
      const result = {
        ok: false,
        refreshed: false,
        reason: `refresh_http_${response.status}`,
        status: response.status,
        detail
      };
      // 400/401 且文案指向 grant 失效 → 交给守护进程判 auth_invalid（需要重新登录）。
      if ((response.status === 400 || response.status === 401)
        && /invalid|expired|revoked|unauthoriz|re-?authenticate/i.test(detail)) {
        result.oauthError = 'invalid_refresh_token';
      }
      return result;
    }

    const payload = await readResponseJson(response).catch(() => null);
    if (!payload || typeof payload !== 'object') {
      return { ok: false, refreshed: false, reason: 'invalid_refresh_payload' };
    }
    // 刷新接口与 chat/completions 一样带 {success, data} 信封。
    const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : payload;

    const nextAccessToken = ensureClineAccessTokenPrefix(
      sanitizeAccessToken(data.accessToken || data.access_token)
    );
    if (!nextAccessToken) {
      return { ok: false, refreshed: false, reason: 'missing_access_token' };
    }
    const nextRefreshToken = sanitizeAccessToken(data.refreshToken || data.refresh_token) || currentRefreshToken;
    const expiresAt = normalizeClineExpiresAtMs(data.expiresAt || data.expires_at);

    account.accessToken = nextAccessToken;
    if (nextRefreshToken) account.refreshToken = nextRefreshToken;
    if (expiresAt > 0) account.tokenExpiresAt = expiresAt;

    const persisted = persistClineOAuthSnapshot(account, {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.tokenExpiresAt
    }, nowMs, deps);

    if (persisted.updated
      && deps.accountArtifactHooks
      && typeof deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
      deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated({
        provider: 'cline',
        accountRef: account.accountRef,
        artifactPath: '.cline/data/settings/providers.json',
        source: 'token_refresh',
        reason: 'cline_oauth_token_refreshed'
      });
    }

    return {
      ok: true,
      refreshed: true,
      reason: 'refreshed',
      expiresAt: Number(account.tokenExpiresAt) || null,
      persisted
    };
  };

  const refreshTask = (async () => {
    try {
      return await doRefresh();
    } catch (error) {
      return {
        ok: false,
        refreshed: false,
        reason: 'refresh_exception',
        detail: redactClineSecrets(
          String((error && error.message) || error || ''),
          [refreshToken, account.accessToken]
        ).slice(0, 320)
      };
    } finally {
      account._refreshPromise = null;
    }
  })();

  account._refreshPromise = refreshTask;
  return refreshTask;
}

module.exports = {
  refreshClineAccessToken,
  DEFAULT_CLINE_REFRESH_SKEW_MS,
  CLINE_REFRESH_PATH,
  __private: {
    sanitizeAccessToken,
    redactClineSecrets,
    summarizeRefreshErrorResponse,
    resolveRefreshUrl,
    resolveTokenExpiryMs,
    shouldRefreshToken,
    resolveCredentialContext,
    reloadClineTokensFromAuthSnapshot,
    persistClineOAuthSnapshot
  }
};

