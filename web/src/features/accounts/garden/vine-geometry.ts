export interface GardenPoint {
  x: number;
  y: number;
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
 * 把一条三次贝塞尔加粗成锥形的填充带：起点宽 startWidth、终点宽 endWidth。
 *
 * 描边画不出变宽度，而伸出去的藤蔓必须接住花茎顶端的粗细——否则一根锥形的茎上
 * 突然接一条等宽的弧线，接缝处怎么调都别扭。这里沿曲线采样法线，走一遍上沿、
 * 回一遍下沿，闭合成一条真正会变细的带子。
 */
export function buildTaperedRibbonPath(
  start: GardenPoint,
  control1: GardenPoint,
  control2: GardenPoint,
  end: GardenPoint,
  startWidth: number,
  endWidth: number,
  steps = 22
): string {
  const upper: GardenPoint[] = [];
  const lower: GardenPoint[] = [];

  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const point = getCubicPoint(start, control1, control2, end, progress);
    const ahead = getCubicPoint(
      start,
      control1,
      control2,
      end,
      Math.min(1, progress + 0.004)
    );
    const behind = getCubicPoint(
      start,
      control1,
      control2,
      end,
      Math.max(0, progress - 0.004)
    );
    const tangentX = ahead.x - behind.x;
    const tangentY = ahead.y - behind.y;
    const span = Math.hypot(tangentX, tangentY) || 1;
    const half = (startWidth + (endWidth - startWidth) * progress) / 2;
    const offsetX = (-tangentY / span) * half;
    const offsetY = (tangentX / span) * half;
    upper.push({ x: point.x + offsetX, y: point.y + offsetY });
    lower.push({ x: point.x - offsetX, y: point.y - offsetY });
  }

  const outline = [
    `M ${formatPathPoint(upper[0])}`,
    ...upper.slice(1).map((point) => `L ${formatPathPoint(point)}`),
    ...lower.reverse().map((point) => `L ${formatPathPoint(point)}`),
    'Z'
  ];
  return outline.join(' ');
}
