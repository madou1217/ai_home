'use strict';

// kimi (kimi-code) OAuth access_token 刷新。
// kimi access_token 有效期只有 15 分钟（expires_in=900），必须按 refresh_token 续期，
// 否则所有依赖 access_token 的链路（运行池加载、配额探测）会在登录一刻钟后集体失效。
// 端点与 kimi-code CLI 保持一致（@moonshot-ai/kimi-code dist/main.mjs refreshAccessToken）：
//   POST {oauthHost}/api/oauth/token  form: client_id + grant_type=refresh_token + refresh_token
// 凭证落在 native_auth_json 的 $.credentials（access_token/refresh_token/expires_at 秒级 epoch）。

const fs = require('node:fs');
const crypto = require('node:crypto');
const nodePath = require('node:path');
const {
  compareAndSwapAccountNativeAuth,
  readAccountCredentialRecord
} = require('./account-credential-store');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { createKimiHostCredentialReconciler } = require('../account/kimi-host-credentials');
const {
  KIMI_OAUTH_CLIENT_ID,
  KIMI_OAUTH_HOST,
  readKimiOAuthCredentials,
  readKimiRefreshToken,
  readKimiTokenExpiry,
  resolveKimiOAuthDeviceId
} = require('../account/kimi-auth');
const {
  decodeJwtPayloadUnsafe,
  parseJwtExpiryMs
} = require('../account/codex-auth-metadata');
const {
  buildKimiRequestHeaders,
  deriveKimiDeviceId
} = require('./kimi-request-headers');
const {
  describeAccountEgressFailure,
  resolveProviderAccountEgressRequestOptions
} = require('./account-egress-request-options');

const DEFAULT_KIMI_OAUTH_HOST = KIMI_OAUTH_HOST;
const KIMI_CODE_OAUTH_CLIENT_ID = KIMI_OAUTH_CLIENT_ID;
const DEFAULT_REFRESH_SKEW_MS = 2 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_ATTEMPT_INTERVAL_MS = 30_000;
const refreshStateByAccountKey = new Map();

