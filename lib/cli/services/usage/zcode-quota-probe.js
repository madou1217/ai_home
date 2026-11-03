'use strict';

// zcode 配额探测：Remaining 抽象（lib/account/usage-remaining.js）的 zcode 实现。
// 端点与 ZCode 桌面端一致（http-utils.js 的模型探测走同一接口）：
//   GET ZCODE_PLAN_BALANCE_URL  Authorization: Bearer <zcodeJwtToken>
// 响应 { code, success, data:{ plans:[{name,...}], balances:[{
//   show_name, capabilities:["model:glm-5.3"], unit_type:"token", total_units,
//   used_units, remaining_units, available_units, period, period_start, period_end }] } }
// （period_start/period_end 为 Unix 秒）；业务错误是 HTTP 200 + { code!=0, success:false }。
// 产出的快照复用时间窗型 entries[] 形状（同 codex/claude/kimi），展示层无需为 zcode 单开分支。
// 套餐到期/未订阅时接口返回 { plans:[], balances:[] }：这是「无套餐」**结论**而不是解析
// 失败——探针返回 notApplicable + 空结论快照，由调用方覆盖缓存里已失效的正数快照，
// 否则界面会一直展示最后一次数值（100% 剩余 + 早已过期的重置时间）。

const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_ZCODE } = require('../../../account/usage-remaining');
const { ZCODE_PLAN_BALANCE_URL } = require('../../../account/provider-api-base-url');
const {
  readZcodeLiveOAuthCredential
} = require('../../../account/zcode-credential');
const {
  resolveAccountEgressRequestOptions: resolveAccountEgressRequestOptionsDefault
} = require('../../../server/account-egress-request-options');
const {
  compareAndSwapAccountNativeAuth: defaultCompareAndSwapAccountNativeAuth
} = require('../../../server/account-credential-store');
const {
  isZcodeBalanceEnvelopeOk,
  describeZcodeBalanceEnvelope,
  isZcodeBalanceParameterErrorCode
} = require('../../../server/zcode-business-error');
const {
  appendZcodeAppVersion,
  buildZcodeClientRequestMetadata
} = require('../../../account/zcode-client-metadata');
const { resolveAccountRuntimeDir } = require('../../../runtime/aih-storage-layout');

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

function toUsageEntry(balance, capturedAt, plan = null) {
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
    resetAtMs,
    // 套餐归属：zcode 的「领臭鸡蛋」是**叠加**一个新套餐，同一账号可能
    // 同时有多个套餐（各有独立额度池）。把归属带出去，展示层就能按套餐分组。
    planId: String(balance.plan_id || (plan && plan.plan_id) || '').trim(),
    planGroupId: String(balance.user_plan_id || (plan && plan.user_plan_id) || '').trim(),
    planName: String((plan && plan.name) || '').trim(),
    planStatus: String((plan && plan.status) || '').trim(),
    planEndsAt: Number.isFinite(Number(plan && plan.ends_at)) ? Number(plan.ends_at) * 1000 : 0
  };
}

