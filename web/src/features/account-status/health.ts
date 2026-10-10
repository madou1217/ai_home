// 账号健康状态 —— 纯函数计算层（无 React / 无网络请求，方便单测）。
// 档位规则、去重聚合规则见 web/src/features/account-status/types.ts 与调用方 AGENTS 任务描述。

import { NEUTRAL_FAILURE_KIND } from './types';
import type { AccountOutcomes, HealthTier, OutcomeBucket } from './types';

export interface BucketCounts {
  success: number;
  failureTotal: number;
  total: number;
}

/** 单个桶的有效计数：request_cancelled 中立，既不计分子也不计分母。 */
export function countBucket(bucket?: OutcomeBucket | null): BucketCounts {
  if (!bucket) return { success: 0, failureTotal: 0, total: 0 };
  const success = Number(bucket.success) || 0;
  let failureTotal = 0;
  for (const [kind, count] of Object.entries(bucket.failures || {})) {
    if (kind === NEUTRAL_FAILURE_KIND) continue;
    failureTotal += Number(count) || 0;
  }
  return { success, failureTotal, total: success + failureTotal };
}

/** 按成功率算档位；total<=0（无可计数请求）恒为 'none'。 */
export function tierForRate(success: number, total: number): HealthTier {
  if (!(total > 0)) return 'none';
  const rate = success / total;
  if (rate >= 0.99) return 'operational';
  if (rate >= 0.90) return 'degraded';
  if (rate >= 0.50) return 'partial';
  return 'major';
}

export function tierForBucket(bucket?: OutcomeBucket | null): HealthTier {
  const { success, total } = countBucket(bucket);
  return tierForRate(success, total);
}

/**
 * 健康色阶的色标（成功率降序）。颜色来自主题 token（design-tokens.css 的 --health-scale-*，
 * 深浅两套）；色标集中在 90%~100%，因为绝大多数时间桶落在这一段。
 */
export const HEALTH_SCALE_STOPS: ReadonlyArray<{ rate: number; token: string }> = [
  { rate: 1, token: '--health-scale-100' },
  { rate: 0.97, token: '--health-scale-97' },
  { rate: 0.95, token: '--health-scale-95' },
  { rate: 0.9, token: '--health-scale-90' },
  { rate: 0.75, token: '--health-scale-75' },
  { rate: 0.5, token: '--health-scale-50' },
  { rate: 0, token: '--health-scale-0' }
];

/** 成功率（0~1）→ CSS 颜色：在相邻色标间用 color-mix 连续插值，绿 → 黄 → 橙 → 红。 */
export function healthColorForRate(rate: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(rate) ? rate : 0));
  for (let index = 0; index < HEALTH_SCALE_STOPS.length - 1; index += 1) {
    const upper = HEALTH_SCALE_STOPS[index];
    const lower = HEALTH_SCALE_STOPS[index + 1];
    if (clamped < lower.rate) continue;
    const upperWeight = Math.round(((clamped - lower.rate) / (upper.rate - lower.rate)) * 100);
    if (upperWeight >= 100) return `var(${upper.token})`;
    if (upperWeight <= 0) return `var(${lower.token})`;
    return `color-mix(in oklab, var(${upper.token}) ${upperWeight}%, var(${lower.token}))`;
  }
  return `var(${HEALTH_SCALE_STOPS[HEALTH_SCALE_STOPS.length - 1].token})`;
}

/** 桶颜色；无（可计数）请求时返回 undefined，由调用方渲染「无数据」底色。 */
export function healthColorForBucket(bucket?: OutcomeBucket | null): string | undefined {
  const { success, total } = countBucket(bucket);
  return total > 0 ? healthColorForRate(success / total) : undefined;
}

export interface UptimeSummary {
  /** 0-100，两位小数；无数据时为 null（不要渲染成 0% 或 100%） */
  rate: number | null;
  tier: HealthTier;
  totalRequests: number;
  hasData: boolean;
}

/** 可用率摘要的着色；无数据时返回 undefined（沿用中性文字色）。 */
export function healthColorForUptime(summary: UptimeSummary): string | undefined {
  return summary.hasData && summary.rate !== null ? healthColorForRate(summary.rate / 100) : undefined;
}

