import type { ManagementAccountActivity } from '@/types';
import type { TokenDropEvent } from './useTokenDropEvents';

/**
 * 一个账号此刻算不算"正在消耗"。
 *
 * 两个信号缺一不可：
 * - inFlight 来自 2 秒一次的轮询，只有请求「进行中」才为正；
 * - token 消耗事件是请求结束之后才到的。
 *
 * 只看前者，一个几百毫秒的请求会整个落在两次轮询之间——伤害数字照常飘出来，
 * 进度条却从没烧过，于是燃烧看上去时有时无。只看后者又会漏掉正在跑但还没产出
 * 用量的长请求。两个一起看才连得上。
 */
export function isAccountConsuming(
  activity: ManagementAccountActivity | null | undefined,
  accountDrops: TokenDropEvent[]
): boolean {
  const inFlight = Number(activity?.inFlight) || 0;
  if (inFlight > 0) return true;
  return Array.isArray(accountDrops) && accountDrops.length > 0;
}

/** 把页面级的掉落队列筛成这一个账号的。 */
export function selectAccountDrops(
  drops: TokenDropEvent[] | null | undefined,
  accountRef: string
): TokenDropEvent[] {
  if (!Array.isArray(drops) || !accountRef) return [];
  return drops.filter((drop) => drop?.accountRef === accountRef);
}
