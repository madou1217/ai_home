import React from 'react';
import type { CSSProperties } from 'react';

import QuotaPlantHead from './QuotaPlantHead';
import QuotaPlantStalk from './QuotaPlantStalk';
import type { GardenLifecyclePhase } from './lifecycle-model';
import type { GardenPerch } from './perch-model';
import type { HopState } from './hop-model';
import { GARDEN_HOP_FLIGHT_MS } from './hop-model';
import { getStemHeight } from './plant-profile';
import type { GardenPlantProfile } from './plant-profile';

interface Props {
  profile: GardenPlantProfile;
  perch: GardenPerch;
  /** 起跳点；仅腾空期间需要，用来算这一跳的位移与朝向。 */
  fromPerch: GardenPerch | null;
  hop: HopState;
  lifecycle: GardenLifecyclePhase;
  /** 正在捕食：整株交给攻击层，原地只留一个根结。 */
  busy: boolean;
}

function buildPlantStyle(
  profile: GardenPlantProfile,
  perch: GardenPerch,
  fromPerch: GardenPerch | null,
  hop: HopState,
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
    ['--hop-dx-ratio' as string]: hopRatio,
    ['--hop-dy' as string]: `${fromPerch ? fromPerch.y - perch.y : 0}px`,
    ['--hop-dy-mobile' as string]: `${fromPerch ? fromPerch.mobileY - perch.mobileY : 0}px`,
    ['--hop-duration' as string]: `${GARDEN_HOP_FLIGHT_MS}ms`,
    ['--facing' as string]: hop.facing,
    ['--facing-from' as string]: hop.facingFrom,
    ['--head-hue' as string]: `${profile.headHueRotateDeg}deg`,
    ['--plant-lean' as string]: `${profile.leanDeg}deg`,
    ['--stem-color' as string]: profile.stemColor,
    ['--stem-shade' as string]: profile.stemShadeColor,
    ['--mouth-color' as string]: profile.mouthColor,
    ['--sway-duration' as string]: `${profile.swayDurationMs}ms`,
    ['--sway-delay' as string]: `${profile.swayDelayMs}ms`
  } as CSSProperties;
}

/**
 * 一个账号一株花。每层只管一件事，互不打架：
 * - plant   钉在当前柱顶（不裁剪，弧线才飞得出去）
 * - hop     跳跃位移
 * - pipe    出土裁剪
 * - body    出场/退场升降
 * - squash  整株的压扁与拉伸（起跳蓄力、落地回弹）
 * - stalk   骨节链：摇摆、甩动、头与叶都长在它上面
 */
const QuotaPlant = ({ profile, perch, fromPerch, hop, lifecycle, busy }: Props) => {
  const stemHeight = getStemHeight(perch.barHeight);
  const airborne = hop.phase === 'airborne' && Boolean(fromPerch);

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
      data-plant-facing={hop.facing}
      style={buildPlantStyle(profile, perch, airborne ? fromPerch : null, hop, stemHeight)}
    >
      <span className="quota-plant-hop">
        <span className="quota-plant-pipe">
          <span className="quota-plant-body">
            <span className="quota-plant-root" data-quota-plant-root="0" />
            <span className="quota-plant-squash">
              <QuotaPlantStalk
                stemHeight={stemHeight}
                head={(
                  <span className="quota-plant-head" data-quota-plant-origin="0">
                    <QuotaPlantHead />
                  </span>
                )}
              />
            </span>
          </span>
        </span>
      </span>
    </span>
  );
};

export default QuotaPlant;
