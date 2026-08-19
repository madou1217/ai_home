import { useEffect, useRef, useState } from 'react';

import type { Account, AccountTokenUsage } from '@/types';

/**
 * 单次 token 消耗事件：来自账号实时通道（accounts/watch SSE）推送的
 * tokenUsage.day 增量。页面用它驱动「伤害数字」飘字动效。
 */
export interface TokenDropEvent {
  id: string;
  provider: string;
  accountRef: string;
  /** 本周期（day）新增 token 数。 */
  deltaTokens: number;
  /** 本周期新增估算费用（USD）；无数据时为 null。 */
  deltaCostUsd: number | null;
  occurredAt: number;
}

/** 相邻快照 diff 产出的原始增量，不含事件 id / 时间戳（纯函数，可单测）。 */
export interface TokenUsageDelta {
  provider: string;
  accountRef: string;
  deltaTokens: number;
  deltaCostUsd: number | null;
}

/** 飘字动画时长（与 TokenDropNumber.css 保持一致），事件到期后自动清理。 */
export const TOKEN_DROP_LIFETIME_MS = 1600;
/** 同账号同时最多保留的掉落事件数，超出时丢弃最旧的，避免刷屏。 */
const MAX_DROPS_PER_ACCOUNT = 3;
/** 全页面事件队列上限。 */
const MAX_DROPS_TOTAL = 24;

function readDayTokens(usage: AccountTokenUsage | null | undefined): number {
  const value = Number(usage && usage.day);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function readDayCostUsd(usage: AccountTokenUsage | null | undefined): number | null {
  const models = Array.isArray(usage && usage.models) ? usage.models : [];
  let total = 0;
  for (const model of models) {
    const cost = Number(model && model.dayCostUsd);
    if (Number.isFinite(cost) && cost > 0) total += cost;
  }
  return total > 0 ? total : null;
}

export type TokenUsageBaseline = Map<string, { tokens: number; cost: number | null }>;

/**
 * 对相邻账号快照做 tokenUsage.day diff：数值增长即视为一次消耗。
 * 纯函数——输入上一份基线 + 最新账号列表，输出增量事件与下一份基线，
 * 不含任何时间/随机状态，便于单测。
 */
export function diffTokenUsage(
  accounts: Account[],
  previous: TokenUsageBaseline
): { deltas: TokenUsageDelta[]; next: TokenUsageBaseline } {
  const next = new Map<string, { tokens: number; cost: number | null }>();
  const deltas: TokenUsageDelta[] = [];

  for (const account of Array.isArray(accounts) ? accounts : []) {
    const key = String(account.accountRef || '').trim();
    if (!key) continue;
    const tokens = readDayTokens(account.tokenUsage);
    const cost = readDayCostUsd(account.tokenUsage);
    next.set(key, { tokens, cost });

    const before = previous.get(key);
    if (!before || tokens <= before.tokens) continue;
    const deltaTokens = tokens - before.tokens;
    const deltaCost = cost != null && before.cost != null
      ? Math.max(0, cost - before.cost)
      : null;
    if (deltaTokens <= 0) continue;
    deltas.push({
      provider: String(account.provider || ''),
      accountRef: key,
      deltaTokens: Math.max(1, Math.round(deltaTokens)),
      deltaCostUsd: deltaCost
    });
  }

  return { deltas, next };
}

let dropSequence = 0;

function buildDropEvent(delta: TokenUsageDelta): TokenDropEvent {
  dropSequence += 1;
  return {
    id: `drop-${Date.now()}-${dropSequence}`,
    provider: delta.provider,
    accountRef: delta.accountRef,
    deltaTokens: delta.deltaTokens,
    deltaCostUsd: delta.deltaCostUsd,
    occurredAt: Date.now()
  };
}

export function appendTokenDrop(drops: TokenDropEvent[], next: TokenDropEvent): TokenDropEvent[] {
  const perAccount = drops.filter((drop) => drop.accountRef === next.accountRef);
  const overflow = perAccount.length >= MAX_DROPS_PER_ACCOUNT;
  const retainedIds = overflow
    ? new Set(perAccount.slice(-(MAX_DROPS_PER_ACCOUNT - 1)).map((drop) => drop.id))
    : null;
  const nextDrops = retainedIds
    ? [...drops.filter((drop) => drop.accountRef !== next.accountRef || retainedIds.has(drop.id)), next]
    : [...drops, next];
  return nextDrops.length > MAX_DROPS_TOTAL
    ? nextDrops.slice(-MAX_DROPS_TOTAL)
    : nextDrops;
}

/**
 * 订阅账号列表变化，对相邻快照的 tokenUsage.day 做 diff：
 * day 数值增长即视为一次「被打了一下的消耗」，产出掉落事件。
 * 事件有生命周期，动画播完自动从队列移除。
 */
export function useTokenDropEvents(accounts: Account[]): TokenDropEvent[] {
  const [drops, setDrops] = useState<TokenDropEvent[]>([]);
  const previousRef = useRef<TokenUsageBaseline>(new Map());

  useEffect(() => {
    const { deltas, next } = diffTokenUsage(accounts, previousRef.current);
    previousRef.current = next;
    if (deltas.length > 0) {
      const pending = deltas.map((delta) => buildDropEvent(delta));
      setDrops((current) => pending.reduce((queue, drop) => appendTokenDrop(queue, drop), current));
    }
  }, [accounts]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setDrops((current) => {
        const alive = current.filter((drop) => now - drop.occurredAt < TOKEN_DROP_LIFETIME_MS);
        return alive.length === current.length ? current : alive;
      });
    }, 500);
    return () => clearInterval(timer);
  }, []);

  return drops;
}
