'use strict';

// kimi 配额探测：Remaining 抽象（lib/account/usage-remaining.js）的 kimi 实现。
// 端点与 kimi-code CLI 一致（@moonshot-ai/kimi-code dist/main.mjs managed-usage）：
//   GET {KIMI_CODE_BASE_URL|https://api.kimi.com/coding/v1}/usages  Authorization: Bearer <access_token>
// 响应 { usage, limits:[{detail,window,name}], boosterWallet }，窗口为 {duration, timeUnit}。
// 产出的快照复用时间窗型 entries[] 形状（同 codex/claude），展示层无需为 kimi 单开分支。

const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_KIMI } = require('../../../account/usage-remaining');
const {
  hasUsableKimiOAuth,
  readKimiOAuthCredentials,
  readKimiTokenExpiry,
  resolveKimiOAuthDeviceId
} = require('../../../account/kimi-auth');
const { KIMI_CODE_BASE_URL } = require('../../../account/kimi-endpoints');
const { hasKimiApiKey } = require('../../../profile/credential-config');
const { refreshKimiAccessToken } = require('../../../server/kimi-token-refresh');
const { buildKimiRequestHeaders } = require('../../../server/kimi-request-headers');
const {
  resolveAccountEgressRequestOptions: resolveAccountEgressRequestOptionsDefault
} = require('../../../server/account-egress-request-options');

const DEFAULT_KIMI_CODE_BASE_URL = KIMI_CODE_BASE_URL;
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

function windowMinutesFrom(raw) {
  if (!raw || typeof raw !== 'object') return 0;
  const duration = Number(raw.duration);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  switch (String(raw.timeUnit || raw.time_unit || '')) {
    case 'TIME_UNIT_MINUTE': return duration;
    case 'TIME_UNIT_HOUR': return duration * 60;
    case 'TIME_UNIT_DAY': return duration * 1440;
    case 'TIME_UNIT_WEEK': return duration * 10080;
    default: return 0;
  }
}

