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
export interface GardenCubicSegment {
  start: GardenPoint;
  control1: GardenPoint;
  control2: GardenPoint;
  end: GardenPoint;
}

/**
 * 把一串首尾相接的三次贝塞尔加粗成一条会变细的填充带。
 *
 * 描边画不出变宽度，而这条带子要同时扮演两个角色：贴在柱子上的那截花茎（粗）
 * 和伸出去的脖子（越伸越细）。宽度沿整条路径按 widths 的采样点插值，所以
 * 「茎」和「脖子」是同一条轮廓上的两段，不存在需要对齐的接缝。
 */
export function buildTaperedRibbonPath(
  segments: GardenCubicSegment[],
  widths: number[],
  stepsPerSegment = 16
): string {
  const upper: GardenPoint[] = [];
  const lower: GardenPoint[] = [];
  const usable = segments.filter(Boolean);
  if (usable.length === 0 || widths.length < 2) return '';

  const widthAt = (progress: number) => {
    const scaled = clampNumber(progress, 0, 1) * (widths.length - 1);
    const index = Math.min(widths.length - 2, Math.floor(scaled));
    const local = scaled - index;
    return widths[index] + (widths[index + 1] - widths[index]) * local;
  };

  const totalSteps = usable.length * stepsPerSegment;
  let emitted = 0;
  usable.forEach((segment, segmentIndex) => {
    const from = segmentIndex === 0 ? 0 : 1;
    for (let step = from; step <= stepsPerSegment; step += 1) {
      const local = step / stepsPerSegment;
      const point = getCubicPoint(
        segment.start,
        segment.control1,
        segment.control2,
        segment.end,
        local
      );
      const ahead = getCubicPoint(
        segment.start,
        segment.control1,
        segment.control2,
        segment.end,
        Math.min(1, local + 0.004)
      );
      const behind = getCubicPoint(
        segment.start,
        segment.control1,
        segment.control2,
        segment.end,
        Math.max(0, local - 0.004)
      );
      const tangentX = ahead.x - behind.x;
      const tangentY = ahead.y - behind.y;
      const span = Math.hypot(tangentX, tangentY) || 1;
      const half = widthAt(emitted / totalSteps) / 2;
      const offsetX = (-tangentY / span) * half;
      const offsetY = (tangentX / span) * half;
      upper.push({ x: point.x + offsetX, y: point.y + offsetY });
      lower.push({ x: point.x - offsetX, y: point.y - offsetY });
      emitted += 1;
    }
  });

  const outline = [
    `M ${formatPathPoint(upper[0])}`,
    ...upper.slice(1).map((point) => `L ${formatPathPoint(point)}`),
    ...lower.reverse().map((point) => `L ${formatPathPoint(point)}`),
    'Z'
  ];
  return outline.join(' ');
}

/** 沿直线摆放控制点：一段"就是直的"的三次贝塞尔。 */
export function buildStraightSegment(start: GardenPoint, end: GardenPoint): GardenCubicSegment {
  return {
    start,
    control1: {
      x: start.x + (end.x - start.x) / 3,
      y: start.y + (end.y - start.y) / 3
    },
    control2: {
      x: start.x + (end.x - start.x) * 2 / 3,
      y: start.y + (end.y - start.y) * 2 / 3
    },
    end
  };
}
