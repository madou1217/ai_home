'use strict';

// zcode 配额探测：Remaining 抽象（lib/account/usage-remaining.js）的 zcode 实现。
// 端点与 ZCode 桌面端一致（http-utils.js 的模型探测走同一接口）：
//   GET ZCODE_PLAN_BALANCE_URL  Authorization: Bearer <zcodeJwtToken>
// 响应 { code, success, data:{ plans:[{name,...}], balances:[{
//   show_name, capabilities:["model:glm-5.3"], unit_type:"token", total_units,
//   used_units, remaining_units, available_units, period, period_start, period_end }] } }
// （period_start/period_end 为 Unix 秒）；业务错误是 HTTP 200 + { code!=0, success:false }。
// 产出的快照复用时间窗型 entries[] 形状（同 codex/claude/kimi），展示层无需为 zcode 单开分支。

const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_ZCODE } = require('../../../account/usage-remaining');
const { ZCODE_PLAN_BALANCE_URL } = require('../../../account/provider-api-base-url');
const { readZcodeOAuthCredential } = require('../../../account/zcode-credential');

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

const PERIOD_WINDOW_MINUTES = Object.freeze({
  daily: 1440,
  weekly: 10080,
  monthly: 43200
});

// 与 codex/claude/kimi 展示约定对齐：5h / 7days 风格，短窗在前由调用方排序。
function formatWindowLabel(windowMinutes) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes % 10080 === 0) return `${minutes / 10080 * 7}days`;
  if (minutes % 1440 === 0) return `${minutes / 1440}days`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// period_start/period_end 是 Unix 秒，直接以 ms 计算（kimi 的 resetIn 从 ISO 解析）。
function formatResetInFromMs(resetAtMs, nowMs) {
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) return '';
  const diffSec = Math.max(0, Math.floor((resetAtMs - (nowMs || Date.now())) / 1000));
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

// bucket 与桌面端 resolveZaiStartPlanBalanceModelIds 对齐：capabilities 里首个
// model:* 的值优先（去掉前缀），没有则回退 show_name。
function resolveBalanceBucket(balance) {
  const capabilities = Array.isArray(balance && balance.capabilities) ? balance.capabilities : [];
  for (const cap of capabilities) {
    const value = String(cap || '').trim();
    if (!value.toLowerCase().startsWith('model:')) continue;
    const modelId = value.slice('model:'.length).trim();
    if (modelId) return modelId;
  }
  return String(balance && balance.show_name || '').trim();
}

function toUsageEntry(balance, capturedAt) {
  if (!balance || typeof balance !== 'object') return null;
  const total = Number(balance.total_units);
  const used = Number(balance.used_units);
  const remaining = Number(balance.remaining_units);
  if (!Number.isFinite(total) && !Number.isFinite(used) && !Number.isFinite(remaining)) return null;
  // balance 接口同时给 used_units 和 remaining_units；remaining 是上游权威值，优先采用，
  // 缺失时才按 total-used 推算，避免 summary 只带 remaining 时被误算成 100%。
  const remainingPct = Number.isFinite(total) && total > 0
    ? Math.max(0, Math.min(100, ((Number.isFinite(remaining) ? remaining : total - (Number.isFinite(used) ? used : 0)) * 100) / total))
    : null;
  // balances 条目通常不带 period 字段（period 只在 plans[*].entitlements 上），
  // 缺省时从 period_end-period_start 的实际跨度推导窗口。
  const period = String(balance.period || '').trim().toLowerCase();
  let windowMinutes = PERIOD_WINDOW_MINUTES[period] || 0;
  const periodStartSec = Number(balance.period_start);
  const periodEndSec = Number(balance.period_end);
  if (windowMinutes === 0 && Number.isFinite(periodStartSec) && Number.isFinite(periodEndSec) && periodEndSec > periodStartSec) {
    windowMinutes = Math.round((periodEndSec - periodStartSec) / 60);
  }
  const resetAtMs = Number.isFinite(periodEndSec) && periodEndSec > 0 ? periodEndSec * 1000 : 0;
  const window = formatWindowLabel(windowMinutes);
  return {
    bucket: resolveBalanceBucket(balance) || (windowMinutes > 0 ? `rolling_${windowMinutes}m` : window),
    windowMinutes,
    window,
    remainingPct,
    // billing/balance 的绝对额度原样透传（unit_type=token 时即 token 数），
    // WebUI hover 进度条时展示「总/剩余/已用」；其余 provider 的 entries 无这些字段。
    totalUnits: Number.isFinite(total) ? total : null,
    usedUnits: Number.isFinite(used) ? used : null,
    remainingUnits: Number.isFinite(remaining) ? remaining : null,
    unitType: String(balance.unit_type || '').trim().toLowerCase(),
    resetIn: resetAtMs ? formatResetInFromMs(resetAtMs, capturedAt) : '',
    resetAtMs
  };
}