/** 一段范围内的可用率 = Σsuccess / Σtotal（跨非空桶），两位小数。 */
export function summarizeUptime(buckets: Array<OutcomeBucket | null | undefined>): UptimeSummary {
  let success = 0;
  let total = 0;
  for (const bucket of buckets) {
    const counted = countBucket(bucket);
    success += counted.success;
    total += counted.total;
  }
  if (!(total > 0)) {
    return { rate: null, tier: 'none', totalRequests: 0, hasData: false };
  }
  return {
    rate: Math.round((success / total) * 10000) / 100,
    tier: tierForRate(success, total),
    totalRequests: total,
    hasData: true
  };
}

/** 稀疏桶数组 → Map<startMs, bucket>，便于按对齐后的时间轴查找。 */
export function indexBucketsByStart(buckets: OutcomeBucket[] | undefined | null): Map<number, OutcomeBucket> {
  const map = new Map<number, OutcomeBucket>();
  for (const bucket of buckets || []) {
    if (bucket && Number.isFinite(bucket.startMs)) map.set(bucket.startMs, bucket);
  }
  return map;
}

/** 把稀疏桶对齐到完整时间轴（dayStarts / hourStarts），缺失的桶补 null（= 无数据）。 */
export function alignBuckets(
  starts: number[],
  sparse: OutcomeBucket[] | undefined | null
): Array<OutcomeBucket | null> {
  const indexed = indexBucketsByStart(sparse);
  return starts.map((startMs) => indexed.get(startMs) || null);
}

/**
 * 全局聚合去重：同一身份账号在 Node 侧可能因历史迁移（换 provider / 重新授权）
 * 拆成多条账号记录，但它们共享同一个 Go 账号 ref，因此 Go 返回的 days/hours 计数
 * 完全相同。全局视图直接把所有账号求和会把这些"合并账号"的请求数重复计入，
 * 人为拉高分母（也拉低/拉高整体可用率），所以这里先按 days+hours 的内容去重
 * （JSON 深度相等即视为同一份底层计数），只保留每个去重键的第一条。
 */
export function dedupeAccountsForGlobal(accounts: AccountOutcomes[]): AccountOutcomes[] {
  const seen = new Set<string>();
  const result: AccountOutcomes[] = [];
  for (const account of accounts) {
    const key = JSON.stringify([account.days, account.hours]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(account);
  }
  return result;
}

function mergeIndexedBucket(
  target: Map<number, { startMs: number; success: number; failures: Record<string, number> }>,
  startMs: number,
  bucket: OutcomeBucket
): void {
  let merged = target.get(startMs);
  if (!merged) {
    merged = { startMs, success: 0, failures: {} };
    target.set(startMs, merged);
  }
  merged.success += Number(bucket.success) || 0;
  for (const [kind, count] of Object.entries(bucket.failures || {})) {
    merged.failures[kind] = (merged.failures[kind] || 0) + (Number(count) || 0);
  }
}

/**
 * 全局桶 = 去重后所有账号，在给定时间轴（dayStarts / hourStarts）上逐桶求和。
 * 某个 startMs 所有账号都没数据时，返回 success:0 / failures:{} 的空桶（= 无数据，
 * 与单账号语义一致，由 tierForBucket 判 'none'）。
 */
export function buildGlobalBuckets(
  accounts: AccountOutcomes[],
  starts: number[],
  field: 'days' | 'hours'
): OutcomeBucket[] {
  const deduped = dedupeAccountsForGlobal(accounts);
  const perAccountIndex = deduped.map((account) => indexBucketsByStart(account[field]));
  const merged = new Map<number, { startMs: number; success: number; failures: Record<string, number> }>();
  for (const startMs of starts) {
    merged.set(startMs, { startMs, success: 0, failures: {} });
  }
  for (const index of perAccountIndex) {
    for (const startMs of starts) {
      const bucket = index.get(startMs);
      if (bucket) mergeIndexedBucket(merged, startMs, bucket);
    }
  }
  return starts.map((startMs) => merged.get(startMs) as OutcomeBucket);
}
