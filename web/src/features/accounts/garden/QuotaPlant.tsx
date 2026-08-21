import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';

import QuotaPlantHead from '../QuotaPlantHead';
import type { GardenLifecyclePhase } from './lifecycle-model';
import type { GardenPerch } from './perch-model';
import type { HopState } from './hop-model';
import { GARDEN_HOP_FLIGHT_MS } from './hop-model';
import { GARDEN_STEM_WIDTH, getStemHeight } from './plant-profile';
import type { GardenPlantProfile } from './plant-profile';
import { buildVineSegment } from './vine-geometry';

/** 花茎 SVG 的画布宽度：够装下最大弯曲量与描边，且不随槽宽变化。 */
const VINE_CANVAS_WIDTH = 26;
/** 头部压在茎顶上的重叠量，避免出现一条缝。 */
const VINE_HEAD_OVERLAP = 2;

interface Props {
  profile: GardenPlantProfile;
  perch: GardenPerch;
  /** 起跳点；仅腾空期间需要，用来算这一跳的位移。 */
  fromPerch: GardenPerch | null;
  hop: HopState;
  lifecycle: GardenLifecyclePhase;
  /** 正在捕食：头部交给攻击层，原地只留茎。 */
  busy: boolean;
}

function buildPlantStyle(
  profile: GardenPlantProfile,
  perch: GardenPerch,
  fromPerch: GardenPerch | null,
  stemHeight: number
): CSSProperties {
  // 跳跃位移用无量纲比例表达，真实像素由 CSS 乘上花园宽度算出来——
  // 桌面 46px 槽和移动端 52px 槽因此共用同一条抛物线，不用测量 DOM。
  const hopRatio = fromPerch ? (fromPerch.xPercent - perch.xPercent) / 100 : 0;
  return {
    ['--plant-x' as string]: `${perch.xPercent}%`,
    ['--plant-y' as string]: `${perch.y}px`,
    ['--plant-y-mobile' as string]: `${perch.mobileY}px`,
    ['--stem-height' as string]: `${stemHeight}px`,
    ['--stem-width' as string]: `${GARDEN_STEM_WIDTH}px`,
    ['--hop-dx-ratio' as string]: hopRatio,
    ['--hop-dy' as string]: `${fromPerch ? fromPerch.y - perch.y : 0}px`,
    ['--hop-dy-mobile' as string]: `${fromPerch ? fromPerch.mobileY - perch.mobileY : 0}px`,
    ['--hop-duration' as string]: `${GARDEN_HOP_FLIGHT_MS}ms`,
    ['--head-hue' as string]: `${profile.headHueRotateDeg}deg`,
    ['--stem-color' as string]: profile.stemColor,
    ['--mouth-color' as string]: profile.mouthColor,
    ['--sway-duration' as string]: `${profile.swayDurationMs}ms`,
    ['--sway-delay' as string]: `${profile.swayDelayMs}ms`
  } as CSSProperties;
}

/**
 * 一个账号一株花。三层各管一件事，互不打架：
 * - 最外层定位到当前柱顶，并负责腾空跳的位移（不裁剪，弧线才飞得出去）；
 * - pipe 层做出土裁剪，花从柱子里长出来/缩回去靠它；
 * - sway 层负责摇摆，茎与头一起摆。
 */
const QuotaPlant = ({ profile, perch, fromPerch, hop, lifecycle, busy }: Props) => {
  const stemHeight = getStemHeight(perch.barHeight);
  const airborne = hop.phase === 'airborne' && Boolean(fromPerch);
  const vine = useMemo(() => {
    const canvasHeight = stemHeight + VINE_HEAD_OVERLAP;
    return {
      canvasHeight,
      segment: buildVineSegment(
        { x: VINE_CANVAS_WIDTH / 2, y: canvasHeight },
        { x: VINE_CANVAS_WIDTH / 2, y: VINE_HEAD_OVERLAP },
        profile.stemBend
      )
    };
  }, [profile.stemBend, stemHeight]);

  return (
    <span
      className={[
        'quota-plant',
        `quota-plant--lifecycle-${lifecycle}`,
        airborne ? 'quota-plant--airborne' : '',
        busy ? 'quota-plant--busy' : ''
      ].filter(Boolean).join(' ')}
      data-plant-lifecycle={lifecycle}
      data-plant-metric={perch.metricKey}
      data-plant-hop={hop.phase}
      data-plant-hop-index={hop.hopIndex}
      style={buildPlantStyle(profile, perch, airborne ? fromPerch : null, stemHeight)}
    >
      <span className="quota-plant-hop">
        <span className="quota-plant-pipe">
          <span className="quota-plant-body">
            <span className="quota-plant-sway">
              <span className="quota-plant-root" data-quota-plant-root="0" />
              <svg
                className="quota-plant-vine"
                width={VINE_CANVAS_WIDTH}
                height={vine.canvasHeight}
                viewBox={`0 0 ${VINE_CANVAS_WIDTH} ${vine.canvasHeight}`}
                focusable="false"
                aria-hidden="true"
              >
                <path className="quota-plant-vine-shadow" d={vine.segment.pathData} />
                <path className="quota-plant-vine-core" d={vine.segment.pathData} />
                <path className="quota-plant-vine-braid" d={vine.segment.pathData} />
              </svg>
              <span className="quota-plant-leaf quota-plant-leaf--left" />
              <span className="quota-plant-leaf quota-plant-leaf--right" />
              <span className="quota-plant-head" data-quota-plant-origin="0">
                <QuotaPlantHead />
              </span>
            </span>
          </span>
        </span>
      </span>
    </span>
  );
};

export default QuotaPlant;