function redactKnownOauthSecrets(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    const normalized = String(secret || '').trim();
    if (normalized) text = text.split(normalized).join('[redacted]');
  }
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[redacted]')
    .replace(/(["']?(?:access|refresh)[_-]?token["']?\s*[:=]\s*)[^\s,;}]+/gi, '$1[redacted]')
    .replace(/[\r\n\0\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeKimiOauthFailure(payload, secrets = []) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const nestedError = data.error && typeof data.error === 'object' ? data.error : {};
  const rawCode = typeof data.error === 'string'
    ? data.error
    : data.code || nestedError.code || nestedError.type || '';
  const safeCode = redactKnownOauthSecrets(rawCode, secrets);
  const oauthError = !safeCode.includes('[redacted]') && /^[a-z0-9_.:-]{1,80}$/i.test(safeCode)
    ? safeCode
    : 'invalid_refresh_payload';
  const detail = redactKnownOauthSecrets(
    data.error_description
      || data.errorDescription
      || data.message
      || nestedError.message
      || 'OAuth token response did not include access_token',
    secrets
  ).slice(0, 240);
  return { oauthError, detail };
}

// kimi 每次刷新都会轮换 refresh_token（实测确认），而 kimi-code CLI 的
// OAuthManager.ensureFresh 每次都从凭证文件重读最新 grant。因此 server 侧刷新
// 成功后必须把新凭证写回该账号的 projection（以及 host ~/.kimi-code），否则
// 长驻 CLI 会话会拿着已被轮换掉的 refresh_token 刷新失败并写下 revoked tombstone。
// 写回遵循 CAS 语义：仅当文件里的 refresh_token 仍是本次被消费的那一个才覆盖；
// 若 CLI 已抢先轮换（文件 token 与两者都不同），丢弃本次结果，下次刷新自然跟上。
function writeKimiCredentialsFileAtomic(fsImpl, credentialsPath, credentials) {
  const dir = nodePath.dirname(credentialsPath);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${credentialsPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  fsImpl.renameSync(tmpPath, credentialsPath);
}

function writeBackKimiOAuthCredentials(fsImpl, options) {
  const {
    aiHomeDir,
    hostHomeDir,
    accountRef,
    consumedRefreshToken,
    credentials,
    deviceId
  } = options || {};
  const nextRefreshToken = String(credentials && credentials.refresh_token || '').trim();
  if (!fsImpl || !accountRef || !nextRefreshToken) return [];
  const roots = [];
  const projectionRoot = resolveAccountRuntimeDir(aiHomeDir, 'kimi', accountRef);
  if (projectionRoot) roots.push({ root: projectionRoot, createIfMissing: true });
  const hostRoot = String(hostHomeDir || '').trim();
  if (hostRoot) roots.push({ root: hostRoot, createIfMissing: false });
  const written = [];
  for (const { root, createIfMissing } of roots) {
    const kimiHome = nodePath.join(root, '.kimi-code');
    const credentialsPath = nodePath.join(kimiHome, 'credentials', 'kimi-code.json');
    try {
      let current = null;
      try {
        current = JSON.parse(fsImpl.readFileSync(credentialsPath, 'utf8'));
      } catch (_error) {}
      if (current && typeof current === 'object') {
        const currentRefreshToken = String(current.refresh_token || '').trim();
        if (currentRefreshToken && currentRefreshToken === nextRefreshToken) continue;
        if (currentRefreshToken && currentRefreshToken !== consumedRefreshToken) continue;
      } else if (!createIfMissing) {
        // host ~/.kimi-code 缺失说明用户从未原生跑过 CLI；刷新路径不替它建目录。
        continue;
      }
      writeKimiCredentialsFileAtomic(fsImpl, credentialsPath, credentials);
      const nextDeviceId = String(deviceId || '').trim();
      if (nextDeviceId) {
        const deviceIdPath = nodePath.join(kimiHome, 'device_id');
        let existingDeviceId = '';
        try {
          existingDeviceId = String(fsImpl.readFileSync(deviceIdPath, 'utf8')).trim();
        } catch (_error) {}
        if (!existingDeviceId) {
          fsImpl.writeFileSync(deviceIdPath, `${nextDeviceId}\n`, { mode: 0o600 });
        }
      }
      written.push(credentialsPath);
    } catch (_error) {}
  }
  return written;
}

// $.credentials.expires_at 是秒级 epoch（kimi-code 落盘格式）；缺失时回退 JWT exp。
function resolveKimiTokenExpiryMs(credentials) {
  const expiresAtMs = readKimiTokenExpiry(credentials);
  return expiresAtMs > 0 ? expiresAtMs : null;
}

function buildRefreshStateKey(aiHomeDir, accountRef) {
  return `${aiHomeDir}\u0000${accountRef}`;
}

function applyRefreshResultToRuntimeAccount(account, result) {
  if (!result || !result.ok) return;
  if (result.accessToken) account.accessToken = result.accessToken;
  if (result.refreshToken) account.refreshToken = result.refreshToken;
  if (result.deviceId) account.deviceId = result.deviceId;
  if (Number.isFinite(result.expiresAtMs) && result.expiresAtMs > 0) {
    account.tokenExpiresAt = result.expiresAtMs;
  }
  account.tokenType = String(result.tokenType || account.tokenType || 'Bearer');
}

function buildRefreshedNativeAuth(nativeAuth, tokens, nowMs) {
  const current = readKimiOAuthCredentials(nativeAuth);
  if (!current || typeof current !== 'object') return false;
  const expiresAtSeconds = Number.isFinite(tokens.expiresAtMs) && tokens.expiresAtMs > 0
    ? Math.floor(tokens.expiresAtMs / 1000)
    : Math.floor(nowMs / 1000) + Number(tokens.expiresIn || 900);
  const credentials = {
    ...current,
    access_token: String(tokens.accessToken || ''),
    refresh_token: String(tokens.refreshToken || current.refresh_token || ''),
    expires_at: expiresAtSeconds,
    expires_in: Number(tokens.expiresIn) || 900,
    token_type: String(tokens.tokenType || current.token_type || 'Bearer'),
    scope: String(tokens.scope || current.scope || '')
  };
  const deviceId = resolveKimiOAuthDeviceId(
    { credentials },
    tokens.deviceId,
    nativeAuth && nativeAuth.deviceId
  );
  const nextNativeAuth = {
    ...nativeAuth,
    credentials,
    ...(deviceId ? { deviceId } : {})
  };
  delete nextNativeAuth.auth;
  return nextNativeAuth;
}

function persistKimiOAuthTokens(fsImpl, aiHomeDir, accountRef, snapshot, tokens, nowMs) {
  const originalRefreshToken = readKimiRefreshToken(snapshot && snapshot.nativeAuth);
  const firstNextNativeAuth = buildRefreshedNativeAuth(snapshot && snapshot.nativeAuth, tokens, nowMs);
  if (!firstNextNativeAuth) return false;
  if (compareAndSwapAccountNativeAuth(
    fsImpl,
    aiHomeDir,
    accountRef,
    snapshot,
    firstNextNativeAuth
  )) return true;

  // 无关 nativeAuth 字段可能与 refresh 并发更新。最多重读并重试一次；
  // refresh token 一旦变化就代表新的凭据 generation 已胜出，旧响应必须丢弃。
  const currentRecord = readAccountCredentialRecord(fsImpl, aiHomeDir, accountRef);
  if (!currentRecord || currentRecord.provider !== 'kimi') return false;
  const currentRefreshToken = readKimiRefreshToken(currentRecord.nativeAuth);
  if (!originalRefreshToken || currentRefreshToken !== originalRefreshToken) return false;
  const secondNextNativeAuth = buildRefreshedNativeAuth(currentRecord.nativeAuth, tokens, nowMs);
  if (!secondNextNativeAuth) return false;
  return compareAndSwapAccountNativeAuth(
    fsImpl,
    aiHomeDir,
    accountRef,
    currentRecord,
    secondNextNativeAuth
  );
}

async function refreshKimiAccessToken(account, options = {}, deps = {}) {
  if (!account || typeof account !== 'object') {
    return { ok: false, refreshed: false, reason: 'invalid_account' };
  }
  const provider = String(account.provider || '').trim().toLowerCase();
  if (provider !== 'kimi') {
    return { ok: false, refreshed: false, reason: 'not_kimi' };
  }
  const fsImpl = deps.fs || fs;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const accountRef = String(account.accountRef || '').trim();
  if (!aiHomeDir || !accountRef) {
    return { ok: false, refreshed: false, reason: 'missing_account_ref' };
  }

  let credentialRecord = readAccountCredentialRecord(fsImpl, aiHomeDir, accountRef);
  if (credentialRecord && credentialRecord.provider !== 'kimi') {
    return { ok: false, refreshed: false, reason: 'not_kimi' };
  }
  // 刷新前先吸收其它 writer 可能更新的 grant：kimi 每次刷新都轮换 refresh_token，
  // 若 CLI 刚轮换过而 DB 还是旧快照，直接拿旧 refresh_token 撞 OAuth 端点只会
  // 吃到 invalid_grant 并被 24h 抑制。需要吸收两处：host ~/.kimi-code（用户原生
  // CLI）由调用方注入 reconcileHostCredentials；账号 projection（aih 沙箱内的
  // CLI，KIMI_CODE_HOME=<projection>/.kimi-code）在这里内置 reconcile。
  const reconcilers = [];
  if (typeof deps.reconcileHostCredentials === 'function') {
    reconcilers.push(deps.reconcileHostCredentials);
  }
  const reconcileProjectionRoot = resolveAccountRuntimeDir(aiHomeDir, 'kimi', accountRef);
  if (reconcileProjectionRoot) {
    reconcilers.push(createKimiHostCredentialReconciler({
      fs: fsImpl,
      path: nodePath,
      aiHomeDir,
      hostHomeDir: reconcileProjectionRoot
    }));
  }
  for (const reconcile of reconcilers) {
    try {
      const reconciliation = reconcile(accountRef);
      if (reconciliation && reconciliation.ok === true && reconciliation.adopted === true) {
        const adoptedRecord = readAccountCredentialRecord(fsImpl, aiHomeDir, accountRef);
        if (adoptedRecord && adoptedRecord.provider === 'kimi') {
          credentialRecord = adoptedRecord;
        }
      }
    } catch (_error) {}
  }
  const nativeAuth = credentialRecord && credentialRecord.nativeAuth;
  const credentials = readKimiOAuthCredentials(nativeAuth);
  if (!credentials || Object.keys(credentials).length === 0) {
    return { ok: false, refreshed: false, reason: 'missing_credentials' };
  }
  const refreshToken = readKimiRefreshToken(nativeAuth);
  if (!refreshToken) {
    return { ok: false, refreshed: false, reason: 'missing_refresh_token' };
  }

  const fetchWithTimeout = deps.fetchWithTimeout;
  if (typeof fetchWithTimeout !== 'function') {
    return { ok: false, refreshed: false, reason: 'refresh_executor_missing' };
  }

  const nowMs = Number(options.nowMs) || Date.now();
  const force = !!options.force;
  const skewMs = Math.max(10_000, Number(options.skewMs) || DEFAULT_REFRESH_SKEW_MS);
  const expiresAtMs = resolveKimiTokenExpiryMs(credentials);
  const deviceId = resolveKimiOAuthDeviceId(nativeAuth, account.deviceId)
    || deriveKimiDeviceId(credentials);
  applyRefreshResultToRuntimeAccount(account, {
    ok: true,
    accessToken: String(credentials.access_token || credentials.accessToken || '').trim(),
    refreshToken,
    expiresAtMs,
    tokenType: credentials.token_type || credentials.tokenType,
    deviceId
  });
  if (!force && Number.isFinite(expiresAtMs) && expiresAtMs - nowMs > skewMs) {
    return { ok: true, refreshed: false, reason: 'not_due' };
  }

  // 同一凭证库中按 accountRef 协调，而不是把状态挂在某一个临时 account 对象上。
  // 配额探测与网关会构造不同对象，但必须共享同一个 in-flight refresh。
  const refreshStateKey = buildRefreshStateKey(aiHomeDir, accountRef);
  let refreshState = refreshStateByAccountKey.get(refreshStateKey);
  if (!refreshState) {
    refreshState = { promise: null, lastAttemptAt: 0, lastAttemptRefreshToken: '' };
    refreshStateByAccountKey.set(refreshStateKey, refreshState);
  }
  if (refreshState.promise) {
    const sharedResult = await refreshState.promise;
    applyRefreshResultToRuntimeAccount(account, sharedResult);
    return sharedResult;
  }
  const minAttemptIntervalMs = Math.max(1_000, Number(options.minAttemptIntervalMs) || DEFAULT_MIN_ATTEMPT_INTERVAL_MS);
  if (!force && Number.isFinite(refreshState.lastAttemptAt)
    && refreshState.lastAttemptRefreshToken === refreshToken
    && nowMs - refreshState.lastAttemptAt < minAttemptIntervalMs) {
    return { ok: false, refreshed: false, reason: 'throttled' };
  }
  refreshState.lastAttemptAt = nowMs;
  refreshState.lastAttemptRefreshToken = refreshToken;

  const oauthHost = String(deps.oauthHost || process.env.KIMI_CODE_OAUTH_HOST || DEFAULT_KIMI_OAUTH_HOST)
    .trim().replace(/\/+$/, '');
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS);
  const credentialSnapshot = {
    nativeAuth,
    nativeAuthUpdatedAt: Number(credentialRecord.nativeAuthUpdatedAt) || 0
  };
  const deviceHeaders = buildKimiRequestHeaders({
    credentials,
    deviceId
  });

  refreshState.promise = (async () => {
    try {
      const requestOptionsResult = await resolveProviderAccountEgressRequestOptions({
        account,
        provider: 'kimi',
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
      const res = await fetchWithTimeout(`${oauthHost}/api/oauth/token`, {
        method: 'POST',
        headers: {
          ...deviceHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: new URLSearchParams({
          client_id: KIMI_CODE_OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        }).toString()
      }, timeoutMs, {
        proxyUrl: requestOptions.proxyUrl,
        noProxy: requestOptions.noProxy
      });
      const status = res && res.status;
      const data = await res.json().catch(() => null);
      if (status !== 200 || !data || typeof data.access_token !== 'string' || !data.access_token) {
        const errorCode = data && typeof data.error === 'string' ? data.error : '';
        const reason = status === 401 || status === 403 || errorCode === 'invalid_grant'
          ? 'refresh_unauthorized'
          : `refresh_http_${status || 'unknown'}`;
        return {
          ok: false,
          refreshed: false,
          reason,
          ...summarizeKimiOauthFailure(data, [
            refreshToken,
            credentials.access_token,
            credentials.accessToken,
            data && data.refresh_token,
            data && data.access_token
          ])
        };
      }
      const expiresIn = Number(data.expires_in);
      const nextRefreshToken = typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : refreshToken;
      const refreshedDeviceId = resolveKimiOAuthDeviceId({
        credentials: {
          ...credentials,
          access_token: data.access_token,
          refresh_token: nextRefreshToken
        }
      }, deviceId);
      const tokens = {
        accessToken: data.access_token,
        refreshToken: nextRefreshToken,
        expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900,
        expiresAtMs: Number.isFinite(expiresIn) && expiresIn > 0
          ? Date.now() + expiresIn * 1000
          : (parseJwtExpiryMs(data.access_token) || Date.now() + 900 * 1000),
        tokenType: data.token_type,
        scope: data.scope,
        deviceId: refreshedDeviceId
      };
      const persisted = persistKimiOAuthTokens(
        fsImpl,
        aiHomeDir,
        accountRef,
        credentialSnapshot,
        tokens,
        Date.now()
      );
      if (!persisted) {
        return { ok: false, refreshed: false, reason: 'stale_credentials' };
      }
      const persistedAuth = buildRefreshedNativeAuth(nativeAuth, tokens, Date.now());
      if (persistedAuth && persistedAuth.credentials) {
        writeBackKimiOAuthCredentials(fsImpl, {
          aiHomeDir,
          hostHomeDir: deps.hostHomeDir,
          accountRef,
          consumedRefreshToken: refreshToken,
          credentials: persistedAuth.credentials,
          deviceId: tokens.deviceId
        });
      }
      if (deps.accountArtifactHooks
        && typeof deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
        deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated({
          provider: 'kimi',
          accountRef,
          artifactPath: 'app-state.db',
          source: 'token_refresh',
          reason: 'kimi_oauth_token_refreshed'
        });
      }
      return {
        ok: true,
        refreshed: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAtMs: tokens.expiresAtMs,
        tokenType: tokens.tokenType,
        deviceId: tokens.deviceId
      };
    } catch (error) {
      return { ok: false, refreshed: false, reason: `refresh_exception: ${String(error && error.message || error).slice(0, 120)}` };
    } finally {
      refreshState.promise = null;
    }
  })();
  const result = await refreshState.promise;
  applyRefreshResultToRuntimeAccount(account, result);
  return result;
}

module.exports = {
  refreshKimiAccessToken,
  DEFAULT_KIMI_OAUTH_HOST,
  KIMI_CODE_OAUTH_CLIENT_ID,
  __private: {
    decodeJwtPayloadUnsafe,
    parseJwtExpiryMs,
    resolveKimiTokenExpiryMs,
    buildRefreshStateKey,
    applyRefreshResultToRuntimeAccount,
    buildRefreshedNativeAuth,
    persistKimiOAuthTokens,
    writeBackKimiOAuthCredentials,
    redactKnownOauthSecrets,
    summarizeKimiOauthFailure
  }
};
