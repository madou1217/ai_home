import { stableGardenRandom, stableGardenRange } from './stable-random';
import { clampNumber } from './vine-geometry';

/** 花茎最短/最长长度（px）。柱子越高长得越精神，但不能高到盖住上一行。 */
export const GARDEN_STEM_MIN_HEIGHT = 16;
export const GARDEN_STEM_MAX_HEIGHT = 30;
/** 茎的骨节数：够画出一道波，又不至于每株花挂一堆元素。 */
export const GARDEN_STALK_SEGMENTS = 4;
/** 根部/顶端的茎宽，中间线性收细——锥形比等宽柱体像植物。 */
export const GARDEN_STALK_BASE_WIDTH = 6.5;
export const GARDEN_STALK_TIP_WIDTH = 4;

export interface GardenStalkSegment {
  height: number;
  width: number;
}

export interface GardenPlantProfile {
  /** 头的配色。每个账号一朵花，色相稳定，用来区分不同账号的行。 */
  headSkinColor: string;
  headOutlineColor: string;
  /** 待机时整株的静态倾斜，几株花并排时不会像复制粘贴。 */
  leanDeg: number;
  stemColor: string;
  stemShadeColor: string;
  mouthColor: string;
  swayDurationMs: number;
  swayDelayMs: number;
}

export function buildPlantProfile(accountRef: string): GardenPlantProfile {
  // 色相直接算进颜色：filter 会让飞行中的头每帧重新滤一遍，而这只是个静态色差。
  const hue = 352 + Math.round(stableGardenRange(-14, 14, accountRef, 'head-hue'));
  return {
    headSkinColor: `hsl(${hue} 72% 52%)`,
    headOutlineColor: `hsl(${hue} 56% 22%)`,
    leanDeg: Number(stableGardenRange(-5, 5, accountRef, 'lean').toFixed(2)),
    stemColor: 'hsl(104 44% 42%)',
    stemShadeColor: 'hsl(108 40% 26%)',
    mouthColor: `hsl(${hue} 62% 17%)`,
    swayDurationMs: Math.round(stableGardenRange(2600, 3400, accountRef, 'sway-duration')),
    // 负延迟：不同账号的摇摆一开始就错开，不会整页同步摆动。
    swayDelayMs: -Math.round(stableGardenRandom(accountRef, 'sway-phase') * 2700)
  };
}

/** 茎长跟着脚下那根柱子走，而不是写死一个常数。 */
export function getStemHeight(barHeight: number) {
  const height = Number.isFinite(barHeight) ? barHeight : 0;
  return Math.round(clampNumber(
    GARDEN_STEM_MIN_HEIGHT + height * 0.46,
    GARDEN_STEM_MIN_HEIGHT,
    GARDEN_STEM_MAX_HEIGHT
  ));
}

/** 把茎长切成锥形骨节：每节比下一节细一点，接缝靠圆头描边盖住。 */
export function getStalkSegments(stemHeight: number): GardenStalkSegment[] {
  const total = Math.max(GARDEN_STEM_MIN_HEIGHT, stemHeight);
  const segmentHeight = total / GARDEN_STALK_SEGMENTS;
  const widthStep = (GARDEN_STALK_BASE_WIDTH - GARDEN_STALK_TIP_WIDTH)
    / Math.max(1, GARDEN_STALK_SEGMENTS - 1);
  return Array.from({ length: GARDEN_STALK_SEGMENTS }, (_value, index) => ({
    height: Number(segmentHeight.toFixed(2)),
    width: Number((GARDEN_STALK_BASE_WIDTH - widthStep * index).toFixed(2))
  }));
}

/**
 * 头的定位锚点（咽喉）相对根部的高度。
 *
 * 咽喉就落在茎顶，所以这个值等于茎长本身——攻击藤蔓取的 origin 是头部元素的
 * 中心，也就是这一点，藤蔓因此正好从花茎结束的地方接着往外伸。
 */
export function getHeadCenterOffset(stemHeight: number) {
  return stemHeight;
}
