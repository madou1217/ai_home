import React, { useMemo } from 'react';

import './BurningParticles.css';

interface Props {
  /** 运行中（inFlight > 0）：喷射密集；空闲：少量余烬缓慢上浮 */
  active: boolean;
  /** 进度条填充边缘（剩余值位置）水平百分比 0-100 */
  anchorPct: number;
  /** 血条主色（进度条 strokeColor），粒子在该色系内抖动并混入白热核心 */
  color: string;
}

/** 十六进制 → HSL 三元组（供粒子色系抖动用）。 */
function hexToHsl(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return [0, 60, 60];
  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

/** 由 index 派生的确定性伪随机（0-1），保证粒子参数跨渲染稳定。 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

interface SparkSpec {
  dx: number;
  dy: number;
  size: number;
  delay: number;
  duration: number;
  hue: number;
  sat: number;
  light: number;
}

/** 火药捻子火花：从燃烧点（剩余量位置）向四周短促迸溅，距离小、密度高。 */
function buildSparkSpecs(active: boolean, baseHsl: [number, number, number]): SparkSpec[] {
  const count = active ? 48 : 10;
  const [baseHue, baseSat, baseLight] = baseHsl;
  const specs: SparkSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const r1 = seededRandom(i + 1);
    const r2 = seededRandom(i + 101);
    const r3 = seededRandom(i + 201);
    const r4 = seededRandom(i + 301);
    // 以向上/侧向为主（-150°~-30°），少量向下溅落；迸溅距离很短，紧贴燃烧点。
    const angle = (-150 + r1 * 120) * (Math.PI / 180);
    const distance = active ? 4 + r2 * 11 : 2 + r3 * 5;
    specs.push({
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance,
      size: active ? 1.6 + r3 * 1.8 : 1.2 + r4 * 1.2,
      delay: active ? r4 * 0.5 : r2 * 1.2,
      duration: active ? 0.3 + r2 * 0.35 : 0.8 + r3 * 0.8,
      hue: (baseHue + (r1 - 0.5) * 20 + 360) % 360,
      sat: Math.min(100, Math.max(35, baseSat + (r2 - 0.5) * 24)),
      light: Math.min(94, Math.max(40, baseLight + 14 + r3 * 26))
    });
  }
  return specs;
}

/**
 * 剩余额度「火药捻子」粒子层：燃烧点锚定在进度条填充边缘（剩余量位置），
 * 火花从该点向四周短促迸溅——距离小、密度高、白热核心，像点燃的火药引线。
 * 粒子在血条主色（getUsageBarColor）色系内抖动并混入白热核心，非纯色。
 * 纯渲染组件：CSS 变量 + keyframes 驱动，无动画库、无状态。
 */
const BurningParticles = ({ active, anchorPct, color }: Props) => {
  const baseHsl = useMemo(() => hexToHsl(color), [color]);
  const specs = useMemo(() => buildSparkSpecs(active, baseHsl), [active, baseHsl]);
  const anchor = Math.max(4, Math.min(96, Number(anchorPct) || 50));

  return (
    <span
      className={`burning-particles${active ? ' burning-particles--active' : ''}`}
      aria-hidden="true"
      style={{ ['--anchor' as string]: `${anchor}%` }}
    >
      {specs.map((spec, index) => (
        <span
          key={index}
          className="burning-particle"
          style={{
            ['--dx' as string]: `${Math.round(spec.dx * 10) / 10}px`,
            ['--dy' as string]: `${Math.round(spec.dy * 10) / 10}px`,
            ['--ps' as string]: `${Math.round(spec.size * 10) / 10}px`,
            ['--dur' as string]: `${Math.round(spec.duration * 100) / 100}s`,
            ['--delay' as string]: `${Math.round(spec.delay * 100) / 100}s`,
            ['--pc' as string]: `hsl(${spec.hue} ${spec.sat}% ${spec.light}%)`
          }}
        />
      ))}
    </span>
  );
};

export default BurningParticles;