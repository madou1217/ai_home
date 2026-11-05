'use strict';

// 把 Node 采集到的 Provider 快照归一成 Go 的额度事实（window 条目）。
//
// 为什么要归一：Go 的 `account_usage` 是路由事实（窗口/剩余/可用性），Node 的快照是
// Provider 专属展示文档。两者都从同一份采集结果派生，但 Go 只认识归一后的形状。
// 本模块是**唯一**的映射点：条目选择与 remainingPct 语义直接复用额度视图模型
// （lib/usage/quota/view.js），不为 Provider 写分支。
//
// 口径：
//   * 只用 primary scope；gift/detail 是旁路信息，用尽不许把账号判成耗尽；
//   * 模型级额度映射为 model_family，不产生账号级阻塞；
//   * 快照没有任何可渲染条目时写入一条 unknown 条目，显式清掉 Go 里的旧额度，
//     而不是让旧值继续影响路由。

const { buildQuotaView } = require('../../usage/quota');
const { getQuotaResetStrategy } = require('../quota-reset/strategy-registry');

const MAX_ENTRIES = 64;
const IDENTIFIER = /^[a-z0-9_.:-]{1,128}$/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeIdentifier(value, fallback = '') {
  const normalized = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 128);
  return IDENTIFIER.test(normalized) ? normalized : fallback;
}

function clampPct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function availabilityFor(pct) {
  if (pct === null) return 'unknown';
  return pct <= 0 ? 'exhausted' : 'available';
}

function uniqueBucket(bucket, used) {
  let candidate = bucket;
  for (let suffix = 2; used.has(candidate); suffix += 1) {
    candidate = `${bucket.slice(0, 120)}_${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

// Go 的 plan_type 列要求 ≤64 字节且无控制字符；这里超限一律当未知，
// 不截断（截断后的 token 可能和另一个套餐撞名），也不让一次坏套餐名毁掉整次同步。
function safePlanType(value) {
  const plan = text(value);
  if (plan.length > 64) return '';
  return /[\u0000-\u001F\u007F]/.test(plan) ? '' : plan;
}

function buildEntry(scope, index, used) {
  const pct = clampPct(scope && scope.remainingPct);
  const model = text(scope && scope.model);
  const modelScoped = scope && scope.shape === 'models' && model !== '';
  const baseBucket = sanitizeIdentifier(scope && scope.bucket, '')
    || (modelScoped ? sanitizeIdentifier(model, '') : '')
    || sanitizeIdentifier(scope && scope.id, '')
    || `scope_${index}`;
  const windowMinutes = Number(scope && scope.windowMinutes);
  const resetAtMs = Number(scope && scope.resetAtMs);
  return {
    limit_id: '',
    limit_name: text(scope && scope.label).slice(0, 256),
    bucket: uniqueBucket(baseBucket, used),
    kind: 'window',
    scope: modelScoped ? 'model_family' : 'account',
    scope_key: modelScoped ? sanitizeIdentifier(model, `model_${index}`) : '',
    has_remaining: pct !== null,
    remaining_basis_points: pct === null ? 0 : Math.round(pct * 100),
    window_seconds: Number.isFinite(windowMinutes) && windowMinutes > 0 ? Math.round(windowMinutes * 60) : 0,
    reset_at: Number.isFinite(resetAtMs) && resetAtMs > 0 ? String(Math.floor(resetAtMs)) : '',
    availability: availabilityFor(pct)
  };
}

/**
 * 返回 Go `PUT /accounts/{ref}/usage` 的请求体；无法形成快照时返回 null。
 *
 * 快照时间/来源非法时返回 null（Go 的合同要求两者都存在）。
 *
 * `options.provider` 用来按该 Provider 的配额策略归一套餐：Go 侧只做校验不猜值，
 * 所以这里必须给出与窗口采样同口径的 token（"Pro Plus" → "pro plus"）。
 * 未知套餐与「不是套餐的鉴权模式」都落空串。
 */
function buildUsageFacts(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const capturedAt = Number(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return null;
  const source = sanitizeIdentifier(snapshot.source, '');
  if (!source) return null;
  const provider = sanitizeIdentifier(options.provider, '');
  const rawPlan = text(snapshot.account && snapshot.account.planType);
  const planType = provider && rawPlan
    ? safePlanType(getQuotaResetStrategy(provider).normalizePlanType(rawPlan))
    : '';

  let view = null;
  try {
    view = buildQuotaView(snapshot);
  } catch (_error) {
    view = null;
  }
  const scopes = view && Array.isArray(view.primaryScopes) ? view.primaryScopes : [];
  const used = new Set();
  const entries = [];
  for (const scope of scopes) {
    if (entries.length >= MAX_ENTRIES) break;
    const entry = buildEntry(scope, entries.length, used);
    if (entry.limit_name === '' && !entry.has_remaining) continue;
    entries.push(entry);
  }
  if (entries.length === 0) {
    // 采集成功但没有可渲染额度：写入 unknown 条目，覆盖 Go 里的旧事实。
    entries.push({
      limit_id: '',
      limit_name: '',
      bucket: uniqueBucket('usage_unknown', used),
      kind: 'window',
      scope: 'account',
      scope_key: '',
      has_remaining: false,
      remaining_basis_points: 0,
      window_seconds: 0,
      reset_at: '',
      availability: 'unknown'
    });
  }
  return {
    source,
    plan_type: planType,
    captured_at: String(Math.floor(capturedAt)),
    // 采集方已完成凭据代次门禁：Go 不再要求能解析该账号的当前凭据。
    collected: true,
    entries
  };
}

module.exports = {
  buildUsageFacts,
  sanitizeIdentifier
};
