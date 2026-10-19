'use strict';

// Qoder / Qoder CN 额度探针（HTTP，**不依赖本机客户端**）。
//
// 上游实测（2026-10-16，真实账号，`Authorization: Bearer <security_oauth_token>`）：
//   GET <base>/api/v2/quota/usage
//     → { usageType:'credits', totalUsagePercentage, isQuotaExceeded, expiresAt, upgradeUrl,
//         userQuota:{ total, used, remaining, percentage, unit:'credits' }, isPlanQuotaProrated }
//   GET <base>/api/v2/user/plan
//     → { plan_tier_name:'Free', is_paid_plan, is_personal_version, start_date, end_date,
//         feature_allowed:{...} }
//   GET <base>/api/v3/user/status
//     → { id, name, email, userType, quota, isQuotaExceeded, plan:'PLAN_TIER_FREE',
//         userTag, nextResetAt, whitelistStatus }
// base：全球站 https://openapi.qoder.sh，国内站 https://openapi.qoder.com.cn
// （取自 CLI 内嵌主机表；`api.qoder.com` 只认 apikey、`qoder.com` 未认证，都不是这条面）。
//
// token 来源按可用性顺序：
//   1) env.QODER_PERSONAL_ACCESS_TOKEN（PAT 账号）；
//   2) native_auth 里的可读载荷（resolveQoderNativeAuthPayload，例如 sub2api 导入的账号）；
//   3) CLI 的 opaque blob（复用 CLI 自带 WASM 解密，见 lib/account/qoder-credential-decrypt）。
//
// 这条通道推翻了「Qoder 客户端侧没有可复用的额度查询面」的旧结论——旧结论只看了推理面与
// 本地 CLI，没有发现账号面的 `/api/v2/quota/usage`。额度模型 = 一个 credits 池 + 到期时间。

const {
  USAGE_SNAPSHOT_KINDS,
  USAGE_SOURCE_QODER
} = require('../../../account/usage-remaining');
const { resolveQoderNativeAuthPayload, isQoderProvider } = require('../../../account/qoder-auth-metadata');
const { decryptQoderCredential } = require('../../../account/qoder-credential-decrypt');
const { readAccountCredentialRecord } = require('../../../server/account-credential-store');
const {
  resolveAccountEgressRequestOptions: resolveAccountEgressRequestOptionsDefault
} = require('../../../server/account-egress-request-options');
const {
  QODER_ACCOUNT_BASES,
  QODER_ACCOUNT_ROUTES
} = require('../../../runtime/qoder-client-layouts');

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
// 全球站 / 国内站账号面主机（同一条 API 形状，只是区域不同）。主机与路径的
// 版本化事实源在 lib/runtime/qoder-client-layouts.js；这里只做消费，不复制字面量。
const QODER_API_BASES = QODER_ACCOUNT_BASES;

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function readFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampPct(value) {
  return Math.max(0, Math.min(100, value));
}

