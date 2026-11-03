'use strict';

/**
 * 极简 SVG 单路径栅格化：解析 path 的 d（M/L/H/V/C/S/Q/T/A/Z 及其相对形式），
 * 把曲线与弧线展开为折线，按非零环绕规则判定点是否在填充区域内。
 *
 * 只服务 scripts/gen-provider-icons.js：仓库里没有 SVG 栅格化依赖（无 sharp / rsvg / cairo），
 * 引入二进制依赖不划算；品牌图标都是单色单路径，这点能力就够。
 */

const CURVE_STEPS = 24;

function tokenize(d) {
  const tokens = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let match;
  while ((match = re.exec(String(d || ''))) !== null) {
    tokens.push(match[1] ? match[1] : Number(match[2]));
  }
  return tokens;
}

// SVG 弧线（端点参数化）→ 中心参数化后采样，见 SVG 1.1 附录 F.6.5。
function arcPoints(x1, y1, rx, ry, rotationDeg, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return [[x2, y2]];
  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  let arx = Math.abs(rx);
  let ary = Math.abs(ry);
  const lambda = (x1p * x1p) / (arx * arx) + (y1p * y1p) / (ary * ary);
  if (lambda > 1) {
    arx *= Math.sqrt(lambda);
    ary *= Math.sqrt(lambda);
  }
  const num = arx * arx * ary * ary - arx * arx * y1p * y1p - ary * ary * x1p * x1p;
  const den = arx * arx * y1p * y1p + ary * ary * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * arx * y1p) / ary;
  const cyp = (-coef * ary * x1p) / arx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / arx, (y1p - cyp) / ary);
  let delta = angle((x1p - cxp) / arx, (y1p - cyp) / ary, (-x1p - cxp) / arx, (-y1p - cyp) / ary);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const points = [];
  for (let i = 1; i <= CURVE_STEPS; i += 1) {
    const t = theta1 + (delta * i) / CURVE_STEPS;
    const px = arx * Math.cos(t);
    const py = ary * Math.sin(t);
    points.push([cos * px - sin * py + cx, sin * px + cos * py + cy]);
  }
  return points;
}

function cubicPoints(x0, y0, x1, y1, x2, y2, x3, y3) {
  const points = [];
  for (let i = 1; i <= CURVE_STEPS; i += 1) {
    const t = i / CURVE_STEPS;
    const mt = 1 - t;
    points.push([
      mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
      mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3
    ]);
  }
  return points;
}

/** 把 d 展开为若干闭合多边形（设计坐标）。 */
function pathToPolygons(d) {
  const tokens = tokenize(d);
  const polygons = [];
  let current = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl = null;
  let command = '';
  let i = 0;
  const next = () => tokens[i++];
  const hasNumber = () => typeof tokens[i] === 'number';
  const lineTo = (nx, ny) => { current.push([nx, ny]); x = nx; y = ny; };

  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') command = next();
    const rel = command === command.toLowerCase();
    const upper = command.toUpperCase();
    if (upper === 'Z') {
      if (current && current.length > 2) polygons.push(current);
      current = null;
      x = startX;
      y = startY;
      lastControl = null;
      continue;
    }
    if (!hasNumber()) break;
    if (upper === 'M') {
      if (current && current.length > 2) polygons.push(current);
      x = (rel ? x : 0) + next();
      y = (rel ? y : 0) + next();
      startX = x;
      startY = y;
      current = [[x, y]];
      command = rel ? 'l' : 'L';
      lastControl = null;
      continue;
    }
    if (!current) current = [[x, y]];
    if (upper === 'L') {
      const nx = (rel ? x : 0) + next();
      const ny = (rel ? y : 0) + next();
      lineTo(nx, ny);
      lastControl = null;
    } else if (upper === 'H') {
      lineTo((rel ? x : 0) + next(), y);
      lastControl = null;
    } else if (upper === 'V') {
      lineTo(x, (rel ? y : 0) + next());
      lastControl = null;
    } else if (upper === 'C' || upper === 'S') {
      let c1x;
      let c1y;
      if (upper === 'C') {
        c1x = (rel ? x : 0) + next();
        c1y = (rel ? y : 0) + next();
      } else {
        c1x = lastControl ? 2 * x - lastControl[0] : x;
        c1y = lastControl ? 2 * y - lastControl[1] : y;
      }
      const c2x = (rel ? x : 0) + next();
      const c2y = (rel ? y : 0) + next();
      const ex = (rel ? x : 0) + next();
      const ey = (rel ? y : 0) + next();
      current.push(...cubicPoints(x, y, c1x, c1y, c2x, c2y, ex, ey));
      lastControl = [c2x, c2y];
      x = ex;
      y = ey;
    } else if (upper === 'Q' || upper === 'T') {
      let qx;
      let qy;
      if (upper === 'Q') {
        qx = (rel ? x : 0) + next();
        qy = (rel ? y : 0) + next();
      } else {
        qx = lastControl ? 2 * x - lastControl[0] : x;
        qy = lastControl ? 2 * y - lastControl[1] : y;
      }
      const ex = (rel ? x : 0) + next();
      const ey = (rel ? y : 0) + next();
      current.push(...cubicPoints(x, y, x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
        ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey));
      lastControl = [qx, qy];
      x = ex;
      y = ey;
    } else if (upper === 'A') {
      const rx = next();
      const ry = next();
      const rotation = next();
      const largeArc = Boolean(next());
      const sweep = Boolean(next());
      const ex = (rel ? x : 0) + next();
      const ey = (rel ? y : 0) + next();
      current.push(...arcPoints(x, y, rx, ry, rotation, largeArc, sweep, ex, ey));
      x = ex;
      y = ey;
      lastControl = null;
    } else {
      throw new Error(`unsupported path command: ${command}`);
    }
  }
  if (current && current.length > 2) polygons.push(current);
  return polygons;
}

/** 非零环绕：点在任一方向净穿越次数非零即在内部。 */
function insidePolygons(polygons, px, py) {
  let winding = 0;
  for (const polygon of polygons) {
    for (let k = 0; k < polygon.length; k += 1) {
      const [ax, ay] = polygon[k];
      const [bx, by] = polygon[(k + 1) % polygon.length];
      if (ay <= py) {
        if (by > py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) > 0) winding += 1;
      } else if (by <= py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) < 0) {
        winding -= 1;
      }
    }
  }
  return winding !== 0;
}

/** 从单路径 SVG 文本中取 viewBox、d 与填充色。 */
function parseSingleColorSvg(text) {
  const viewBox = (String(text).match(/viewBox="([^"]+)"/) || [])[1];
  const d = (String(text).match(/\sd="([^"]+)"/) || [])[1];
  const fill = (String(text).match(/<path[^>]*\sfill="#([0-9a-fA-F]{6})"/) || [])[1];
  if (!viewBox || !d || !fill) throw new Error('svg must have viewBox, one path d and a #rrggbb fill');
  const [minX, minY, width, height] = viewBox.trim().split(/[\s,]+/).map(Number);
  const rgb = [0, 2, 4].map((offset) => parseInt(fill.slice(offset, offset + 2), 16));
  return { minX, minY, width, height, d, rgb };
}

module.exports = { pathToPolygons, insidePolygons, parseSingleColorSvg };
