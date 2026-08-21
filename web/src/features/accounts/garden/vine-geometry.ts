export interface GardenPoint {
  x: number;
  y: number;
}

export interface GardenVineSegment {
  root: GardenPoint;
  head: GardenPoint;
  control1: GardenPoint;
  control2: GardenPoint;
  pathData: string;
  length: number;
}

export function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function formatPathNumber(value: number) {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatPathPoint(point: GardenPoint) {
  return `${formatPathNumber(point.x)} ${formatPathNumber(point.y)}`;
}

export function getPointDistance(left: GardenPoint, right: GardenPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

export function getCubicPoint(
  start: GardenPoint,
  control1: GardenPoint,
  control2: GardenPoint,
  end: GardenPoint,
  progress: number
): GardenPoint {
  const inverse = 1 - progress;
  return {
    x: inverse ** 3 * start.x
      + 3 * inverse ** 2 * progress * control1.x
      + 3 * inverse * progress ** 2 * control2.x
      + progress ** 3 * end.x,
    y: inverse ** 3 * start.y
      + 3 * inverse ** 2 * progress * control1.y
      + 3 * inverse * progress ** 2 * control2.y
      + progress ** 3 * end.y
  };
}

export function approximateCubicLength(
  start: GardenPoint,
  control1: GardenPoint,
  control2: GardenPoint,
  end: GardenPoint,
  steps = 18
) {
  let length = 0;
  let previous = start;
  for (let step = 1; step <= steps; step += 1) {
    const point = getCubicPoint(start, control1, control2, end, step / steps);
    length += getPointDistance(previous, point);
    previous = point;
  }
  return length;
}

export function buildCubicPathData(
  start: GardenPoint,
  control1: GardenPoint,
  control2: GardenPoint,
  end: GardenPoint
) {
  return [
    `M ${formatPathPoint(start)}`,
    `C ${formatPathPoint(control1)} ${formatPathPoint(control2)} ${formatPathPoint(end)}`
  ].join(' ');
}

/**
 * 花茎的唯一几何来源：一段从柱顶（root）弯到花头（head）的三次贝塞尔。
 *
 * 待机时的花茎和捕食时藤蔓的起始段都由这里生成——两处用同一个函数、同一份
 * bend，藤蔓覆盖到原花茎上时不会出现双线或者接缝。之前那套 root 控制点三分点
 * 近似 + 朝向补偿，存在的唯一目的就是手工对齐两套渲染器，现在不需要了。
 *
 * bend 是垂直于根→头方向的弯曲量（px）：正值往行进方向右侧鼓，让茎有弧度而不是
 * 一根直棍；0 就是一条直线段。
 */
export function buildVineSegment(
  root: GardenPoint,
  head: GardenPoint,
  bend = 0
): GardenVineSegment {
  const deltaX = head.x - root.x;
  const deltaY = head.y - root.y;
  const span = Math.hypot(deltaX, deltaY);
  const normalX = span > 0 ? -deltaY / span : 0;
  const normalY = span > 0 ? deltaX / span : 0;
  const control1 = {
    x: root.x + deltaX * 0.34 + normalX * bend,
    y: root.y + deltaY * 0.34 + normalY * bend
  };
  const control2 = {
    x: root.x + deltaX * 0.72 + normalX * bend * 0.55,
    y: root.y + deltaY * 0.72 + normalY * bend * 0.55
  };

  return {
    root,
    head,
    control1,
    control2,
    pathData: buildCubicPathData(root, control1, control2, head),
    length: approximateCubicLength(root, control1, control2, head)
  };
}