function parseZcodeBalancePayload(payload, capturedAt) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
  const balances = data && Array.isArray(data.balances) ? data.balances : null;
  if (!balances) return null;
  const entries = [];
  for (const balance of balances) {
    const entry = toUsageEntry(balance, capturedAt);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return null;
  const snapshot = {
    kind: USAGE_SNAPSHOT_KINDS.zcode,
    capturedAt: capturedAt || Date.now(),
    source: USAGE_SOURCE_ZCODE,
    entries
  };
  // data.plans[0].name 是套餐名（同 kimi 的 membership.level），
  // WebUI/CLI 的 plan badge 直接消费 account.planType。
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const planName = String(plans[0] && plans[0].name || '').trim();
  if (planName) snapshot.account = { planType: planName };
  return snapshot;
}

function createZcodeQuotaProbe(options = {}) {
  const {
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    fetchWithTimeout,
    proxyUrl,
    noProxy,
    usageSnapshotSchemaVersion,
    now = () => Date.now()
  } = options;
  const proxyOptions = {
    proxyUrl: String(proxyUrl || '').trim(),
    noProxy: String(noProxy || '').trim()
  };

  // 返回 { snapshot } 或 { error, auth }；不抛异常，由调用方决定缓存回退策略。
  async function probe(accountRef, probeTimeoutMs) {
    const timeoutMs = Math.max(1_000, Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
    const record = typeof readAccountCredentialRecord === 'function'
      ? readAccountCredentialRecord(fs, aiHomeDir, accountRef)
      : null;
    if (!record || record.provider !== 'zcode') return { error: 'credential_record_missing' };
    if (String(record.env && record.env.ZCODE_API_KEY || '').trim()) {
      // API Key 模式没有计划额度概念，Remaining 对这类账号不适用。
      return { error: 'api_key_mode_not_applicable' };
    }
    // OAuth 计划账号没有 refresh token；zcodeJwtToken 是长期凭据，
    // 过期只能重新 login 导入，不做续期尝试。
    const oauth = readZcodeOAuthCredential(record.nativeAuth || {});
    const jwtToken = String(oauth && oauth.jwtToken || '').trim();
    if (!jwtToken) return { error: 'missing_oauth_credentials', auth: true };

    try {
      const res = await fetchWithTimeout(ZCODE_PLAN_BALANCE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          Accept: 'application/json'
        }
      }, timeoutMs, proxyOptions);
      if (!res.ok) {
        return { error: `zcode_balance_http_${res.status}`, auth: res.status === 401 || res.status === 403 };
      }
      const payload = await res.json().catch(() => null);
      // zcode 业务错误是 HTTP 200 + { code!=0, success:false }。
      if (!payload || typeof payload !== 'object') return { error: 'zcode_balance_business_error' };
      if (payload.success === false) return { error: 'zcode_balance_business_error' };
      if (
        payload.code !== undefined
        && payload.code !== 0 && payload.code !== 200
        && payload.code !== '0' && payload.code !== '200'
      ) {
        return { error: 'zcode_balance_business_error' };
      }
      const snapshot = parseZcodeBalancePayload(payload, now());
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
  createZcodeQuotaProbe,
  ZCODE_PLAN_BALANCE_URL,
  __private: {
    formatWindowLabel,
    formatResetInFromMs,
    resolveBalanceBucket,
    parseZcodeBalancePayload
  }
};