// 与 codex/claude 展示约定对齐：5h / 7days 风格，短窗在前由调用方排序。
function formatWindowLabel(windowMinutes) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes % 10080 === 0) return `${minutes / 10080 * 7}days`;
  if (minutes % 1440 === 0) return `${minutes / 1440}days`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatResetInFromIso(resetTime, nowMs) {
  const resetAtMs = Date.parse(String(resetTime || ''));
  if (!Number.isFinite(resetAtMs)) return '';
  const diffSec = Math.max(0, Math.floor((resetAtMs - (nowMs || Date.now())) / 1000));
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function toUsageEntry(raw, fallbackName, windowMinutes, capturedAt) {
  if (!raw || typeof raw !== 'object') return null;
  const used = Number(raw.used);
  const remaining = Number(raw.remaining);
  const limit = Number(raw.limit);
  if (!Number.isFinite(used) && !Number.isFinite(remaining) && !Number.isFinite(limit)) return null;
  // /usages 同时给 used 和 remaining；remaining 是上游权威值，优先采用，
  // 缺失时才按 used/limit 推算，避免 summary 只带 remaining 时被误算成 100%。
  const remainingPct = Number.isFinite(limit) && limit > 0
    ? Math.max(0, Math.min(100, ((Number.isFinite(remaining) ? remaining : limit - (Number.isFinite(used) ? used : 0)) * 100) / limit))
    : null;
  const resetTime = typeof raw.resetTime === 'string' && raw.resetTime ? raw.resetTime : '';
  const resetAtMs = resetTime ? Date.parse(resetTime) : 0;
  const window = formatWindowLabel(windowMinutes);
  return {
    bucket: String(fallbackName || raw.name || '') || (windowMinutes > 0 ? `rolling_${windowMinutes}m` : window),
    windowMinutes,
    window,
    remainingPct,
    resetIn: resetTime ? formatResetInFromIso(resetTime, capturedAt) : '',
    resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : 0
  };
}

function parseKimiUsagePayload(payload, capturedAt, account) {
  if (!payload || typeof payload !== 'object') return null;
  const entries = [];
  // summary（payload.usage）是主周配额；kimi-code 在其缺窗口时按 1 周处理。
  const summary = toUsageEntry(payload.usage, 'weekly', 10080, capturedAt);
  if (summary) entries.push(summary);
  if (Array.isArray(payload.limits)) {
    for (const item of payload.limits) {
      if (!item || typeof item !== 'object') continue;
      const entry = toUsageEntry(
        item.detail,
        item.name,
        windowMinutesFrom(item.window),
        capturedAt
      );
      if (entry) entries.push(entry);
    }
  }
  if (entries.length === 0) return null;
  const snapshot = {
    kind: USAGE_SNAPSHOT_KINDS.kimi,
    capturedAt: capturedAt || Date.now(),
    source: USAGE_SOURCE_KIMI,
    entries
  };
  const base = account && typeof account === 'object' ? { ...account } : {};
  // /usages 响应的 user.membership.level 是套餐等级（LEVEL_INTERMEDIATE -> intermediate），
  // WebUI/CLI 的 plan badge 直接消费 account.planType。
  const level = String(
    payload.user && payload.user.membership && payload.user.membership.level || ''
  ).trim();
  if (level) base.planType = level.replace(/^LEVEL_/i, '').toLowerCase();
  if (Object.keys(base).length > 0) snapshot.account = base;
  return snapshot;
}

function createKimiQuotaProbe(options = {}) {
  const {
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    accountArtifactHooks,
    fetchWithTimeout,
    proxyUrl,
    noProxy,
    processObj,
    accountEgressDeps,
    resolveAccountEgressRequestOptions,
    usageSnapshotSchemaVersion,
    now = () => Date.now()
  } = options;
  const proxyOptions = {
    proxyUrl: String(proxyUrl || '').trim(),
    noProxy: String(noProxy || '').trim()
  };

  async function resolveAccessToken(accountRef, credentials, probeTimeoutMs, requestOptions) {
    const accessToken = String(credentials.access_token || credentials.accessToken || '').trim();
    const resolvedExpiry = readKimiTokenExpiry(credentials);
    const expiresAtMs = resolvedExpiry > 0 ? resolvedExpiry : null;
    const stillValid = accessToken
      && (!Number.isFinite(expiresAtMs) || expiresAtMs - now() > 30_000);
    if (stillValid) return { accessToken };
    // access_token 15 分钟过期是常态：缺/过期时先用 refresh_token 续期再探测，
    // 刷新成功会回写 native_auth_json，网关侧下次加载同时受益。
    const refreshAccount = { accountRef, provider: 'kimi' };
    const refreshed = await refreshKimiAccessToken(refreshAccount, {
      force: !accessToken,
      timeoutMs: probeTimeoutMs,
      ...requestOptions
    }, {
      fs,
      aiHomeDir,
      accountArtifactHooks,
      fetchWithTimeout
    });
    if (!refreshed || !refreshed.ok || !refreshed.accessToken) {
      return { error: `token_refresh_failed:${refreshed && refreshed.reason || 'unknown'}` };
    }
    return { accessToken: refreshed.accessToken };
  }

  // /me 是 best-effort 身份探测（nickname + 脱敏手机号）：失败不影响配额快照。
  async function probeKimiUserInfo(baseUrl, accessToken, timeoutMs, deviceHeaders, requestOptions) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/me`, {
        method: 'GET',
        headers: {
          ...deviceHeaders,
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json'
        }
      }, timeoutMs, requestOptions);
      if (!res || !res.ok) return null;
      const payload = await res.json().catch(() => null);
      if (!payload || typeof payload !== 'object') return null;
      const displayName = String(payload.nickname || '').trim();
      const phoneRecord = payload.phone && typeof payload.phone === 'object' ? payload.phone : null;
      const phone = phoneRecord
        ? `+${String(phoneRecord.country_code || '').trim()} ${String(phoneRecord.number || '').trim()}`.trim()
        : '';
      // 订阅页品牌档（Andante/Moderato/Allegretto/Allegro）在 /me 的
      // user_level_name；/usages 的 membership.level 只是 LEVEL_* 内部枚举，
      // 单独看会误读（LEVEL_INTERMEDIATE 实际是 Allegretto 档）。
      const planName = String(payload.user_level_name || '').trim();
      const planLevel = Number(payload.user_level);
      if (!displayName && !phone && !planName) return null;
      return {
        displayName,
        phone,
        planName,
        planLevel: Number.isFinite(planLevel) && planLevel > 0 ? planLevel : null
      };
    } catch (_error) {
      return null;
    }
  }

  // 返回 { snapshot } 或 { error, auth }；不抛异常，由调用方决定缓存回退策略。
  async function probe(accountRef, probeTimeoutMs) {
    const timeoutMs = Math.max(1_000, Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
    const record = typeof readAccountCredentialRecord === 'function'
      ? readAccountCredentialRecord(fs, aiHomeDir, accountRef)
      : null;
    if (!record || record.provider !== 'kimi') return { error: 'credential_record_missing' };
    const env = record.env || {};
    if (hasKimiApiKey(env)) {
      // API Key 模式没有托管配额端点，Remaining 对这类账号不适用。
      return { error: 'api_key_mode_not_applicable' };
    }
    const nativeAuth = record.nativeAuth || {};
    if (!hasUsableKimiOAuth(nativeAuth)) {
      return { error: 'missing_oauth_credentials' };
    }
    const credentials = readKimiOAuthCredentials(nativeAuth);
    if (!credentials || typeof credentials !== 'object' || Object.keys(credentials).length === 0) {
      return { error: 'missing_oauth_credentials' };
    }
    const deviceHeaders = buildKimiRequestHeaders({
      credentials,
      deviceId: resolveKimiOAuthDeviceId(nativeAuth)
    });

    const resolveRequestOptions = typeof resolveAccountEgressRequestOptions === 'function'
      ? resolveAccountEgressRequestOptions
      : resolveAccountEgressRequestOptionsDefault;
    let accountRequestOptions;
    try {
      accountRequestOptions = await resolveRequestOptions({
        fs,
        aiHomeDir,
        processObj,
        provider: 'kimi',
        accountRef,
        options: proxyOptions,
        deps: accountEgressDeps || {}
      });
    } catch (error) {
      return { error: `account_egress_unavailable:${String(error?.message || error || 'unknown')}` };
    }
    if (!accountRequestOptions?.ok || !accountRequestOptions.options) {
      return {
        error: [
          String(accountRequestOptions?.error || 'account_egress_unavailable'),
          String(accountRequestOptions?.egressError || '')
        ].filter(Boolean).join(':')
      };
    }
    const requestOptions = accountRequestOptions.options;

    const baseUrl = String(env.KIMI_CODE_BASE_URL || '').trim().replace(/\/+$/, '')
      || DEFAULT_KIMI_CODE_BASE_URL;
    const tokenResult = await resolveAccessToken(accountRef, credentials, timeoutMs, requestOptions);
    if (!tokenResult.accessToken) return { error: tokenResult.error || 'token_unavailable', auth: true };

    const fetchUsages = (accessToken) => fetchWithTimeout(`${baseUrl}/usages`, {
      method: 'GET',
      headers: {
        ...deviceHeaders,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    }, timeoutMs, requestOptions);

    try {
      let accessToken = tokenResult.accessToken;
      let res = await fetchUsages(accessToken);
      // access_token 可能在凭证落盘后刚过期：401 时强制刷新一次并重试，
      // 避免探测把「令牌过期」误报成配额不可用。
      if (res.status === 401) {
        const refreshed = await refreshKimiAccessToken({ accountRef, provider: 'kimi' }, {
          force: true,
          timeoutMs,
          ...requestOptions
        }, {
          fs,
          aiHomeDir,
          accountArtifactHooks,
          fetchWithTimeout
        });
        if (refreshed && refreshed.ok && refreshed.accessToken) {
          accessToken = refreshed.accessToken;
          res = await fetchUsages(accessToken);
        }
      }
      if (!res.ok) {
        return { error: `kimi_usage_http_${res.status}`, auth: res.status === 401 || res.status === 403 };
      }
      const payload = await res.json().catch(() => null);
      const identity = await probeKimiUserInfo(baseUrl, accessToken, timeoutMs, deviceHeaders, requestOptions);
      const snapshot = parseKimiUsagePayload(payload, now(), identity);
      if (!snapshot) return { error: 'empty_parsed_snapshot' };
      if (usageSnapshotSchemaVersion != null) snapshot.schemaVersion = usageSnapshotSchemaVersion;
      return { snapshot };
    } catch (error) {
      return { error: `probe_exception:${String(error && error.message || error).slice(0, 120)}` };
    }
  }

  return { probe };
}

module.exports = {
  createKimiQuotaProbe,
  DEFAULT_KIMI_CODE_BASE_URL,
  __private: {
    windowMinutesFrom,
    formatWindowLabel,
    formatResetInFromIso,
    parseKimiUsagePayload
  }
};
