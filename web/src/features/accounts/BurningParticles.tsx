import React, { useMemo } from 'react';

import {
  buildBurningSparkSpecs,
  clampBurningAnchor
} from './burning-particles-model';
import './BurningParticles.css';

interface Props {
  /** 进度条填充边缘（剩余值位置）水平百分比 0-100 */
  anchorPct: number;
  /** 血条主色（进度条 strokeColor），粒子在该色系内抖动并混入白热核心 */
  color: string;
  /** 最近 10 秒请求数；只用于调节火花密度与节奏。 */
  activityRate?: number;
  /** 额度轨道的稳定身份；用于实例间去相关，不能使用每次渲染变化的随机值。 */
  seedKey: string;
}

/**
 * 剩余额度「火药捻子」粒子层：燃烧点锚定在进度条填充边缘（剩余量位置），
 * 火花从该点向四周短促迸溅——距离小、密度高、白热核心，像点燃的火药引线。
 * 粒子在血条主色（getUsageBarColor）色系内抖动并混入白热核心，非纯色。
 * 纯渲染组件：CSS 变量 + keyframes 驱动，无动画库、无状态。
 */
const BurningParticles = ({ anchorPct, color, activityRate = 0, seedKey }: Props) => {
  const specs = useMemo(
    () => buildBurningSparkSpecs(color, activityRate, seedKey),
    [activityRate, color, seedKey]
  );
  const anchor = clampBurningAnchor(anchorPct);
  const coreDuration = 0.23 + (Math.abs(specs[0]?.dx || 0) % 0.09);
  const coreDelay = specs[0]?.delay || 0;
  const joltDuration = 0.15 + (Math.abs(specs[1]?.dy || 0) % 0.07);
  const joltDelay = specs[1]?.delay || 0;

  return (
    <span
      className="burning-particles"
      aria-hidden="true"
      data-burning-anchor={String(anchor)}
      data-burning-seed={seedKey}
      style={{
        ['--anchor' as string]: `${anchor}%`,
        ['--core-color' as string]: color,
        ['--core-duration' as string]: `${coreDuration.toFixed(3)}s`,
        ['--core-delay' as string]: `${coreDelay.toFixed(3)}s`,
        ['--jolt-duration' as string]: `${joltDuration.toFixed(3)}s`,
        ['--jolt-delay' as string]: `${joltDelay.toFixed(3)}s`
      }}
    >
      {specs.map((spec, index) => (
        <span
          key={index}
          className={`burning-particle${spec.ember ? ' burning-particle--ember' : ''}`}
          style={{
            ['--dx' as string]: `${Math.round(spec.dx * 10) / 10}px`,
            ['--dy' as string]: `${Math.round(spec.dy * 10) / 10}px`,
            ['--fall' as string]: `${Math.round(spec.fall * 10) / 10}px`,
            ['--pw' as string]: `${Math.round(spec.width * 10) / 10}px`,
            ['--ph' as string]: `${Math.round(spec.height * 10) / 10}px`,
            ['--rot' as string]: `${Math.round(spec.rotation * 10) / 10}deg`,
            ['--dur' as string]: `${Math.round(spec.duration * 100) / 100}s`,
            ['--delay' as string]: `${Math.round(spec.delay * 100) / 100}s`,
            ['--pc' as string]: `hsl(${spec.hue} ${spec.saturation}% ${spec.lightness}%)`
          }}
        />
      ))}
    </span>
  );
};

export default BurningParticles;
