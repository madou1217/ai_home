import type { TokenDropEvent } from '../useTokenDropEvents';
import { stableGardenRandom, stableGardenRange } from './stable-random';

// 一次捕食的四段。整套周期压到 1.4s：一个账号只有一株花，周期越长越多消耗
// 会因为"花正忙"而被判成没吃到，忙账号看上去就像坏了。
export const GARDEN_HUNT_MS = 520;
export const GARDEN_BITE_MS = 240;
export const GARDEN_CHEW_MS = 380;
export const GARDEN_RECOVER_MS = 260;
export const GARDEN_ATTACK_MS = GARDEN_HUNT_MS
  + GARDEN_BITE_MS
  + GARDEN_CHEW_MS
  + GARDEN_RECOVER_MS;
export const GARDEN_MISS_MS = 1100;
/**
 * 扑出去之前多久把花茎定住。攻击层要在稳定的茎顶坐标上生成藤蔓，
 * 而摇摆每一帧都在动；先定格再测量，藤蔓根部才咬得住茎尖。
 */
export const GARDEN_FREEZE_LEAD_MS = 140;
/** 两口之间咽下去的间隔。一口刚缩回就立刻扑下一口，看着像卡带。 */
export const GARDEN_SWALLOW_GAP_MS = 320;
/** 吃完之后的回神时间：这段时间里既不跳也不吃，动作之间才有呼吸。 */
export const GARDEN_FEED_RECOVER_MS = 420;

// 捕食率不是定值：按账号与事件在区间里取，偶尔漏一口才像活物。
export const GARDEN_CATCH_CHANCE_MIN = 0.62;
export const GARDEN_CATCH_CHANCE_MAX = 0.94;

/**
 * 除了嘴里那一口，还能排队等着的数量。SSE 的 token-consumed 会成串到达，
 * 完全不排队就会连续判 miss；排太多又会让动画拖在真实消耗后面很久。
 */
export const GARDEN_FEED_QUEUE_LIMIT = 1;

export type GardenFeedOutcome = 'caught' | 'missed';
export type GardenFeedReason = 'caught' | 'chance_miss' | 'capacity_miss';

export interface GardenFeedJob {
  id: string;
  drop: TokenDropEvent;
  outcome: GardenFeedOutcome;
  reason: GardenFeedReason;
  createdAt: number;
  /** 真正扑出去的时刻；排队时会晚于 createdAt。 */
  attackAt: number;
  endsAt: number;
}

export type GardenFeedPhase =
  | 'swaying'
  | 'hunting'
  | 'bite'
  | 'chewing'
  | 'recover';

/**
 * 任务结束后再多留一段回神时间才丢掉——留着它，花才知道自己刚吃完，
 * 不会前一口刚咽下去就弹射着去跳。
 */
export function pruneGardenFeedJobs(jobs: GardenFeedJob[], now: number) {
  return jobs.filter((job) => job.endsAt + GARDEN_FEED_RECOVER_MS > now);
}

/** 刚吃完还在回神：这一刻不该起跳，也不该接下一口。 */
export function isRecoveringFromFeed(jobs: GardenFeedJob[], now: number) {
  return jobs.some((job) => (
    job.outcome === 'caught'
    && job.endsAt <= now
    && job.endsAt + GARDEN_FEED_RECOVER_MS > now
  ));
}

/** 当前正在被吃 / 已排队的捕食任务（miss 不占用花）。 */
export function getPendingCatches(jobs: GardenFeedJob[], now: number) {
  return jobs
    .filter((job) => job.outcome === 'caught' && job.endsAt > now)
    .sort((left, right) => left.attackAt - right.attackAt);
}

/** 此刻嘴里那一口；没有就是 undefined。 */
export function getActiveCatch(jobs: GardenFeedJob[], now: number) {
  return getPendingCatches(jobs, now).find((job) => job.attackAt <= now);
}

