'use strict';

// Cline Pass 额度探针实现（能力事实声明在 lib/providers/defs/cline.js 的 quota 能力里）。
//
// 为什么是插件：Cline 的额度不在推理面（`api.cline.bot/api/v1/chat/completions`）上暴露，
// provider 合同里只有 `api_key_account, model_catalog`，没有原生额度接口；它的额度必须从
// Cline 账号侧接口自己取。按 `lib/usage/quota` 的插件契约实现，而不是往内核再加一支分支。
//
// 上游实测（2026-10-14，宿主账号真实凭据）：
//   GET /api/v1/users/me/plan/usage-limits      ← **服务端权威用量**
//     → data.limits[{ type: 'five_hour' | 'weekly' | 'monthly', percentUsed, resetsAt }]
//   GET /api/v1/users/me/plan
//     → data.userId / data.currentPeriodStart / data.currentPeriodEnd / data.plan.displayName
//       data.plan.entitlements.cline_pass.inferenceCapThreshold = {
//         last5HoursUsageCostUSDPerUser, last7daysUsageCostUSDPerUser, last30daysUsageCostUSDPerUser }
//       上限单位是 **1e-8 USD**（`costUsd` 同单位），除以 1e8 得美元。
//
// **不要**用 `/users/{uid}/usages` 逐条累加来算窗口用量（曾这么实现，实测偏小 3 倍以上）：
//   1) 该接口按 `limit` 只回最新一页（`limit=1000` 实测被夹到 200），
//   2) `nextToken` 游标上游实际不生效（连续翻页返回同一批最新记录，翻不回历史），
//   3) 于是任何滚动窗口都只能扫到最近十几分钟，`used` 被严重低估、`remaining` 虚高。
// `/plan/usage-limits` 直接给服务端算好的 percentUsed 与 resetsAt，既准确又只需一次请求。
// `/usages` 只适合「最近若干笔明细」，不适合窗口聚合。
//
// 额度模型 = 三个滚动窗口（5h / 7d / 30d）的消费上限；remainingPct = 100 - percentUsed。

const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_CLINE } = require('../../../account/usage-remaining');
const { readClineApiKey, selectClineOAuthCredential } = require('../../../account/cline-credentials');
const { CLINE_DEFAULT_BASE_URL } = require('../../../account/provider-api-base-url');
const { readAccountCredentialRecord } = require('../../../server/account-credential-store');
const { refreshClineAccessToken } = require('../../../server/cline-token-refresh');
const {
  resolveAccountEgressRequestOptions: resolveAccountEgressRequestOptionsDefault
} = require('../../../server/account-egress-request-options');

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
// caps 与 costUsd 的单位：1e-8 USD。
const CLINE_COST_UNIT_PER_USD = 100_000_000;

// 上游 limits[].type → 展示窗口。滚动窗口由上游给 resetsAt，不自己推算。
const USAGE_WINDOWS = Object.freeze([
  { id: '5h', type: 'five_hour', minutes: 300, capKey: 'last5HoursUsageCostUSDPerUser' },
  { id: '7days', type: 'weekly', minutes: 10_080, capKey: 'last7daysUsageCostUSDPerUser' },
  { id: '30days', type: 'monthly', minutes: 43_200, capKey: 'last30daysUsageCostUSDPerUser' }
]);

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
  return Math.round(value * factor) / factor;
}

function formatWindowLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value % 10_080 === 0) return `${value / 10_080 * 7}days`;
  if (value % 1_440 === 0) return `${value / 1_440}days`;
  if (value % 60 === 0) return `${value / 60}h`;
  return `${value}m`;
}

