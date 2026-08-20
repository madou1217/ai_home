import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type { AccountTokenUsage } from '@/types';
import QuotaPlantHead from './QuotaPlantHead';
import UpstreamQuotaAttackLayer from './UpstreamQuotaAttackLayer';
import type { TokenDropEvent } from './useTokenDropEvents';
import {
  GARDEN_EMERGE_MS,
  GARDEN_RETREAT_MS,
  buildGardenLayout,
  getGardenLifecycleDelayMs,
  getGardenPlantPhase,
  pruneGardenJobs,
  reconcileGardenLifecycle,
  scheduleGardenDrops
} from './upstream-quota-garden-model';
import type {
  GardenJob,
  GardenLifecyclePhase,
  GardenLifecycleState,
  GardenPlantProfile
} from './upstream-quota-garden-model';
import './UpstreamQuotaGarden.css';

interface Props {
  accountRef: string;
  usage: AccountTokenUsage;
  active: boolean;
  drops: TokenDropEvent[];
  onStageActiveChange?: (active: boolean) => void;
}

function buildPlantStyle(profile: GardenPlantProfile): CSSProperties {
  return {
    ['--plant-x' as string]: `${profile.anchorXPercent}%`,
    ['--plant-y' as string]: `${profile.anchorY}px`,
    ['--plant-y-mobile' as string]: `${profile.mobileAnchorY}px`,
    ['--stem-height' as string]: `${profile.stemHeight}px`,
    ['--stem-width' as string]: `${profile.stemWidth}px`,
    ['--head-hue' as string]: `${profile.headHueRotateDeg}deg`,
    ['--stem-color' as string]: profile.stemColor,
    ['--mouth-color' as string]: profile.mouthColor,
    ['--sway-duration' as string]: `${profile.swayDurationMs}ms`,
    ['--sway-delay' as string]: `${profile.swayDelayMs}ms`
  } as CSSProperties;
}

const QuotaPlant = ({
  profile,
  lifecycle,
  now,
  job
}: {
  profile: GardenPlantProfile;
  lifecycle: GardenLifecyclePhase;
  now: number;
  job?: GardenJob;
}) => {
  const phase = getGardenPlantPhase({ lifecycle, now, job });
  const reserved = Boolean(
    job
    && job.outcome === 'caught'
    && job.endsAt > now
  );
  const attacking = Boolean(
    reserved
    && job
    && job.attackAt <= now
  );

  return (
    <span
      className={[
        'upstream-quota-plant',
        `upstream-quota-plant--lifecycle-${lifecycle}`,
        reserved ? 'upstream-quota-plant--reserved' : '',
        attacking ? 'upstream-quota-plant--attacking' : '',
        `upstream-quota-plant--phase-${phase}`
      ].filter(Boolean).join(' ')}
      data-plant-index={profile.index}
      data-plant-lifecycle={lifecycle}
      data-plant-phase={phase}
      data-plant-metric={profile.metricKey}
      data-plant-job={job?.drop.id}
      style={buildPlantStyle(profile)}
    >
      <span className="upstream-quota-plant-growth">
        <span className="upstream-quota-plant-sway">
          <span
            className="upstream-quota-plant-root-anchor"
            data-quota-plant-root={profile.index}
          />
          <span className="upstream-quota-plant-leaf upstream-quota-plant-leaf--left" />
          <span className="upstream-quota-plant-leaf upstream-quota-plant-leaf--right" />
          <span className="upstream-quota-plant-stem" />
          <span
            key={job?.id || 'idle'}
            className="upstream-quota-plant-head-stage"
            data-quota-plant-origin={profile.index}
          >
            <QuotaPlantHead />
          </span>
        </span>
      </span>
    </span>
  );
};

/**
 * API Key 账号的 Token 柱顶微剧场。事件只在到达时争抢一次，不排队补吃。
 */
const UpstreamQuotaGarden = ({
  accountRef,
  usage,
  active,
  drops,
  onStageActiveChange
}: Props) => {
  const layout = useMemo(() => buildGardenLayout(accountRef, usage), [accountRef, usage]);
  const [jobs, setJobs] = useState<GardenJob[]>([]);
  const [lifecycle, setLifecycle] = useState<GardenLifecycleState>(() => ({
    phase: 'hidden',
    startedAt: Date.now()
  }));
  const [clock, setClock] = useState(() => Date.now());
  const gardenRef = useRef<HTMLSpanElement>(null);
  const seenDropIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const now = Date.now();
    setClock(now);
    setLifecycle((current) => reconcileGardenLifecycle(current, {
      requestedActive: active,
      hasPendingJobs: jobs.length > 0,
      now
    }));
  }, [active, jobs.length]);

  useEffect(() => {
    const delay = getGardenLifecycleDelayMs(lifecycle, Date.now());
    if (delay === null) return undefined;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setClock(now);
      setLifecycle((current) => reconcileGardenLifecycle(current, {
        requestedActive: active,
        hasPendingJobs: jobs.length > 0,
        now
      }));
    }, delay + 20);
    return () => window.clearTimeout(timer);
  }, [active, jobs.length, lifecycle]);

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
    if (!active || fresh.length === 0 || layout.profiles.length === 0) return;

    const now = Date.now();
    const lifecycleDelay = getGardenLifecycleDelayMs(lifecycle, now);
    const minimumDelayMs = lifecycle.phase === 'visible'
      ? 0
      : lifecycle.phase === 'emerging' && lifecycleDelay !== null
        ? lifecycleDelay
        : GARDEN_EMERGE_MS;
    setClock(now);
    setJobs((current) => scheduleGardenDrops({
      accountRef,
      drops: fresh,
      profiles: layout.profiles,
      jobs: current,
      now,
      minimumDelayMs
    }).jobs);
  }, [accountRef, active, drops, layout.profiles, lifecycle]);

  useEffect(() => {
    if (jobs.length === 0) return undefined;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      setJobs((current) => {
        const next = pruneGardenJobs(current, now, layout.profiles.length);
        return next.length === current.length ? current : next;
      });
    }, 70);
    return () => window.clearInterval(timer);
  }, [jobs.length, layout.profiles.length]);

  const jobsByPlant = useMemo(() => {
    const result = new Map<number, GardenJob>();
    jobs.forEach((job) => {
      if (job.outcome === 'caught' && job.plantIndex !== null && job.endsAt > clock) {
        result.set(job.plantIndex, job);
      }
    });
    return result;
  }, [clock, jobs]);

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
      data-garden-plants={layout.profiles.length}
      data-garden-jobs={jobs.length}
      style={{
        ['--garden-columns' as string]: layout.columns,
        ['--garden-emerge-duration' as string]: `${GARDEN_EMERGE_MS}ms`,
        ['--garden-retreat-duration' as string]: `${GARDEN_RETREAT_MS}ms`
      } as CSSProperties}
      aria-hidden="true"
    >
      {layout.profiles.map((profile) => (
        <QuotaPlant
          key={profile.id}
          profile={profile}
          lifecycle={lifecycle.phase}
          now={clock}
          job={jobsByPlant.get(profile.index)}
        />
      ))}
      <UpstreamQuotaAttackLayer
        accountRef={accountRef}
        gardenRef={gardenRef}
        jobs={jobs}
        profiles={layout.profiles}
      />
    </span>
  );
};

export default UpstreamQuotaGarden;
