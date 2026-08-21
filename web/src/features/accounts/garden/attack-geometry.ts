import { stableGardenRandom } from './stable-random';
import {
  approximateCubicLength,
  buildCubicPathData,
  buildVineSegment,
  clampNumber,
  formatPathPoint
} from './vine-geometry';
import type { GardenPoint } from './vine-geometry';

function normalizeAngle(angleDeg: number) {
  return ((angleDeg + 180) % 360 + 360) % 360 - 180;
}

export interface GardenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GardenAttackGeometry {
  root: GardenPoint;
  origin: GardenPoint;
  target: GardenPoint;
  control1: GardenPoint;
  control2: GardenPoint;
  /** 只有扑出去的那一段，供头部 motion-path 使用。 */
  pathData: string;
  /** 柱顶 → 待机头 → 目标的一整条连续藤蔓。 */
  vinePathData: string;
  /** 待机段占整条藤蔓的比例；reveal 从这里开始往外伸。 */
  ropeRestPercent: number;
  ropeMidPercent: number;
  ropeNearPercent: number;
  /** motion-path 会让嘴朝行进方向；待机点用反向补偿恢复原地朝向。 */
  originCorrectionDeg: number;
}

/** 伤害点始终留在剩余额度锚点内，并按账号与事件稳定错开。 */
export function buildGardenDamagePoint(
  accountRef: string,
  dropId: string,
  source: GardenRect
): GardenPoint {
  const width = Math.max(1, Number(source.width) || 0);
  const height = Math.max(1, Number(source.height) || 0);
  const horizontalInset = Math.min(width / 2, Math.max(18, width * 0.12));
  const verticalInset = Math.min(height / 2, Math.max(10, height * 0.18));
  const horizontalRange = Math.max(0, width - horizontalInset * 2);
  const verticalRange = Math.max(0, height - verticalInset * 2);

  return {
    x: source.left
      + horizontalInset
      + horizontalRange * stableGardenRandom(accountRef, dropId, 'damage-x'),
    y: source.top
      + verticalInset
      + verticalRange * stableGardenRandom(accountRef, dropId, 'damage-y')
  };
}

/**
 * 待机头到伤害值之间的扑咬路径：先上扬越过卡片，再从目标上方俯冲。
 * 根部到待机头那一段直接复用 buildVineSegment——和原地花茎同一个函数、同一份
 * bend，所以藤蔓伸出去时与花茎严丝合缝。
 */
export function buildGardenAttackGeometry(
  origin: GardenPoint,
  target: GardenPoint,
  root: GardenPoint = origin,
  stemBend = 0
): GardenAttackGeometry {
  const deltaX = target.x - origin.x;
  const deltaY = target.y - origin.y;
  const horizontalSpan = Math.abs(deltaX);
  const verticalSpan = Math.abs(deltaY);
  const arcLift = clampNumber(horizontalSpan * 0.22 + verticalSpan * 0.08, 64, 132);
  const apexY = Math.max(10, Math.min(origin.y, target.y) - arcLift);

  // 移动端两列可能近乎垂直排列；给窄路径一个侧向弯折，避免退化成上下直线。
  const lateralDirection = target.x <= origin.x ? -1 : 1;
  const lateralBend = lateralDirection * clampNumber(48 - horizontalSpan, 0, 34);
  const control1 = {
    x: origin.x + deltaX * 0.17 + lateralBend,
    y: apexY
  };
  const control2 = {
    x: origin.x + deltaX * 0.86 + lateralBend * 0.28,
    y: Math.min(target.y - 24, apexY + arcLift * 0.14)
  };
  const pathData = buildCubicPathData(origin, control1, control2, target);
  const startTangentDeg = Math.atan2(
    control1.y - origin.y,
    control1.x - origin.x
  ) * 180 / Math.PI;

  const stem = buildVineSegment(root, origin, stemBend);
  const hasStem = stem.length > 0.5;
  const vinePathData = hasStem
    ? [
      stem.pathData,
      `C ${formatPathPoint(control1)} ${formatPathPoint(control2)} ${formatPathPoint(target)}`
    ].join(' ')
    : pathData;
  const attackLength = approximateCubicLength(origin, control1, control2, target);
  const totalLength = Math.max(1, (hasStem ? stem.length : 0) + attackLength);
  const ropeRestPercent = ((hasStem ? stem.length : 0) / totalLength) * 100;
  const revealAt = (attackProgress: number) => (
    ropeRestPercent + (100 - ropeRestPercent) * attackProgress
  );

  return {
    root,
    origin,
    target,
    control1,
    control2,
    pathData,
    vinePathData,
    ropeRestPercent,
    ropeMidPercent: revealAt(0.56),
    ropeNearPercent: revealAt(0.86),
    originCorrectionDeg: normalizeAngle(-normalizeAngle(startTangentDeg + 180))
  };
}
