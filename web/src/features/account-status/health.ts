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

export interface UptimeSummary {
  /** 0-100，两位小数；无数据时为 null（不要渲染成 0% 或 100%） */
  rate: number | null;
  tier: HealthTier;
  totalRequests: number;
  hasData: boolean;
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