function parseZcodeBalancePayload(payload, capturedAt) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
  const balances = data && Array.isArray(data.balances) ? data.balances : null;
  if (!balances) return null;
  // 套餐身份表：balances 通过 user_plan_id/plan_id 关联到 plans。
  // 「领臭鸡蛋」= 叠加一个新套餐，所以这里天然可能有多条。
  const plansList = Array.isArray(data.plans) ? data.plans : [];
  const planByUserId = new Map();
  const planById = new Map();
  for (const plan of plansList) {
    const userId = String(plan && plan.user_plan_id || '').trim();
    const planId = String(plan && plan.plan_id || '').trim();
    if (userId) planByUserId.set(userId, plan);
    if (planId) planById.set(planId, plan);
  }
  const entries = [];
  for (const balance of balances) {
    const userId = String(balance && balance.user_plan_id || '').trim();
    const planId = String(balance && balance.plan_id || '').trim();
    const entry = toUsageEntry(balance, capturedAt, planByUserId.get(userId) || planById.get(planId) || null);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return null;
  const snapshot = {
    kind: USAGE_SNAPSHOT_KINDS.zcode,
    capturedAt: capturedAt || Date.now(),
    source: USAGE_SOURCE_ZCODE,
    entries
  };
  // 套餐分组：同账号多个套餐（例如基础套餐 + 领到的试用套餐）各自成组。
  const groups = buildZcodePlanGroups(plansList, entries);
  if (groups.length > 0) snapshot.planGroups = groups;
  // 套餐名**逐个给出**（planNames 数组），不再拼成 `A + B` 一串：
  // 拼接串宽度随套餐增减而变，在窄列里还会被截断（真机：「ZCODE GLOBAL BUILD +
  // ZCode Start Plan」显示成半截），用户明确要求拆开。
  //
  // planType 仍保留（= 首个套餐名），因为历史消费方（badge 颜色、状态合并、
  // CLI 文案）按单值字符串读它；**新增展示一律用 planNames**。
  const planNames = groups.length > 0
    ? groups.map((g) => g.name).filter(Boolean)
    : [String(plansList[0] && plansList[0].name || '').trim()].filter(Boolean);
  const planName = planNames[0] || '';
  // planIds 是**可判定的事实**（推理端点按 plan_id 分叉，见 provider-api-base-url.js 的
  // resolveZcodeInferenceBaseUrl）；planType 只是展示名，判不出套餐类型。
  // 多套餐叠加时（「领臭鸡蛋」）全部列出，由消费方挑 start-plan。
  const planIds = plansList
    .map((plan) => String(plan && plan.plan_id || '').trim())
    .filter(Boolean);
  if (planName || planNames.length > 0 || planIds.length > 0) {
    snapshot.account = {
      ...(planName ? { planType: planName } : {}),
      // 多套餐的**结构化列表**：展示层逐个渲染标签，不再解析拼接串。
      ...(planNames.length > 0 ? { planNames } : {}),
      ...(planIds.length > 0 ? { planIds } : {})
    };
  }
  return snapshot;
}

// 套餐的生效时间：entitlements[].effective_at（Unix 秒）里最早的一个。
// 「刚领到、还没到生效时间」的套餐 balances 是空的，界面只能靠这个时间说明
// 「为什么现在看不到额度」。
function readPlanEffectiveAtMs(plan) {
  const entitlements = Array.isArray(plan && plan.entitlements) ? plan.entitlements : [];
  let earliest = 0;
  for (const entitlement of entitlements) {
    const atMs = Number(entitlement && entitlement.effective_at) * 1000;
    if (!Number.isFinite(atMs) || atMs <= 0) continue;
    if (earliest === 0 || atMs < earliest) earliest = atMs;
  }
  return earliest;
}

