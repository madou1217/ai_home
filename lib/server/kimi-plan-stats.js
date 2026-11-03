'use strict';

// kimi 套餐配额统计（kimi.com 订阅控制台「My Quota」页的数据面）。
// 数据源是桌面端托管扫码拿到的 kimi.com Web session（nativeAuth.desktopSession，
// 见 kimi-desktop-session.js）；kimi-code CLI 的 OAuth token 对这些接口一律 401。
// 走官方 Connect RPC（与 /code/console 前端同一通道）：
//   POST {baseUrl}/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats
//   POST {baseUrl}/kimi.gateway.membership.v2.MembershipService/GetSubscription
// GetSubscriptionStats 返回 5h/7d 限时窗口（ratelimit_code_5h 等）、月度订阅额度
// （subscription_balance，amount_used_ratio 总量 + kimi_code_used_ratio 其中 Code 部分）、
// gift_balances（如 Invite to Earn Credit）、notice/overdrawn（月度用尽提示）。
// GetSubscription 补充套餐名（goods.title）、有效期（next_billing_time）与重置日。
// 注意 proto3 JSON 会省略零值字段：ratio 缺失即 0，对象缺失即未启用。

const {
  describeAccountEgressFailure,
  resolveProviderAccountEgressRequestOptions
} = require('./account-egress-request-options');
const {
  ensureDesktopSessionAccessToken,
  refreshDesktopSessionToken,
  readDesktopSession,
  writeDesktopSession
} = require('./kimi-desktop-session');
const { readAccountCredentialRecord } = require('./account-credential-store');

const DEFAULT_STATS_BASE_URL = 'https://www.kimi.com/apiv2';
const MEMBERSHIP_SERVICE = 'kimi.gateway.membership.v2.MembershipService';
const DEFAULT_TIMEOUT_MS = 10_000;
const STATS_CACHE_TTL_MS = 30_000;

// 成功结果按账号短缓存，避免 WebUI 轮询/重复打开时反复打上游 RPC。
const statsCache = new Map();

function resolveStatsBaseUrl(deps = {}) {
  return String(
    deps.statsBaseUrl || process.env.KIMI_PLAN_STATS_BASE_URL || DEFAULT_STATS_BASE_URL
  ).trim().replace(/\/+$/, '');
}

function resolveFetch(deps = {}) {
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  return fetchImpl;
}

function resolveFetchWithTimeout(deps = {}) {
  if (typeof deps.fetchWithTimeout === 'function') return deps.fetchWithTimeout;
  const { fetchWithTimeout } = require('./http-utils');
  if (typeof fetchWithTimeout !== 'function') throw new Error('fetch_with_timeout_unavailable');
  return fetchWithTimeout;
}

// Connect JSON 响应既可能是 camelCase（官方 web 客户端），也可能按
// useProtoFieldName 返回 snake_case，两种都接受。
function readField(data, ...names) {
  if (!data || typeof data !== 'object') return undefined;
  for (const name of names) {
    if (data[name] !== undefined && data[name] !== null) return data[name];
  }
  return undefined;
}

function readRatio(data, ...names) {
  const value = Number(readField(data, ...names));
  if (!Number.isFinite(value)) return 0; // proto3 省略零值
  return Math.max(0, Math.min(1, value));
}

function readTimeMs(data, ...names) {
  const raw = readField(data, ...names);
  const ms = Date.parse(String(raw || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeRateLimitStat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    usedRatio: readRatio(raw, 'ratio'),
    enabled: readField(raw, 'enabled') !== false,
    resetAtMs: readTimeMs(raw, 'resetTime', 'reset_time')
  };
}

function normalizeBalance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    name: String(readField(raw, 'displayName', 'display_name') || '').trim(),
    type: String(readField(raw, 'type') || '').trim(),
    usedRatio: readRatio(raw, 'amountUsedRatio', 'amount_used_ratio'),
    codeUsedRatio: readRatio(raw, 'kimiCodeUsedRatio', 'kimi_code_used_ratio'),
    expireAtMs: readTimeMs(raw, 'expireTime', 'expire_time')
  };
}

