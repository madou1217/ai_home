import React, { useCallback, useId, useLayoutEffect, useMemo, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';

import QuotaPlantHead from './QuotaPlantHead';
import { TokenDropLabel } from './TokenDropNumber';
import {
  GARDEN_ATTACK_MS,
  GARDEN_MISS_MS,
  buildGardenAttackGeometry,
  buildGardenDamagePoint
} from './upstream-quota-garden-model';
import type {
  GardenAttackGeometry,
  GardenJob,
  GardenPlantProfile,
  GardenPoint
} from './upstream-quota-garden-model';

interface Props {
  accountRef: string;
  gardenRef: RefObject<HTMLSpanElement>;
  jobs: GardenJob[];
  profiles: GardenPlantProfile[];
}

interface MeasuredJob {
  damagePoint: GardenPoint;
  attack: GardenAttackGeometry | null;
  missFallPx: number;
}

function hasVisibleRect(element: HTMLElement | null): element is HTMLElement {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findDamageSource(garden: HTMLElement, accountRef: string) {
  const accountContainer = garden.parentElement?.closest<HTMLElement>('[data-account-ref]');
  const localSource = accountContainer?.querySelector<HTMLElement>(
    '[data-quota-damage-source="true"]'
  ) || null;
  if (hasVisibleRect(localSource)) return localSource;

  return Array.from(document.querySelectorAll<HTMLElement>('[data-quota-damage-source="true"]'))
    .find((element) => (
      element.dataset.accountRef === accountRef && hasVisibleRect(element)
    )) || null;
}

/**
 * 跨列捕食层：伤害数字固定出生在剩余额度列，头部从 Token 柱顶伸颈过去吞食。
 * Portal 只解决跨单元格裁切；事件调度仍由 UpstreamQuotaGarden 单点持有。
 */
const UpstreamQuotaAttackLayer = ({ accountRef, gardenRef, jobs, profiles }: Props) => {
  const [measurements, setMeasurements] = useState<Record<string, MeasuredJob>>({});
  const attackLayerId = `quota-attack-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const measure = useCallback(() => {
    const garden = gardenRef.current;
    if (!garden || jobs.length === 0) {
      setMeasurements({});
      return;
    }

    const source = findDamageSource(garden, accountRef);
    if (!source) {
      setMeasurements({});
      return;
    }

    const sourceRect = source.getBoundingClientRect();
    const next: Record<string, MeasuredJob> = {};
    jobs.forEach((job) => {
      const damagePoint = buildGardenDamagePoint(accountRef, job.drop.id, sourceRect);
      const missFallPx = Math.max(
        18,
        Math.min(52, sourceRect.top + sourceRect.height - damagePoint.y - 6)
      );
      if (job.outcome === 'missed' || job.plantIndex === null) {
        next[job.id] = { damagePoint, attack: null, missFallPx };
        return;
      }

      const originElement = garden.querySelector<HTMLElement>(
        `[data-quota-plant-origin="${job.plantIndex}"]`
      );
      const rootElement = garden.querySelector<HTMLElement>(
        `[data-quota-plant-root="${job.plantIndex}"]`
      );
      if (!hasVisibleRect(originElement) || !hasVisibleRect(rootElement)) return;
      const originRect = originElement.getBoundingClientRect();
      const rootRect = rootElement.getBoundingClientRect();
      const origin = {
        x: originRect.left + originRect.width / 2,
        y: originRect.top + originRect.height / 2
      };
      const root = {
        x: rootRect.left + rootRect.width / 2,
        y: rootRect.top + rootRect.height / 2
      };
      next[job.id] = {
        damagePoint,
        attack: buildGardenAttackGeometry(origin, damagePoint, root),
        missFallPx
      };
    });
    setMeasurements(next);
  }, [accountRef, gardenRef, jobs]);

  useLayoutEffect(() => {
    if (jobs.length === 0) {
      setMeasurements({});
      return undefined;
    }

    let animationFrame = 0;
    const requestMeasure = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measure);
    };
    requestMeasure();

    // 入场与柱子折叠都可能改变锚点；攻击前再测一次，避免使用过渡中的坐标。
    const timers = jobs.map((job) => window.setTimeout(
      requestMeasure,
      Math.max(0, job.attackAt - Date.now())
    ));
    window.addEventListener('resize', requestMeasure);
    window.addEventListener('scroll', requestMeasure, true);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener('resize', requestMeasure);
      window.removeEventListener('scroll', requestMeasure, true);
    };
  }, [jobs, measure]);

  const profileByIndex = useMemo(
    () => new Map(profiles.map((profile) => [profile.index, profile])),
    [profiles]
  );

  if (typeof document === 'undefined' || jobs.length === 0) return null;

  return createPortal(
    <span
      className="upstream-quota-attack-layer"
      data-quota-attack-account={accountRef}
      aria-hidden="true"
    >
      {jobs.map((job, jobIndex) => {
        const measured = measurements[job.id];
        if (!measured) return null;
        const profile = job.plantIndex === null ? null : profileByIndex.get(job.plantIndex);
        const ropeMaskId = `${attackLayerId}-rope-${jobIndex}`;
        const style = {
          ['--damage-x' as string]: `${measured.damagePoint.x}px`,
          ['--damage-y' as string]: `${measured.damagePoint.y}px`,
          ['--attack-delay' as string]: `${Math.max(0, job.attackAt - job.createdAt)}ms`,
          ['--attack-duration' as string]: `${GARDEN_ATTACK_MS}ms`,
          ['--miss-duration' as string]: `${GARDEN_MISS_MS}ms`,
          ['--miss-fall' as string]: `${measured.missFallPx}px`,
          ['--head-hue' as string]: `${profile?.headHueRotateDeg || 0}deg`,
          ['--mouth-color' as string]: profile?.mouthColor || 'hsl(8 52% 28%)',
          ...(measured.attack ? {
            ['--attack-root-x' as string]: `${measured.attack.root.x}px`,
            ['--attack-root-y' as string]: `${measured.attack.root.y}px`,
            ['--attack-origin-x' as string]: `${measured.attack.origin.x}px`,
            ['--attack-origin-y' as string]: `${measured.attack.origin.y}px`,
            ['--attack-offset-path' as string]: `path("${measured.attack.pathData}")`,
            ['--attack-rope-rest' as string]: measured.attack.ropeRestPercent,
            ['--attack-rope-mid' as string]: measured.attack.ropeMidPercent,
            ['--attack-rope-near' as string]: measured.attack.ropeNearPercent,
            ['--attack-origin-correction' as string]: `${measured.attack.originCorrectionDeg}deg`
          } : {})
        } as CSSProperties;

        return (
          <span
            key={job.id}
            className={`upstream-quota-attack upstream-quota-attack--${job.outcome}`}
            data-quota-attack-job={job.id}
            data-drop-outcome={job.outcome}
            data-drop-reason={job.reason}
            data-drop-plant={job.plantIndex == null ? undefined : String(job.plantIndex)}
            data-attack-curve={measured.attack ? 'cubic' : undefined}
            data-attack-path={measured.attack?.pathData}
            data-attack-vine-path={measured.attack?.vinePathData}
            style={style}
          >
            <span className="upstream-quota-attack-damage">
              <TokenDropLabel drop={job.drop} />
            </span>
            {measured.attack && profile ? (
              <>
                <svg
                  className="upstream-quota-attack-rope"
                  width="100%"
                  height="100%"
                  focusable="false"
                >
                  <defs>
                    <mask
                      id={ropeMaskId}
                      className="upstream-quota-attack-rope-mask"
                      maskUnits="userSpaceOnUse"
                      x="0"
                      y="0"
                      width="100%"
                      height="100%"
                    >
                      <path
                        className="upstream-quota-attack-rope-reveal"
                        d={measured.attack.vinePathData}
                        pathLength={100}
                        vectorEffect="non-scaling-stroke"
                      />
                    </mask>
                  </defs>
                  <g mask={`url(#${ropeMaskId})`}>
                    <path
                      className="upstream-quota-attack-rope-shadow"
                      d={measured.attack.vinePathData}
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      className="upstream-quota-attack-rope-core"
                      d={measured.attack.vinePathData}
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      className="upstream-quota-attack-rope-braid"
                      d={measured.attack.vinePathData}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                </svg>
                <span className="upstream-quota-attack-root-knot" />
                <span className="upstream-quota-attack-swallow-motion">
                  <span className="upstream-quota-attack-swallow" />
                </span>
                <span className="upstream-quota-attack-head-motion">
                  <span className="upstream-quota-attack-head-pose">
                    <span className="upstream-quota-attack-head-collar" />
                    <span className="upstream-quota-attack-head-scale">
                      <QuotaPlantHead />
                    </span>
                  </span>
                </span>
              </>
            ) : null}
          </span>
        );
      })}
    </span>,
    document.body
  );
};

export default UpstreamQuotaAttackLayer;
