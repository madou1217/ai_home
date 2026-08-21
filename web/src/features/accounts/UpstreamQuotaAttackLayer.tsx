import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';

import QuotaPlantHead from './garden/QuotaPlantHead';
import { TokenDropLabel } from './TokenDropNumber';
import { GARDEN_ATTACK_MS, GARDEN_MISS_MS } from './garden/feeding-model';
import type { GardenFeedJob } from './garden/feeding-model';
import {
  buildGardenAttackGeometry,
  buildGardenDamagePoint
} from './garden/attack-geometry';
import type { GardenAttackGeometry } from './garden/attack-geometry';
import type { GardenPoint } from './garden/vine-geometry';
import { GARDEN_STALK_TIP_WIDTH } from './garden/plant-profile';
import type { GardenPlantProfile } from './garden/plant-profile';
import { subscribeViewportChange } from './garden/viewport-observer';

interface Props {
  accountRef: string;
  gardenRef: RefObject<HTMLSpanElement>;
  jobs: GardenFeedJob[];
  profile: GardenPlantProfile;
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

function getCenter(element: HTMLElement): GardenPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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
const UpstreamQuotaAttackLayer = ({ accountRef, gardenRef, jobs, profile }: Props) => {
  const [measurements, setMeasurements] = useState<Record<string, MeasuredJob>>({});
  const attackLayerId = `quota-attack-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  // 测量本身不该重建监听：jobs 每次调度都是新数组，跟着它拆装监听会一直抖。
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const measure = useCallback(() => {
    const garden = gardenRef.current;
    const currentJobs = jobsRef.current;
    if (!garden || currentJobs.length === 0) {
      setMeasurements((current) => (Object.keys(current).length === 0 ? current : {}));
      return;
    }

    const source = findDamageSource(garden, accountRef);
    if (!source) {
      setMeasurements((current) => (Object.keys(current).length === 0 ? current : {}));
      return;
    }

    const sourceRect = source.getBoundingClientRect();
    // 只需要花茎顶端（头的咽喉）：藤蔓从那里往外长，根部由原地植株自己画。
    const originElement = garden.querySelector<HTMLElement>('[data-quota-plant-origin]');
    const origin = hasVisibleRect(originElement)
      ? getCenter(originElement as HTMLElement)
      : null;

    const next: Record<string, MeasuredJob> = {};
    currentJobs.forEach((job) => {
      const damagePoint = buildGardenDamagePoint(accountRef, job.drop.id, sourceRect);
      const missFallPx = Math.max(
        18,
        Math.min(52, sourceRect.top + sourceRect.height - damagePoint.y - 6)
      );
      if (job.outcome === 'missed' || !origin) {
        next[job.id] = { damagePoint, attack: null, missFallPx };
        return;
      }
      next[job.id] = {
        damagePoint,
        // 起点宽度对齐花茎顶端，藤蔓才是这根茎的延长而不是另一条绳子。
        attack: buildGardenAttackGeometry(origin, damagePoint, GARDEN_STALK_TIP_WIDTH),
        missFallPx
      };
    });
    setMeasurements(next);
  }, [accountRef, gardenRef]);

  useLayoutEffect(() => {
    if (jobs.length === 0) {
      setMeasurements((current) => (Object.keys(current).length === 0 ? current : {}));
      return undefined;
    }

    let frame = window.requestAnimationFrame(measure);
    // 入场与柱子折叠都可能改变锚点；每一口扑出去之前再量一次。
    const timers = jobs.map((job) => window.setTimeout(
      measure,
      Math.max(0, job.attackAt - Date.now())
    ));
    return () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [jobs, measure]);

  // 滚动/缩放走全页面共享的那一对监听，不是每个账号行各挂一份。
  useEffect(() => {
    if (jobs.length === 0) return undefined;
    return subscribeViewportChange(measure);
  }, [jobs.length, measure]);

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
        const ropeMaskId = `${attackLayerId}-rope-${jobIndex}`;
        const style = {
          ['--damage-x' as string]: `${measured.damagePoint.x}px`,
          ['--damage-y' as string]: `${measured.damagePoint.y}px`,
          ['--attack-delay' as string]: `${Math.max(0, job.attackAt - job.createdAt)}ms`,
          ['--attack-duration' as string]: `${GARDEN_ATTACK_MS}ms`,
          ['--miss-duration' as string]: `${GARDEN_MISS_MS}ms`,
          ['--miss-fall' as string]: `${measured.missFallPx}px`,
          ['--head-skin' as string]: profile.headSkinColor,
          ['--head-outline' as string]: profile.headOutlineColor,
          ['--mouth-color' as string]: profile.mouthColor,
          ['--stem-color' as string]: profile.stemColor,
          ...(measured.attack ? {
            ['--attack-offset-path' as string]: `path("${measured.attack.pathData}")`,
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
            data-attack-curve={measured.attack ? 'cubic' : undefined}
            style={style}
          >
            <span className="upstream-quota-attack-damage">
              <TokenDropLabel drop={job.drop} />
            </span>
            {measured.attack ? (
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
                        d={measured.attack.pathData}
                        pathLength={100}
                        vectorEffect="non-scaling-stroke"
                      />
                    </mask>
                  </defs>
                  <g mask={`url(#${ropeMaskId})`}>
                    <path
                      className="upstream-quota-attack-rope-body"
                      d={measured.attack.vineRibbonPath}
                    />
                    <path
                      className="upstream-quota-attack-rope-sheen"
                      d={measured.attack.pathData}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                </svg>
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