function normalizeSubscriptionStats(payload, nowMs) {
  if (!payload || typeof payload !== 'object') return null;
  const subscriptionBalance = normalizeBalance(readField(payload, 'subscriptionBalance', 'subscription_balance'));
  const rawGifts = readField(payload, 'giftBalances', 'gift_balances');
  const gifts = (Array.isArray(rawGifts) ? rawGifts : [])
    .map(normalizeBalance)
    .filter(Boolean);
  const noticeRaw = readField(payload, 'notice');
  const notice = noticeRaw && typeof noticeRaw === 'object'
    ? {
        tip: String(readField(noticeRaw, 'tip') || '').trim(),
        content: String(readField(noticeRaw, 'content') || '').trim(),
        resetAtMs: readTimeMs(noticeRaw, 'resetTime', 'reset_time')
      }
    : null;
  return {
    capturedAtMs: nowMs || Date.now(),
    total: subscriptionBalance
      ? {
          usedRatio: subscriptionBalance.usedRatio,
          codeUsedRatio: subscriptionBalance.codeUsedRatio,
          resetAtMs: subscriptionBalance.expireAtMs
        }
      : null,
    rateLimits: {
      chat5h: normalizeRateLimitStat(readField(payload, 'ratelimit5h', 'ratelimit_5h')),
      code5h: normalizeRateLimitStat(readField(payload, 'ratelimitCode5h', 'ratelimit_code_5h')),
      chat7d: normalizeRateLimitStat(readField(payload, 'ratelimit7d', 'ratelimit_7d')),
      code7d: normalizeRateLimitStat(readField(payload, 'ratelimitCode7d', 'ratelimit_code_7d'))
    },
    gifts,
    notice,
    overdrawn: readField(payload, 'overdrawn') === true
  };
}

function normalizeSubscription(payload) {
  const subscription = readField(payload, 'subscription');
  if (!subscription || typeof subscription !== 'object') return null;
  const goods = readField(subscription, 'goods') || {};
  const status = String(readField(subscription, 'status') || '').trim();
  const level = String(readField(goods, 'membershipLevel', 'membership_level') || '').trim();
  return {
    name: String(readField(goods, 'title') || '').trim(),
    level: level ? level.replace(/^LEVEL_/i, '').toLowerCase() : '',
    // SUBSCRIPTION_STATUS_CANCEL = 已取消续费但当前周期仍有效（官方页显示 Resubscribe）
    status: status === 'SUBSCRIPTION_STATUS_CANCEL' ? 'canceled' : 'active',
    validUntilMs: readTimeMs(subscription, 'nextBillingTime', 'next_billing_time'),
    resetAtMs: readTimeMs(subscription, 'currentEndTime', 'current_end_time')
  };
}

async function resolveMembershipRequestOptions(deps) {
  const result = await resolveProviderAccountEgressRequestOptions({
    account: { provider: 'kimi', accountRef: String(deps.accountRef || '').trim() },
    provider: 'kimi',
    options: {
      proxyUrl: String(deps.proxyUrl || '').trim(),
      noProxy: String(deps.noProxy || '').trim()
    },
    deps: {
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir,
      processObj: deps.processObj,
      accountEgressDeps: deps.accountEgressDeps,
      resolveAccountEgressRequestOptions: deps.resolveAccountEgressRequestOptions
    }
  });
  if (!result?.ok || !result.options) {
    const failure = describeAccountEgressFailure(result);
    const error = new Error(failure.detail);
    error.code = failure.reason;
    throw error;
  }
  return result;
}