// 把 plans + entries 归组成
// [{ planGroupId, planId, name, status, endsAtMs, effectiveAtMs, priority, entries }]。
// 无 plan 归属的余额单独成一组，不丢弃。
// keepEmpty：保留「有计划但还没有余额桶」的组（套餐已领取、生效时间未到），
// 默认丢弃（正常路径上 0 条目的组没有可展示的额度）。
function buildZcodePlanGroups(plans, entries, options = {}) {
  const keepEmpty = options.keepEmpty === true;
  const byGroup = new Map();
  const ensure = (key, seed) => {
    if (!byGroup.has(key)) {
      byGroup.set(key, {
        planGroupId: key, planId: '', name: '', status: '',
        endsAtMs: 0, effectiveAtMs: 0, priority: 0, entries: [], ...seed
      });
    }
    return byGroup.get(key);
  };
  for (const plan of plans) {
    const userId = String(plan && plan.user_plan_id || '').trim();
    const planId = String(plan && plan.plan_id || '').trim();
    const key = userId || planId;
    if (!key) continue;
    ensure(key, {
      planId,
      name: String(plan && plan.name || '').trim() || planId,
      status: String(plan && plan.status || '').trim(),
      endsAtMs: Number.isFinite(Number(plan && plan.ends_at)) ? Number(plan.ends_at) * 1000 : 0,
      effectiveAtMs: readPlanEffectiveAtMs(plan),
      priority: Number.isFinite(Number(plan && plan.priority)) ? Number(plan.priority) : 0
    });
  }
  for (const entry of entries) {
    const key = entry.planGroupId || entry.planId || 'unassigned';
    ensure(key, {
      planId: entry.planId || '', name: entry.planName || '',
      status: entry.planStatus || '', endsAtMs: entry.planEndsAt || 0
    }).entries.push(entry);
  }
  return [...byGroup.values()]
    .filter((group) => keepEmpty || group.entries.length > 0)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

// 上游明确回答「没有套餐、也没有任何余额桶」时的**结论**判定：plans 与 balances 都必须
// 是显式空数组。例如 zcode Weekend 促销到期后，balance 接口返回
// { code:0, data:{ plans:[], balances:[] } }——这不是解析失败，不能按失败处理。
function isNoPlanBalancePayload(payload) {
  const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : null;
  if (!data) return false;
  if (!Array.isArray(data.plans) || !Array.isArray(data.balances)) return false;
  return data.plans.length === 0 && data.balances.length === 0;
}

// 上游回答「有计划、但一个余额桶都没有」时的**结论**快照（plans 非空、balances 显式空）。
// 真机（2026-10-27 / 2026-10-30）：刚「领臭鸡蛋」拿到的活动套餐（`zcode-v3-start-plan-*`）
// 在 `entitlements[].effective_at` 之前就是这个形状 —— plans 里已经有套餐与授予量，
// balances 还是空的。
// 这不是探测失败：把它按失败处理会让界面显示「采集失败」，而事实是
// 「套餐已领取、额度还没生效」。
//
// **旧实现只回了一份 entries:[] 的空快照**，套餐名 / 生效时间全部丢失 ——
// 界面上一片「额度不适用」，用户看不到自己已经领到的那只臭鸡蛋。现在把 plans
// 结构化带出来（planGroups + account.planNames/planIds），生效时间逐组给出，
// 展示层据此渲染「套餐名 · 未生效 · 23:00 生效」。
function buildPendingPlanSnapshot(payload, capturedAt) {
  const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : null;
  if (!data) return null;
  if (!Array.isArray(data.plans) || !Array.isArray(data.balances)) return null;
  if (data.plans.length === 0 || data.balances.length > 0) return null;
  const groups = buildZcodePlanGroups(data.plans, [], { keepEmpty: true });
  if (groups.length === 0) return null;
  let earliest = 0;
  for (const group of groups) {
    const atMs = Number(group && group.effectiveAtMs) || 0;
    if (atMs <= 0) continue;
    if (earliest === 0 || atMs < earliest) earliest = atMs;
  }
  const planNames = groups.map((group) => group.name).filter(Boolean);
  const planIds = groups.map((group) => group.planId).filter(Boolean);
  const snapshot = {
    kind: USAGE_SNAPSHOT_KINDS.zcode,
    capturedAt: capturedAt || Date.now(),
    source: USAGE_SOURCE_ZCODE,
    entries: [],
    planGroups: groups,
    // 最早生效时间（0 = 上游没给）。展示层直接读它，不必再遍历 entitlements。
    pendingEffectiveAtMs: earliest,
    ...(planNames.length > 0 || planIds.length > 0
      ? {
          account: {
            ...(planNames.length > 0 ? { planType: planNames[0], planNames } : {}),
            ...(planIds.length > 0 ? { planIds } : {})
          }
        }
      : {})
  };
  return { snapshot, effectiveAtMs: earliest };
}

function createZcodeQuotaProbe(options = {}) {
  const {
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    compareAndSwapAccountNativeAuth = defaultCompareAndSwapAccountNativeAuth,
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
    // 优先使用桌面端运行期在沙箱 profile 里刷新过的活凭据（DB 快照可能已过期）；
    // readZcodeLiveOAuthCredential 保证返回 { oauth, source, ... }，
    // 活文件缺失/损坏时其 oauth 已静默回退为 DB 快照解析结果。
    const resolved = readZcodeLiveOAuthCredential(fs, aiHomeDir, accountRef, record);
    const oauth = resolved.oauth;
    const jwtToken = String(oauth && oauth.jwtToken || '').trim();
    if (!jwtToken) return { error: 'missing_oauth_credentials', auth: true };

    const resolveRequestOptions = typeof resolveAccountEgressRequestOptions === 'function'
      ? resolveAccountEgressRequestOptions
      : resolveAccountEgressRequestOptionsDefault;
    let accountRequestOptions;
    try {
      accountRequestOptions = await resolveRequestOptions({
        fs,
        aiHomeDir,
        processObj,
        provider: 'zcode',
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

    try {
      const metadata = buildZcodeClientRequestMetadata(fs, {
        processObj,
        aiHomeDir,
        accountRef,
        home: processObj && processObj.env && processObj.env.HOME,
        hostHomeDir: options.hostHomeDir,
        resolveAccountRuntimeDir,
        appVersion: options.appVersion
      });
      const headers = {
        ...metadata.headers,
        Authorization: `Bearer ${jwtToken}`,
        Accept: 'application/json'
      };
      const res = await fetchWithTimeout(appendZcodeAppVersion(ZCODE_PLAN_BALANCE_URL, metadata.appVersion), {
        method: 'GET',
        headers
      }, timeoutMs, accountRequestOptions.options);
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = describeZcodeBalanceEnvelope(payload);
        return {
          error: `zcode_balance_http_${res.status}${detail && Number(payload && payload.code) !== 0 ? `:${detail}` : ''}`,
          auth: res.status === 401 || res.status === 403
        };
      }
      // zcode 业务错误是 HTTP 200 + { code!=0, success:false }；判错规则统一在
      // zcode-business-error 的「两域判错规则」里，balance 域走信封成功码集合。
      if (!payload || typeof payload !== 'object') return { error: 'zcode_balance_business_error' };
      if (!isZcodeBalanceEnvelopeOk(payload)) {
        const detail = describeZcodeBalanceEnvelope(payload);
        return {
          error: isZcodeBalanceParameterErrorCode(payload.code)
            ? `zcode_balance_parameter_error:${detail || '3001 parameter error'}`
            : 'zcode_balance_business_error'
        };
      }
      const capturedAt = now();
      if (isNoPlanBalancePayload(payload)) {
        // 「无套餐」是来源给出的结论：以 notApplicable 落地（deriveQuotaState → not_applicable
        // 而不是 probe_failed），并携带空结论快照让调用方替换缓存里已失效的正数快照。
        const conclusion = {
          kind: USAGE_SNAPSHOT_KINDS.zcode,
          capturedAt,
          source: USAGE_SOURCE_ZCODE,
          entries: []
        };
        if (usageSnapshotSchemaVersion != null) conclusion.schemaVersion = usageSnapshotSchemaVersion;
        return { notApplicable: true, reason: 'no_plan_balance', snapshot: conclusion };
      }
      const pendingPlan = buildPendingPlanSnapshot(payload, capturedAt);
      if (pendingPlan) {
        // 「套餐已领取、额度还没生效」也是来源给出的**结论**：以 notApplicable 落地
        // （reason 带上生效时间），而不是 probe_failed —— 真机表现就是刚领完臭鸡蛋的
        // 账号在界面上一片「采集失败」，其实只是生效时间还没到。
        // 结论快照必须带套餐结构（planGroups / planNames），否则界面上除了
        // 「额度不适用」什么都看不到。
        const conclusion = pendingPlan.snapshot;
        if (usageSnapshotSchemaVersion != null) conclusion.schemaVersion = usageSnapshotSchemaVersion;
        return {
          notApplicable: true,
          reason: pendingPlan.effectiveAtMs > 0
            ? `plan_not_effective_yet:${pendingPlan.effectiveAtMs}`
            : 'plan_not_effective_yet',
          snapshot: conclusion
        };
      }
      const snapshot = parseZcodeBalancePayload(payload, capturedAt);
      if (!snapshot) return { error: 'empty_parsed_snapshot' };
      if (usageSnapshotSchemaVersion != null) snapshot.schemaVersion = usageSnapshotSchemaVersion;
      // 活凭据探测成功 → 把活文件回写 DB（CAS：仅当 DB 仍等于本次读取的快照时才写，
      // 并发 re-login 导入不会被覆盖），之后其他链路（模型目录探测等）也拿到新鲜凭据。
      if (resolved.source === 'live' && resolved.liveCredentials
        && typeof compareAndSwapAccountNativeAuth === 'function') {
        try {
          const currentNativeAuth = record.nativeAuth && typeof record.nativeAuth === 'object'
            ? record.nativeAuth
            : {};
          compareAndSwapAccountNativeAuth(fs, aiHomeDir, accountRef, record, {
            ...currentNativeAuth,
            credentials: resolved.liveCredentials
          });
        } catch (_syncError) {}
      }
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
    parseZcodeBalancePayload,
    isNoPlanBalancePayload,
    buildPendingPlanSnapshot
  }
};
