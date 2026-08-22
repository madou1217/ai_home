import { stableGardenRandom } from './stable-random';
import {
  buildCubicPathData,
  buildStraightSegment,
  buildTaperedRibbonPath,
  clampNumber,
  getPointDistance
} from './vine-geometry';
import type { GardenPoint } from './vine-geometry';

/**
 * 咽喉到嘴的距离（头的 viewBox 里 12 - 2.6）。
 *
 * 藤蔓末端连的是脖子（咽喉），而咬中的应该是嘴。两者相差这一段，所以路径终点
 * 要比伤害数字往回收这么多：咽喉停在收回来的点上，嘴正好落在数字上。
 */
const HEAD_THROAT_TO_MOUTH = 9.4;

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
  origin: GardenPoint;
  target: GardenPoint;
  control1: GardenPoint;
  control2: GardenPoint;
  /** 扑出去的那一段中心线，供头部 motion-path 使用。 */
  pathData: string;
  /** 柱顶 → 茎顶 → 目标的完整中心线，供 reveal 遮罩使用。 */
  vinePathData: string;
  /** 同一条路径的锥形填充轮廓：根部是茎宽，末端收细成脖子。 */
  vineRibbonPath: string;
  /** 花茎那一段占整条藤的比例；reveal 从这里开始往外伸。 */
  ropeRestPercent: number;
  ropeMidPercent: number;
  ropeNearPercent: number;
  /** motion-path 会让嘴朝行进方向；待机点用反向补偿恢复原地朝向。 */
  originCorrectionDeg: number;
  /** 嘴叼着东西往回缩的方向（单位向量）：伤害数字要顺着它被带走。 */
  retreatX: number;
  retreatY: number;
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
 * 从柱顶一路画到伤害值的一整条藤：先是贴着柱子的那截花茎，再上扬越过卡片，
 * 最后从目标上方俯冲下去。
 *
 * 茎和脖子是同一条轮廓上的两段，不是两个渲染器——攻击期间原地植株整株让位，
 * 画面上从头到尾只有这一条。宽度从根部的茎宽一路收到脖子末端，所以「茎变成
 * 脖子」是连续的，中间没有可以对不齐的接缝。
 */
export function buildGardenAttackGeometry(
  origin: GardenPoint,
  target: GardenPoint,
  root: GardenPoint = origin,
  stemBaseWidth = 6.5,
  stemTipWidth = 4
): GardenAttackGeometry {
  const deltaX = target.x - origin.x;
  const deltaY = target.y - origin.y;
  const horizontalSpan = Math.abs(deltaX);
  const span = Math.hypot(deltaX, deltaY);

  /*
   * 上扬高度跟着实际距离走，不再写死一个下限。
   *
   * 桌面上剩余额度在右边一列，要横跨过去，所以先高高上扬再俯冲；手机上它就在
   * 花的正上方，抬头就够得着——硬套 64px 的上扬会让脖子先冲出卡片顶部再拐回来。
   */
  const arcLift = clampNumber(span * 0.26, 12, 132);
  const apexY = Math.max(6, Math.min(origin.y, target.y) - arcLift);

  /*
   * 近乎垂直的路径给一点侧向弯折，避免退化成一根上下直线；但弯折量必须跟着
   * 路径长度走——手机上目标就在正上方 70px，硬弯 34px 会把脖子甩出一个大圈。
   */
  const lateralDirection = target.x <= origin.x ? -1 : 1;
  const lateralBend = lateralDirection * clampNumber(
    48 - horizontalSpan,
    0,
    Math.min(34, span * 0.2)
  );
  // 目标越靠上，俯冲段越短：贴着目标上方一点点收住即可。
  const diveDrop = clampNumber(span * 0.12, 6, 24);
  const control1 = {
    x: origin.x + deltaX * 0.17 + lateralBend,
    y: apexY
  };
  const control2 = {
    x: origin.x + deltaX * 0.86 + lateralBend * 0.28,
    y: Math.min(target.y - diveDrop, apexY + arcLift * 0.14)
  };
  // 终点收到咽喉该停的地方；嘴因此落在伤害数字上，脖子也不会脱节。
  const approachX = target.x - control2.x;
  const approachY = target.y - control2.y;
  const approachSpan = Math.hypot(approachX, approachY) || 1;
  const neckEnd = {
    x: target.x - (approachX / approachSpan) * HEAD_THROAT_TO_MOUTH,
    y: target.y - (approachY / approachSpan) * HEAD_THROAT_TO_MOUTH
  };
  const pathData = buildCubicPathData(origin, control1, control2, neckEnd);
  const startTangentDeg = Math.atan2(
    control1.y - origin.y,
    control1.x - origin.x
  ) * 180 / Math.PI;

  // 根 → 茎顶那一段就是原地那根花茎的位置，攻击时由这条藤自己接管。
  const stemSpan = getPointDistance(root, origin);
  const hasStem = stemSpan > 0.5;
  const stemSegment = buildStraightSegment(root, origin);
  const neckSegment = { start: origin, control1, control2, end: neckEnd };
  const vineRibbonPath = buildTaperedRibbonPath(
    hasStem ? [stemSegment, neckSegment] : [neckSegment],
    hasStem
      ? [stemBaseWidth, stemTipWidth, Math.max(1.6, stemTipWidth * 0.45)]
      : [stemTipWidth, Math.max(1.6, stemTipWidth * 0.45)],
    16
  );
  const vinePathData = hasStem
    ? [buildCubicPathData(root, stemSegment.control1, stemSegment.control2, origin),
      buildCubicPathData(origin, control1, control2, neckEnd).replace(/^M [^C]+/, '')].join(' ')
    : pathData;
  // 静止那一段（贴在柱子上的花茎）始终露着，reveal 只负责往外伸的脖子。
  const neckSpan = getPointDistance(origin, neckEnd);
  const ropeRestPercent = hasStem
    ? (stemSpan / Math.max(1, stemSpan + neckSpan)) * 100
    : 0;
  const revealAt = (attackProgress: number) => (
    ropeRestPercent + (100 - ropeRestPercent) * attackProgress
  );

  return {
    origin,
    target,
    control1,
    control2,
    pathData,
    vinePathData,
    vineRibbonPath,
    ropeRestPercent,
    ropeMidPercent: revealAt(0.56),
    ropeNearPercent: revealAt(0.86),
    originCorrectionDeg: normalizeAngle(-normalizeAngle(startTangentDeg + 180)),
    retreatX: -approachX / approachSpan,
    retreatY: -approachY / approachSpan
  };
}
