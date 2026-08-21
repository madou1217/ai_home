import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type { AccountTokenUsage } from '@/types';
import QuotaPlant from './garden/QuotaPlant';
import UpstreamQuotaAttackLayer from './UpstreamQuotaAttackLayer';
import type { TokenDropEvent } from './useTokenDropEvents';
import {
  GARDEN_EMERGE_MS,
  GARDEN_RETREAT_MS,
  getGardenLifecycleDelayMs,
  reconcileGardenLifecycle
} from './garden/lifecycle-model';
import type { GardenLifecycleState } from './garden/lifecycle-model';
import { buildGardenPerches } from './garden/perch-model';
import {
  GARDEN_HOP_FLIGHT_MS,
  createHopState,
  getHopDelayMs,
  reconcileHopState
} from './garden/hop-model';
import {
  getActiveCatch,
  getPendingCatches,
  pruneGardenFeedJobs,
  scheduleGardenFeeds
} from './garden/feeding-model';
import type { GardenFeedJob } from './garden/feeding-model';
import { buildPlantProfile } from './garden/plant-profile';
import './garden/head.css';
import './garden/plant.css';
import './garden/attack.css';

interface Props {
  accountRef: string;
  usage: AccountTokenUsage;
  active: boolean;
  drops: TokenDropEvent[];
  onStageActiveChange?: (active: boolean) => void;
}

/** 下一个需要醒来的时刻；没有就让整格彻底静止，一个定时器都不留。 */
function getNextWakeDelayMs(delays: Array<number | null>) {
  const pending = delays.filter((delay): delay is number => delay !== null && delay >= 0);
  return pending.length === 0 ? null : Math.min(...pending);
}

/**
 * 一个账号一株花：在真实 Token 柱之间跳来跳去，路过的消耗顺手吃掉。
 *
 * 这里只做编排——生命周期、落脚点、捕食三个状态机都是纯函数（garden/ 下），
 * 时间推进靠事件点唤醒而不是高频轮询：花空闲时整格不跑任何 JS 定时器。
 */