function formatResetIn(diffMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(diffMs) / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/** 推理面的 base（`.../api/v1`）同时是账号面接口的 base；账号级覆盖会一起生效。 */
function resolveAccountApiBase(env = {}) {
  const raw = normalizeText(env.CLINE_API_BASE_URL) || CLINE_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/** `/users/me/plan/usage-limits` → `{ five_hour: { percentUsed, resetsAtMs }, … }` */
function readUsageLimits(payload) {
  const data = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
    ? payload.data
    : {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const byType = {};
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue;
    const type = normalizeText(item.type);
    if (!type) continue;
    const percentUsed = readFiniteNumber(item.percentUsed);
    const resetsAtMs = Date.parse(String(item.resetsAt || ''));
    byType[type] = {
      percentUsed: percentUsed === null ? null : clampPct(percentUsed),
      resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : 0
    };
  }
  return byType;
}

/**
 * 从 `/users/me/plan` 响应里读出 Cline Pass 的窗口上限（美元）与套餐身份。
 * @returns {{capsUsd: object, userId: string, planName: string, periodStartMs: number, periodEndMs: number}|null}
 */
function readPlanEntitlement(payload) {
  const data = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
    ? payload.data
    : null;
  if (!data) return null;
  const plan = data.plan && typeof data.plan === 'object' ? data.plan : {};
  const entitlements = plan.entitlements && typeof plan.entitlements === 'object' ? plan.entitlements : {};
  const clinePass = entitlements.cline_pass && typeof entitlements.cline_pass === 'object'
    ? entitlements.cline_pass
    : null;
  const threshold = clinePass
    && clinePass.inferenceCapThreshold
    && typeof clinePass.inferenceCapThreshold === 'object'
    ? clinePass.inferenceCapThreshold
    : null;
  if (!clinePass || clinePass.enabled !== true || !threshold) return null;
  const capsUsd = {};
  for (const window of USAGE_WINDOWS) {
    const cap = readFiniteNumber(threshold[window.capKey]);
    if (cap === null || cap <= 0) continue;
    capsUsd[window.id] = cap / CLINE_COST_UNIT_PER_USD;
  }
  const periodStartMs = Date.parse(String(data.currentPeriodStart || ''));
  const periodEndMs = Date.parse(String(data.currentPeriodEnd || ''));
  return {
    capsUsd,
    userId: normalizeText(data.userId),
    planName: normalizeText(plan.displayName || plan.name),
    periodStartMs: Number.isFinite(periodStartMs) ? periodStartMs : 0,
    periodEndMs: Number.isFinite(periodEndMs) ? periodEndMs : 0
  };
}

/**
 * 把服务端 percentUsed / resetsAt 折算成 entries[]。
 * 上限缺失或该窗口没有 percentUsed 时不产出条目（宁可 Unknown，不臆造）。
 * @returns {{entries: Array, missingWindows: string[]}}
 */
function summarizeUsageWindows(input = {}) {
  const usageByType = input.usageByType && typeof input.usageByType === 'object' ? input.usageByType : {};
  const capsUsd = input.capsUsd && typeof input.capsUsd === 'object' ? input.capsUsd : {};
  const nowMs = Number(input.nowMs) || Date.now();
  const entries = [];
  const missingWindows = [];
  for (const window of USAGE_WINDOWS) {
    const usage = usageByType[window.type];
    const capUsd = readFiniteNumber(capsUsd[window.id]);
    if (!usage || usage.percentUsed === null || capUsd === null || capUsd <= 0) {
      missingWindows.push(window.id);
      continue;
    }
    const usedUsd = roundTo(capUsd * usage.percentUsed / 100, 4);
    const resetAtMs = usage.resetsAtMs || 0;
    entries.push({
      bucket: window.id,
      window: formatWindowLabel(window.minutes),
      windowMinutes: window.minutes,
      remainingPct: clampPct(100 - usage.percentUsed),
      totalUnits: roundTo(capUsd, 4),
      usedUnits: usedUsd,
      remainingUnits: roundTo(Math.max(0, capUsd - usedUsd), 4),
      unitType: 'usd',
      resetAtMs,
      resetIn: resetAtMs > 0 ? formatResetIn(resetAtMs - nowMs) : ''
    });
  }
  return { entries, missingWindows };
}

function createProbe(deps = {}) {
  const {
    fs,
    aiHomeDir,
    fetchWithTimeout,
    processObj,
    accountEgressDeps,
    accountArtifactHooks,
    usageSnapshotSchemaVersion
  } = deps;
  const readCredentialRecord = typeof deps.readAccountCredentialRecord === 'function'
    ? deps.readAccountCredentialRecord
    : readAccountCredentialRecord;
  const resolveEgressOptions = typeof deps.resolveAccountEgressRequestOptions === 'function'
    ? deps.resolveAccountEgressRequestOptions
    : resolveAccountEgressRequestOptionsDefault;
  const refreshAccessToken = typeof deps.refreshClineAccessToken === 'function'
    ? deps.refreshClineAccessToken
    : refreshClineAccessToken;

  async function probe(accountRef, probeTimeoutMs) {
    const timeoutMs = Math.max(1_000, Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
    const record = typeof readCredentialRecord === 'function'
      ? readCredentialRecord(fs, aiHomeDir, accountRef)
      : null;
    if (!record || record.provider !== 'cline') return { error: 'credential_record_missing' };
    const env = record.env || {};
    if (readClineApiKey(record.nativeAuth && record.nativeAuth.auth) || normalizeText(env.CLINE_API_KEY)) {
      // API Key 账号没有 Cline Pass 订阅额度端点，Remaining 对这类账号不适用。
      return { error: 'api_key_mode_not_applicable' };
    }
    const credential = selectClineOAuthCredential(record.nativeAuth && record.nativeAuth.auth);
    if (!credential || (!credential.accessToken && !credential.refreshToken)) {
      return { error: 'missing_oauth_credentials' };
    }
    return probeWithCredential(accountRef, credential, env, timeoutMs);
  }

  async function resolveRequestOptions(accountRef) {
    const env = (processObj && processObj.env) || {};
    try {
      const resolved = await resolveEgressOptions({
        fs,
        aiHomeDir,
        processObj,
        provider: 'cline',
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
      return { error: `account_egress_unavailable:${normalizeText(error && error.message || error).slice(0, 120)}` };
    }
  }

  async function fetchJson(url, accessToken, timeoutMs, requestOptions) {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    }, timeoutMs, requestOptions);
    if (!res || !res.ok) {
      return { error: `cline_quota_http_${res ? res.status : 'unreachable'}`, status: res ? res.status : 0 };
    }
    const payload = await res.json().catch(() => null);
    if (!payload || typeof payload !== 'object') return { error: 'cline_quota_payload_invalid' };
    return { payload };
  }

  function isAuthError(error) {
    return error === 'cline_quota_http_401' || error === 'cline_quota_http_403';
  }

  async function fetchQuotaPair(apiBase, accessToken, timeoutMs, requestOptions) {
    const [limits, plan] = await Promise.all([
      fetchJson(`${apiBase}/users/me/plan/usage-limits`, accessToken, timeoutMs, requestOptions),
      fetchJson(`${apiBase}/users/me/plan`, accessToken, timeoutMs, requestOptions)
    ]);
    const failure = limits.error ? limits : (plan.error ? plan : null);
    if (failure) return { error: failure.error, auth: isAuthError(failure.error) };
    const entitlement = readPlanEntitlement(plan.payload);
    if (!entitlement) return { error: 'cline_pass_entitlement_missing' };
    return { usageByType: readUsageLimits(limits.payload), entitlement };
  }

  async function probeWithCredential(accountRef, credential, env, timeoutMs) {
    const apiBase = resolveAccountApiBase(env);
    const egress = await resolveRequestOptions(accountRef);
    if (egress.error) return { error: egress.error };
    const requestOptions = egress.options;

    const account = {
      accountRef,
      provider: 'cline',
      apiKeyMode: false,
      authType: 'oauth',
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      tokenExpiresAt: credential.expiresAt
    };
    const nowMs = Date.now();
    let accessToken = credential.accessToken;
    let quota = await fetchQuotaPair(apiBase, accessToken, timeoutMs, requestOptions);
    // access token 可能刚落盘就过期：401/403 时强制刷新一次再重试，避免把「令牌过期」
    // 误报成「没有额度」。
    if (quota.error && quota.auth) {
      const refreshed = await refreshAccessToken(account, { force: true, timeoutMs }, {
        fs,
        aiHomeDir,
        accountArtifactHooks,
        fetchWithTimeout,
        accountEgressDeps,
        resolveAccountEgressRequestOptions: resolveEgressOptions
      }).catch((error) => ({ ok: false, reason: normalizeText(error && error.message) }));
      const nextToken = normalizeText(refreshed && refreshed.accessToken) || normalizeText(account.accessToken);
      if (!refreshed || refreshed.ok !== true || !nextToken || nextToken === accessToken) {
        return { error: quota.error, auth: true };
      }
      accessToken = nextToken;
      quota = await fetchQuotaPair(apiBase, accessToken, timeoutMs, requestOptions);
    }
    if (quota.error) return { error: quota.error, auth: Boolean(quota.auth) };

    const summary = summarizeUsageWindows({
      usageByType: quota.usageByType,
      capsUsd: quota.entitlement.capsUsd,
      nowMs
    });
    if (summary.entries.length === 0) {
      return { error: `cline_pass_windows_missing:${summary.missingWindows.join(',') || 'unknown'}` };
    }

    return {
      snapshot: {
        schemaVersion: usageSnapshotSchemaVersion,
        kind: USAGE_SNAPSHOT_KINDS.cline,
        source: USAGE_SOURCE_CLINE,
        capturedAt: nowMs,
        account: {
          userId: quota.entitlement.userId,
          planName: quota.entitlement.planName,
          periodStartMs: quota.entitlement.periodStartMs,
          periodEndMs: quota.entitlement.periodEndMs
        },
        entries: summary.entries,
        coverage: {
          // 服务端权威用量：覆盖度由上游 limits[] 决定，缺哪个窗口就是缺哪个。
          source: 'plan_usage_limits',
          missingWindows: summary.missingWindows
        }
      }
    };
  }

  return { probe };
}

module.exports = {
  createProbe,
  __private: {
    USAGE_WINDOWS,
    CLINE_COST_UNIT_PER_USD,
    formatWindowLabel,
    formatResetIn,
    resolveAccountApiBase,
    readUsageLimits,
    readPlanEntitlement,
    summarizeUsageWindows
  }
};