async function callMembershipRpc(deps, requestOptions, method, accessToken) {
  const timeoutMs = Math.max(1_000, Number(deps.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const url = `${resolveStatsBaseUrl(deps)}/${MEMBERSHIP_SERVICE}/${method}`;
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'x-msh-platform': 'web'
    },
    body: '{}'
  };
  const res = requestOptions.bound
    ? await resolveFetchWithTimeout(deps)(url, init, timeoutMs, {
        proxyUrl: requestOptions.options.proxyUrl,
        noProxy: requestOptions.options.noProxy
      })
    : await resolveFetch(deps)(url, init);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// access_token 落盘后可能刚好失效：401 时强制走 RefreshToken 轮换一次再重试，
// 与 kimi-quota-probe 的 usages 401 重试策略对齐。
async function refreshWebAccessToken(fsImpl, aiHomeDir, accountRef, deps) {
  const record = readAccountCredentialRecord(fsImpl, aiHomeDir, accountRef);
  const session = readDesktopSession(record);
  if (!session) return { ok: false, error: 'desktop_session_missing' };
  const refreshed = await refreshDesktopSessionToken({ ...deps, fs: fsImpl, aiHomeDir, accountRef }, session.refreshToken);
  if (!refreshed.ok) return { ok: false, error: refreshed.error };
  writeDesktopSession(fsImpl, aiHomeDir, accountRef, {
    ...session,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken
  });
  return { ok: true, accessToken: refreshed.accessToken };
}

// 返回 { ok:true, stats } 或 { ok:false, error }；不抛异常，由路由层决定 HTTP 状态。
async function fetchKimiPlanStats(deps = {}, options = {}) {
  const fsImpl = deps.fs;
  const aiHomeDir = deps.aiHomeDir;
  const accountRef = String(deps.accountRef || '').trim();
  if (!fsImpl || !aiHomeDir || !accountRef) return { ok: false, error: 'missing_deps' };

  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const cacheKey = accountRef;
  if (options.refresh !== true) {
    const cached = statsCache.get(cacheKey);
    if (cached && nowMs - cached.atMs < STATS_CACHE_TTL_MS) {
      return { ok: true, stats: cached.stats, cached: true };
    }
  }

  let token = await ensureDesktopSessionAccessToken(fsImpl, aiHomeDir, accountRef, deps);
  if (!token.ok) return { ok: false, error: token.error || 'desktop_session_missing', auth: true };

  let requestOptions;
  try {
    requestOptions = await resolveMembershipRequestOptions({ ...deps, accountRef });
  } catch (error) {
    return { ok: false, error: `account_egress_unavailable:${String(error && error.message || error).slice(0, 120)}` };
  }

  try {
    let statsRes = await callMembershipRpc(deps, requestOptions, 'GetSubscriptionStats', token.accessToken);
    if (statsRes.status === 401 || statsRes.status === 403) {
      const refreshed = await refreshWebAccessToken(fsImpl, aiHomeDir, accountRef, deps);
      if (!refreshed.ok) return { ok: false, error: refreshed.error, auth: true };
      token = refreshed;
      statsRes = await callMembershipRpc(deps, requestOptions, 'GetSubscriptionStats', token.accessToken);
    }
    if (statsRes.status !== 200 || !statsRes.data || typeof statsRes.data !== 'object') {
      return { ok: false, error: `kimi_plan_stats_http_${statsRes.status || 'unknown'}` };
    }
    const stats = normalizeSubscriptionStats(statsRes.data, nowMs);
    if (!stats) return { ok: false, error: 'empty_subscription_stats' };

    // GetSubscription 只补充套餐名/有效期，失败不影响主数据。
    const subRes = await callMembershipRpc(deps, requestOptions, 'GetSubscription', token.accessToken)
      .catch(() => null);
    if (subRes && subRes.status === 200) {
      stats.plan = normalizeSubscription(subRes.data);
    } else {
      stats.plan = null;
    }

    statsCache.set(cacheKey, { atMs: nowMs, stats });
    return { ok: true, stats };
  } catch (error) {
    return { ok: false, error: `plan_stats_exception:${String(error && error.message || error).slice(0, 120)}` };
  }
}

function clearKimiPlanStatsCache(accountRef) {
  if (accountRef) statsCache.delete(String(accountRef));
  else statsCache.clear();
}

module.exports = {
  fetchKimiPlanStats,
  clearKimiPlanStatsCache,
  DEFAULT_STATS_BASE_URL,
  STATS_CACHE_TTL_MS,
  __private: {
    normalizeSubscriptionStats,
    normalizeSubscription,
    normalizeBalance,
    readRatio,
    readTimeMs
  }
};