const UpstreamQuotaGarden = ({
  accountRef,
  usage,
  active,
  drops,
  onStageActiveChange
}: Props) => {
  const layout = useMemo(() => buildGardenPerches(usage), [usage]);
  const profile = useMemo(() => buildPlantProfile(accountRef), [accountRef]);
  const [clock, setClock] = useState(() => Date.now());
  const [jobs, setJobs] = useState<GardenFeedJob[]>([]);
  const [lifecycle, setLifecycle] = useState<GardenLifecycleState>(() => ({
    phase: 'hidden',
    startedAt: Date.now()
  }));
  const [hop, setHop] = useState(() => createHopState(accountRef, layout.perches, Date.now()));
  const gardenRef = useRef<HTMLSpanElement>(null);
  const seenDropIdsRef = useRef<Set<string>>(new Set());

  const activeCatch = getActiveCatch(jobs, clock);
  const pendingCatches = getPendingCatches(jobs, clock);
  // 嘴里有东西、或者已经排上号了都不能跳——花不能咬着东西飞走。
  const canHop = lifecycle.phase === 'visible' && pendingCatches.length === 0;

  useEffect(() => {
    const now = Date.now();
    setLifecycle((current) => reconcileGardenLifecycle(current, {
      requestedActive: active,
      hasPendingJobs: jobs.length > 0,
      now
    }));
    setHop((current) => reconcileHopState(current, {
      accountRef,
      perches: layout.perches,
      now,
      canHop
    }));
    setJobs((current) => {
      const next = pruneGardenFeedJobs(current, now);
      return next.length === current.length ? current : next;
    });
  }, [accountRef, active, canHop, clock, jobs, layout.perches]);

  // 唯一的时间驱动：算出下一个真正会发生变化的时刻，睡到那时再说。
  useEffect(() => {
    const now = Date.now();
    const jobDelays = jobs.flatMap((job) => [
      job.attackAt > now ? job.attackAt - now : null,
      job.endsAt > now ? job.endsAt - now : null
    ]);
    const delay = getNextWakeDelayMs([
      getGardenLifecycleDelayMs(lifecycle, now),
      getHopDelayMs(hop, { perchCount: layout.perches.length, now, canHop }),
      ...jobDelays
    ]);
    if (delay === null) return undefined;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(16, delay) + 16);
    return () => window.clearTimeout(timer);
  }, [canHop, clock, hop, jobs, layout.perches.length, lifecycle]);

  useEffect(() => {
    onStageActiveChange?.(lifecycle.phase !== 'hidden');
  }, [lifecycle.phase, onStageActiveChange]);

  useEffect(() => {
    const sourceDrops = Array.isArray(drops) ? drops.filter((drop) => drop?.id) : [];
    const liveIds = new Set(sourceDrops.map((drop) => drop.id));
    seenDropIdsRef.current = new Set(
      Array.from(seenDropIdsRef.current).filter((id) => liveIds.has(id))
    );
    const fresh = sourceDrops.filter((drop) => !seenDropIdsRef.current.has(drop.id));
    fresh.forEach((drop) => seenDropIdsRef.current.add(drop.id));
    if (!active || fresh.length === 0) return;

    const now = Date.now();
    const lifecycleDelay = getGardenLifecycleDelayMs(lifecycle, now);
    const stageDelayMs = lifecycle.phase === 'visible'
      ? 0
      : lifecycle.phase === 'emerging' && lifecycleDelay !== null
        ? lifecycleDelay
        : GARDEN_EMERGE_MS;
    // 半空中不能扑食：攻击层会把藤蔓钉在测量那一刻的位置，而花马上就落到别处去了。
    const landingDelayMs = hop.phase === 'airborne'
      ? Math.max(0, GARDEN_HOP_FLIGHT_MS - (now - hop.startedAt))
      : 0;
    const minimumDelayMs = Math.max(stageDelayMs, landingDelayMs);
    setClock(now);
    setJobs((current) => scheduleGardenFeeds({
      accountRef,
      drops: fresh,
      hasPerch: layout.perches.length > 0,
      jobs: current,
      now,
      minimumDelayMs
    }).jobs);
  }, [accountRef, active, drops, hop, layout.perches.length, lifecycle]);

  const perch = hop.perchIndex >= 0 ? layout.perches[hop.perchIndex] : null;
  const fromPerch = hop.fromPerchIndex >= 0 && hop.fromPerchIndex !== hop.perchIndex
    ? layout.perches[hop.fromPerchIndex] || null
    : null;

  return (
    <span
      ref={gardenRef}
      className={[
        'upstream-quota-garden',
        `upstream-quota-garden--lifecycle-${lifecycle.phase}`
      ].join(' ')}
      data-garden-active={lifecycle.phase === 'hidden' ? 'false' : 'true'}
      data-garden-requested-active={active ? 'true' : 'false'}
      data-garden-lifecycle={lifecycle.phase}
      data-garden-columns={layout.columns}
      data-garden-hop={hop.phase}
      data-garden-jobs={jobs.length}
      style={{
        ['--garden-columns' as string]: layout.columns,
        ['--garden-emerge-duration' as string]: `${GARDEN_EMERGE_MS}ms`,
        ['--garden-retreat-duration' as string]: `${GARDEN_RETREAT_MS}ms`
      } as CSSProperties}
      aria-hidden="true"
    >
      {/* 花园收起时连植株 DOM 都不挂：一屏 20 个空闲账号不该留下 20 组合成层。 */}
      {perch && lifecycle.phase !== 'hidden' ? (
        <QuotaPlant
          profile={profile}
          perch={perch}
          fromPerch={fromPerch}
          hop={hop}
          lifecycle={lifecycle.phase}
          busy={Boolean(activeCatch)}
        />
      ) : null}
      <UpstreamQuotaAttackLayer
        accountRef={accountRef}
        gardenRef={gardenRef}
        jobs={jobs}
        profile={profile}
      />
    </span>
  );
};

export default UpstreamQuotaGarden;
