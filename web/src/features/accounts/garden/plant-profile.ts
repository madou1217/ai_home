import { stableGardenRandom, stableGardenRange } from './stable-random';
import { clampNumber } from './vine-geometry';

/** 花茎最短/最长长度（px）。柱子越高长得越精神，但不能高到盖住上一行。 */
export const GARDEN_STEM_MIN_HEIGHT = 15;
export const GARDEN_STEM_MAX_HEIGHT = 27;
/** 茎宽相对柱宽（14px）不能太细，3px 那种会看成一根牙签。 */
export const GARDEN_STEM_WIDTH = 5;
export const GARDEN_HEAD_WIDTH = 20;
export const GARDEN_HEAD_HEIGHT = 19;

export interface GardenPlantProfile {
  /** 每个账号一朵花，色调稳定，用来区分不同账号的行。 */
  headHueRotateDeg: number;
  /** 花茎弯曲量（px），正负决定往哪边鼓。 */
  stemBend: number;
  stemColor: string;
  mouthColor: string;
  swayDurationMs: number;
  swayDelayMs: number;
}

export function buildPlantProfile(accountRef: string): GardenPlantProfile {
  return {
    headHueRotateDeg: Math.round(stableGardenRange(-32, 32, accountRef, 'head-hue')),
    stemBend: Number(stableGardenRange(-3.6, 3.6, accountRef, 'stem-bend').toFixed(2)),
    stemColor: 'hsl(104 42% 38%)',
    mouthColor: 'hsl(8 52% 28%)',
    swayDurationMs: Math.round(stableGardenRange(2600, 3400, accountRef, 'sway-duration')),
    // 负延迟：不同账号的摇摆一开始就错开，不会整页同步摆动。
    swayDelayMs: -Math.round(stableGardenRandom(accountRef, 'sway-phase') * 2700)
  };
}

/** 茎长跟着脚下那根柱子走，而不是写死一个常数。 */
export function getStemHeight(barHeight: number) {
  const height = Number.isFinite(barHeight) ? barHeight : 0;
  return Math.round(clampNumber(
    GARDEN_STEM_MIN_HEIGHT + height * 0.42,
    GARDEN_STEM_MIN_HEIGHT,
    GARDEN_STEM_MAX_HEIGHT
  ));
}