/** 即将扑出去的那一口——茎要先为它定住。 */
export function getFreezingCatch(jobs: GardenFeedJob[], now: number) {
  return getPendingCatches(jobs, now)
    .find((job) => job.attackAt - GARDEN_FREEZE_LEAD_MS <= now);
}

export function getCatchChance(accountRef: string, dropId: string) {
  return stableGardenRange(
    GARDEN_CATCH_CHANCE_MIN,
    GARDEN_CATCH_CHANCE_MAX,
    accountRef,
    dropId,
    'catch-chance'
  );
}

/**
 * 单花捕食调度：一口一口地吃，最多再排 GARDEN_FEED_QUEUE_LIMIT 个；
 * 排不下或这一口没咬中就立刻落下（伤害数字照样飘，只是没被吃掉）。
 */
export function scheduleGardenFeeds({
  accountRef,
  drops,
  hasPerch,
  jobs = [],
  now,
  minimumDelayMs = 0
}: {
  accountRef: string;
  drops: TokenDropEvent[];
  hasPerch: boolean;
  jobs?: GardenFeedJob[];
  now: number;
  minimumDelayMs?: number;
}): { jobs: GardenFeedJob[]; scheduled: GardenFeedJob[] } {
  const retained = pruneGardenFeedJobs(jobs, now);
  const knownDropIds = new Set(retained.map((job) => job.drop.id));
  const baseDelay = Math.max(0, Math.round(Number(minimumDelayMs) || 0));
  const scheduled: GardenFeedJob[] = [];
  const orderedDrops = [...drops].sort((left, right) => (
    Number(left.occurredAt || 0) - Number(right.occurredAt || 0)
    || String(left.id).localeCompare(String(right.id))
  ));

  let pending = getPendingCatches(retained, now);
  orderedDrops.forEach((drop) => {
    if (!drop?.id || knownDropIds.has(drop.id)) return;
    knownDropIds.add(drop.id);

    const hasRoom = hasPerch && pending.length <= GARDEN_FEED_QUEUE_LIMIT;
    const catches = hasRoom
      && stableGardenRandom(accountRef, drop.id, 'catch') < getCatchChance(accountRef, drop.id);
    const jitterMs = Math.round(stableGardenRandom(accountRef, drop.id, 'delay') * 120);
    const readyAt = now + baseDelay + jitterMs;
    // 排队的那一口要等前一口咽下去，中间还留一段吞咽的间隔。
    const busyUntil = pending.length > 0
      ? pending[pending.length - 1].endsAt + GARDEN_SWALLOW_GAP_MS
      : 0;
    const attackAt = catches ? Math.max(readyAt, busyUntil) : readyAt;
    const outcome: GardenFeedOutcome = catches ? 'caught' : 'missed';
    const reason: GardenFeedReason = catches
      ? 'caught'
      : hasRoom
        ? 'chance_miss'
        : 'capacity_miss';
    const job: GardenFeedJob = {
      id: `garden-${drop.id}`,
      drop,
      outcome,
      reason,
      createdAt: now,
      attackAt,
      endsAt: attackAt + (catches ? GARDEN_ATTACK_MS : GARDEN_MISS_MS)
    };
    scheduled.push(job);
    if (catches) pending = [...pending, job];
  });

  return { jobs: [...retained, ...scheduled], scheduled };
}

/** 捕食动作的四段相位；没有在吃东西时就是摇摆待机。 */
export function getGardenFeedPhase(now: number, job?: GardenFeedJob): GardenFeedPhase {
  if (!job || job.outcome !== 'caught' || job.endsAt <= now || now < job.attackAt) {
    return 'swaying';
  }
  const elapsed = now - job.attackAt;
  if (elapsed < GARDEN_HUNT_MS) return 'hunting';
  if (elapsed < GARDEN_HUNT_MS + GARDEN_BITE_MS) return 'bite';
  if (elapsed < GARDEN_HUNT_MS + GARDEN_BITE_MS + GARDEN_CHEW_MS) return 'chewing';
  return 'recover';
}