function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function formatResetIn(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时后`;
  return `${Math.floor(hours / 24)} 天后`;
}

/** 该 provider 的账号面 base URL（未登记的 provider 返回 ''）。 */
function resolveQoderApiBase(provider) {
  const normalized = normalizeText(provider).toLowerCase();
  return QODER_API_BASES[normalized] || '';
}

/** 从账号记录里取账号面 token（PAT env → 可读载荷 → CLI opaque blob 解密）。 */
function resolveQoderAccessToken(provider, record = {}) {
  const env = record.env && typeof record.env === 'object' ? record.env : {};
  const pat = normalizeText(env.QODER_PERSONAL_ACCESS_TOKEN);
  if (pat) return { token: pat, tokenSource: 'env_pat' };
  const nativeAuth = record.nativeAuth && typeof record.nativeAuth === 'object' ? record.nativeAuth : {};
  const payload = resolveQoderNativeAuthPayload(provider, nativeAuth);
  if (payload) {
    const token = normalizeText(payload.security_oauth_token || payload.access_token || payload.token);
    if (token) return { token, tokenSource: 'native_auth' };
  }
  const decrypted = decryptQoderCredential(provider, nativeAuth);
  if (decrypted && decrypted.token) return { token: decrypted.token, tokenSource: 'cli_wasm' };
  return { token: '', tokenSource: '' };
}

/** 单次 GET（带超时与账号出口代理）；返回 { status, json } 或 { error }。 */
async function fetchQoderJson(fetchWithTimeout, url, token, timeoutMs, requestOptions) {
  if (typeof fetchWithTimeout !== 'function') return { error: 'fetch_unavailable' };
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      ...(requestOptions || {})
    }, timeoutMs);
    const status = Number(response && response.status) || 0;
    let json = null;
    try {
      json = await response.json();
    } catch (_error) {
      json = null;
    }
    if (status === 401 || status === 403) return { status, json, error: 'qoder_quota_unauthorized', auth: true };
    if (status < 200 || status >= 300) return { status, json, error: `qoder_quota_http_${status}` };
    if (!json || typeof json !== 'object') return { status, json, error: 'qoder_quota_invalid_response' };
    return { status, json };
  } catch (error) {
    return { error: `qoder_quota_request_failed:${normalizeText(error && error.message) || 'unknown'}` };
  }
}

/** 额度响应 → entries（一个 credits 池 + 到期时间）。 */
function buildQoderQuotaEntries(usage, plan, status, nowMs) {
  const quota = usage && typeof usage.userQuota === 'object' && usage.userQuota ? usage.userQuota : {};
  const total = readFiniteNumber(quota.total);
  const used = readFiniteNumber(quota.used);
  const remaining = readFiniteNumber(quota.remaining);
  const percentage = readFiniteNumber(quota.percentage);
  const totalPct = readFiniteNumber(usage && usage.totalUsagePercentage);
  // Free 档没有可消耗的 credits（total=0，且上游恒报 isQuotaExceeded=true）。
  // **绝不能**把它折算成 remainingPct=0：账号可用性判定会把 ≤0 的账号判成
  // quota_exhausted 并从路由里摘掉（lib/server/account-availability.js），
  // 而 Free 档其实还能跑免费模型（实测）。没有可消耗池 → 额度不适用。
  if (!(total > 0)) return [];
  const usedPct = percentage !== null ? percentage : (totalPct !== null ? totalPct : null);
  let remainingPct = usedPct !== null
    ? clampPct(100 - usedPct)
    : (remaining !== null ? clampPct((remaining / total) * 100) : null);
  if (remainingPct === null) return [];
  // 上游显式说超了就以 0 计（例如已用满的付费档）。
  if (usage && usage.isQuotaExceeded === true) remainingPct = 0;
  // expiresAt 对无限期档位是远期哨兵（253402214400000 = 9999-12-31），别显示成「291 万天后」。
  const rawResetAtMs = readFiniteNumber(usage && usage.expiresAt)
    || readFiniteNumber(status && status.nextResetAt)
    || 0;
  const resetAtMs = rawResetAtMs > 0 && rawResetAtMs < 4102444800000 ? rawResetAtMs : 0;
  const unit = normalizeText(quota.unit) || 'credits';
  return [{
    bucket: 'credits',
    window: 'Credits',
    windowMinutes: resetAtMs > nowMs ? Math.round((resetAtMs - nowMs) / 60_000) : 0,
    remainingPct: roundTo(remainingPct, 2),
    totalUnits: roundTo(total, 2),
    usedUnits: used === null ? 0 : roundTo(used, 2),
    remainingUnits: remaining === null ? 0 : roundTo(remaining, 2),
    unitType: unit,
    quotaExceeded: Boolean(usage && usage.isQuotaExceeded) || Boolean(status && status.isQuotaExceeded),
    resetAtMs,
    resetIn: resetAtMs > nowMs ? formatResetIn(resetAtMs - nowMs) : ''
  }];
}


function createProbe(deps = {}) {
  const {
    fs,
    aiHomeDir,
    fetchWithTimeout,
    processObj,
    accountEgressDeps,
    usageSnapshotSchemaVersion
  } = deps;
  const readCredentialRecord = typeof deps.readAccountCredentialRecord === 'function'
    ? deps.readAccountCredentialRecord
    : readAccountCredentialRecord;
  const resolveEgressOptions = typeof deps.resolveAccountEgressRequestOptions === 'function'
    ? deps.resolveAccountEgressRequestOptions
    : resolveAccountEgressRequestOptionsDefault;

  async function resolveRequestOptions(accountRef, provider) {
    const env = (processObj && processObj.env) || {};
    try {
      const resolved = await resolveEgressOptions({
        fs,
        aiHomeDir,
        processObj,
        provider,
        accountRef,
        options: {
          proxyUrl: env.AIH_SERVER_PROXY_URL || env.HTTPS_PROXY || env.HTTP_PROXY,
          noProxy: env.AIH_SERVER_NO_PROXY || env.NO_PROXY || env.no_proxy
        },
        deps: accountEgressDeps || {}
      });
      if (!resolved || !resolved.ok || !resolved.options) {
        return { error: `account_egress_unavailable:${normalizeText(resolved && resolved.error) || 'unknown'}` };
      }
      return { options: resolved.options };
    } catch (error) {
      return { error: `account_egress_unavailable:${normalizeText(error && error.message) || 'unknown'}` };
    }
  }

  async function probe(accountRef, probeTimeoutMs) {
    const timeoutMs = Math.max(1_000, Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
    const record = typeof readCredentialRecord === 'function'
      ? readCredentialRecord(fs, aiHomeDir, accountRef)
      : null;
    if (!record) return { error: 'credential_record_missing' };
    const provider = normalizeText(record.provider).toLowerCase();
    if (!isQoderProvider(provider)) return { error: 'credential_record_missing' };
    const apiBase = resolveQoderApiBase(provider);
    if (!apiBase) return { error: 'qoder_quota_base_unknown' };

    const resolvedToken = resolveQoderAccessToken(provider, record);
    if (!resolvedToken.token) return { error: 'qoder_quota_token_missing' };

    const egress = await resolveRequestOptions(accountRef, provider);
    if (egress.error) return { error: egress.error };

    const nowMs = Date.now();
    const usage = await fetchQoderJson(
      fetchWithTimeout, `${apiBase}${QODER_ACCOUNT_ROUTES.quota}`, resolvedToken.token, timeoutMs, egress.options
    );
    if (usage.error) return { error: usage.error, auth: Boolean(usage.auth) };
    const [plan, status] = await Promise.all([
      fetchQoderJson(fetchWithTimeout, `${apiBase}${QODER_ACCOUNT_ROUTES.plan}`, resolvedToken.token, timeoutMs, egress.options),
      fetchQoderJson(fetchWithTimeout, `${apiBase}${QODER_ACCOUNT_ROUTES.status}`, resolvedToken.token, timeoutMs, egress.options)
    ]);
    const planJson = plan && !plan.error ? plan.json : {};
    const statusJson = status && !status.error ? status.json : {};

    const entries = buildQoderQuotaEntries(usage.json, planJson, statusJson, nowMs);
    if (entries.length === 0) {
      // 「没有可消耗的额度池」（Free 档 credits=0）是**结论**而不是失败：返回 notApplicable，
      // 账号页显示「额度不适用」，且不会被判成 quota_exhausted 而摘出路由。
      const totalUnits = readFiniteNumber(usage.json && usage.json.userQuota && usage.json.userQuota.total);
      if (totalUnits !== null && totalUnits <= 0) {
        return { notApplicable: true, reason: 'qoder_no_consumable_credits' };
      }
      return { error: 'qoder_quota_fields_missing' };
    }

    return {
      snapshot: {
        schemaVersion: usageSnapshotSchemaVersion,
        kind: USAGE_SNAPSHOT_KINDS[provider],
        source: USAGE_SOURCE_QODER,
        capturedAt: nowMs,
        account: {
          userId: normalizeText(usage.json.userId) || normalizeText(statusJson.id),
          email: normalizeText(statusJson.email),
          name: normalizeText(statusJson.name),
          userType: normalizeText(usage.json.userType) || normalizeText(statusJson.userType),
          planName: normalizeText(planJson.plan_tier_name) || normalizeText(statusJson.userTag),
          planTier: normalizeText(statusJson.plan),
          isPaidPlan: planJson.is_paid_plan === true,
          periodStartMs: readFiniteNumber(planJson.start_date) || 0,
          periodEndMs: readFiniteNumber(planJson.end_date) || 0
        },
        entries,
        coverage: {
          source: 'qoder_quota_usage_api',
          tokenSource: resolvedToken.tokenSource
        }
      }
    };
  }

  return { probe };
}

module.exports = {
  createProbe,
  __private: {
    QODER_API_BASES,
    buildQoderQuotaEntries,
    resolveQoderAccessToken,
    resolveQoderApiBase,
    formatResetIn
  }
};

