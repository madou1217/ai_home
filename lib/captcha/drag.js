'use strict';

// 拟人拖动：把「接近 → 按下 → 拖动 → 释放」拆成可单测的纯函数 + 一层 CDP 派发。
//
// 为什么不能直接 `Input.dispatchMouseEvent` 一步到位：阿里云（以及绝大多数滑块
// 风控）会把「瞬移式位移」判成机器行为。2026-11-04 的对照实验里，同样的有头
// 窗口，瞬时点击稳定 F001、贝塞尔轨迹 + 按压停留才给过（见 aliyun-captcha.js
// 头部注释）。拖动比点击更敏感：不仅要有轨迹，还要有「起步慢、中段快、收尾慢」
// 的速度分布，以及少量过冲回弹。
//
// 这里只做几何与派发，不认识任何验证码厂商的 DOM —— 选择器在 aliyun.js 里。

const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function readRng(options) {
  return options && typeof options.rng === 'function' ? options.rng : Math.random;
}

/**
 * 鼠标从屏幕别处移到目标点的轨迹（贝塞尔缓动 + 抖动）。
 * 起点默认在目标左下方 320×260 处 —— 2026-11-04 真机跑通的参数。
 */
function buildApproachPath(options = {}) {
  const target = options.target || { x: 0, y: 0 };
  const rng = readRng(options);
  const steps = Math.max(8, Math.round(Number(options.steps) || 45));
  const offsetX = options.offsetX === undefined ? -320 : Number(options.offsetX);
  const offsetY = options.offsetY === undefined ? 260 : Number(options.offsetY);
  const jitter = options.jitter === undefined ? 3 : Math.max(0, Number(options.jitter));
  const startX = target.x + offsetX;
  const startY = target.y + offsetY;
  const points = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    points.push({
      x: round2(startX + (target.x - startX) * eased + (rng() - 0.5) * jitter),
      y: round2(startY + (target.y - startY) * eased + (rng() - 0.5) * jitter),
      delayMs: Math.round(18 + rng() * 12)
    });
  }
  return points;
}

/**
 * 拖动轨迹：`distance` 是水平总位移（CSS px）。
 *
 * 速度分布用 `1-(1-t)^2.4`：起手快、尾段慢，和真人拖滑块一致；
 * 最后补三段过冲/回弹，避免「停在整数像素上」这种机器特征。
 * 返回值里的 `dx` 单调不减（不会来回抖），`dy` 只有 ±1.2px 的纵向漂移。
 */
function buildDragPoints(options = {}) {
  const distance = Number(options.distance) || 0;
  const rng = readRng(options);
  const steps = Math.max(10, Math.round(Number(options.steps) || (Math.abs(distance) > 160 ? 52 : 36)));
  const overshoot = options.overshoot === undefined
    ? 2 + rng() * 4
    : Math.max(0, Number(options.overshoot));
  const direction = distance >= 0 ? 1 : -1;
  const points = [];
  let progress = 0;
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const eased = 1 - (1 - t) ** 2.4;
    progress = Math.max(progress, Math.min(1, eased + (rng() - 0.5) * 0.01));
    points.push({
      dx: round2(distance * progress),
      dy: round2((rng() - 0.5) * 1.6 + Math.sin(t * Math.PI * 2) * 0.6),
      delayMs: Math.round(9 + rng() * 13)
    });
  }
  if (overshoot > 0) {
    points.push({ dx: round2(distance + direction * overshoot), dy: round2((rng() - 0.5) * 1.2), delayMs: Math.round(40 + rng() * 40) });
    points.push({ dx: round2(distance - direction * overshoot * 0.4), dy: round2((rng() - 0.5) * 1.2), delayMs: Math.round(30 + rng() * 30) });
    points.push({ dx: round2(distance), dy: 0, delayMs: Math.round(60 + rng() * 50) });
  }
  return points;
}

/**
 * 组装一次完整拖动的计划。`origin` 是按下点（滑块把手中心）。
 */
function buildDragPlan(options = {}) {
  const rng = readRng(options);
  const origin = options.origin || { x: 0, y: 0 };
  const distance = Number(options.distance) || 0;
  const points = buildDragPoints({ distance, rng, steps: options.steps, overshoot: options.overshoot });
  return {
    origin,
    distance,
    approach: buildApproachPath({ target: origin, rng }),
    points,
    approachSettleMs: Math.round(100 + rng() * 80),
    pressHoldMs: Math.round(70 + rng() * 60),
    releaseHoldMs: Math.round(120 + rng() * 160)
  };
}

/**
 * 按计划派发鼠标事件。所有坐标都是视口坐标（CDP 的 Input 域就是视口坐标）。
 * `button: 'left' + buttons: 1` 必须成对出现，否则 Chrome 不会把移动当成拖拽。
 */
async function performDrag(cdp, sessionId, plan, options = {}) {
  const sleep = typeof options.sleep === 'function' ? options.sleep : DEFAULT_SLEEP;
  const origin = plan.origin;
  const approach = Array.isArray(plan.approach) ? plan.approach : [];
  for (const point of approach) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y
    }, sessionId);
    await sleep(point.delayMs);
  }
  await sleep(plan.approachSettleMs || 140);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: origin.x,
    y: origin.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  }, sessionId);
  await sleep(plan.pressHoldMs || 90);
  let last = { x: origin.x, y: origin.y };
  for (const point of plan.points || []) {
    last = { x: round2(origin.x + point.dx), y: round2(origin.y + point.dy) };
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: last.x,
      y: last.y,
      button: 'left',
      buttons: 1
    }, sessionId);
    await sleep(point.delayMs);
  }
  await sleep(plan.releaseHoldMs || 150);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: last.x,
    y: last.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  }, sessionId);
}

module.exports = {
  buildApproachPath,
  buildDragPlan,
  buildDragPoints,
  clamp,
  performDrag,
  round2
};
