import type { AccountTokenUsage } from '@/types';
import {
  TOKEN_CHART_BAR_OFFSET,
  TOKEN_CHART_BAR_WIDTH,
  TOKEN_CHART_BASELINE,
  TOKEN_CHART_SLOT_WIDTH,
  buildTokenUsageMetrics,
  getTokenUsageBarHeight
} from '@/components/account/token-usage-periods';
import type { TokenDropEvent } from './useTokenDropEvents';

export const MAX_GARDEN_PLANTS = 3;
export const GARDEN_EMERGE_MS = 560;
export const GARDEN_RETREAT_MS = 520;
export const GARDEN_HUNT_MS = 1000;
export const GARDEN_BITE_MS = 360;
export const GARDEN_CHEW_MS = 600;
export const GARDEN_RECOVER_MS = 440;
export const GARDEN_ATTACK_MS = GARDEN_HUNT_MS
  + GARDEN_BITE_MS
  + GARDEN_CHEW_MS
  + GARDEN_RECOVER_MS;
export const GARDEN_MISS_MS = 1360;
export const GARDEN_DEFAULT_CATCH_CHANCE = 0.82;
export const GARDEN_STEM_HEIGHT = 19;
export const GARDEN_STEM_WIDTH = 3;
const GARDEN_DESKTOP_SLOT_WIDTH = 46;
const GARDEN_DESKTOP_WIDTH_GUTTER = 2;
const TOKEN_CHART_VIEW_HEIGHT = 38;

export type GardenLifecyclePhase = 'hidden' | 'emerging' | 'visible' | 'retreating';

export interface GardenLifecycleState {
  phase: GardenLifecyclePhase;
  startedAt: number;
}

export type GardenPlantPhase =
  | 'dormant'
  | 'emerging'
  | 'retreating'
  | 'swaying'
  | 'hunting'
  | 'bite'
  | 'chewing'
  | 'recover';

export interface GardenPlantProfile {
  id: string;
  index: number;
  metricKey: string;
  metricIndex: number;
  anchorXPercent: number;
  anchorY: number;
  mobileAnchorY: number;
  stemHeight: number;
  stemWidth: number;
  headHueRotateDeg: number;
  stemColor: string;
  mouthColor: string;
  swayDurationMs: number;
  swayDelayMs: number;
}

export interface GardenLayout {
  columns: number;
  profiles: GardenPlantProfile[];
}

export interface GardenPoint {
  x: number;
  y: number;
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
  pathData: string;
  vinePathData: string;
  ropeRestPercent: number;
  ropeMidPercent: number;
  ropeNearPercent: number;
  originCorrectionDeg: number;
}

export interface GardenJob {
  id: string;
  drop: TokenDropEvent;
  outcome: 'caught' | 'missed';
  reason: 'caught' | 'chance_miss' | 'capacity_miss';
  plantIndex: number | null;
  createdAt: number;
  attackAt: number;
  endsAt: number;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * 管道花生命周期的唯一状态转移器。任务尚未完成时即使上游运行态结束，也必须留在台上。
 */
export function reconcileGardenLifecycle(
  state: GardenLifecycleState,
  {
    requestedActive,
    hasPendingJobs,
    now
  }: {
    requestedActive: boolean;
    hasPendingJobs: boolean;
    now: number;
  }
): GardenLifecycleState {
  const shouldRemainVisible = requestedActive || hasPendingJobs;
  const currentTime = Number.isFinite(now) ? now : state.startedAt;
  const elapsed = Math.max(0, currentTime - state.startedAt);

  switch (state.phase) {
    case 'hidden':
      return shouldRemainVisible
        ? { phase: 'emerging', startedAt: currentTime }
        : state;
    case 'emerging':
      if (!shouldRemainVisible) return { phase: 'retreating', startedAt: currentTime };
      return elapsed >= GARDEN_EMERGE_MS
        ? { phase: 'visible', startedAt: currentTime }
        : state;
    case 'visible':
      return shouldRemainVisible
        ? state
        : { phase: 'retreating', startedAt: currentTime };
    case 'retreating':
      if (shouldRemainVisible) return { phase: 'emerging', startedAt: currentTime };
      return elapsed >= GARDEN_RETREAT_MS
        ? { phase: 'hidden', startedAt: currentTime }
        : state;
    default:
      return { phase: 'hidden', startedAt: currentTime };
  }
}

export function getGardenLifecycleDelayMs(state: GardenLifecycleState, now: number) {
  const duration = state.phase === 'emerging'
    ? GARDEN_EMERGE_MS
    : state.phase === 'retreating'
      ? GARDEN_RETREAT_MS
      : null;
  if (duration === null) return null;
  return Math.max(0, duration - Math.max(0, now - state.startedAt));
}

/** FNV-1a + avalanche：同一账号/事件稳定，不同盐值互相去相关。 */
export function stableGardenRandom(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  const input = parts.map((part) => String(part)).join('\u001f');
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}

function buildPlantProfile(
  accountRef: string,
  metricKey: string,
  metricIndex: number,
  ordinal: number,
  columns: number,
  anchorY: number
): GardenPlantProfile {
  const chartWidth = Math.max(1, columns * TOKEN_CHART_SLOT_WIDTH);
  const desktopChartWidth = columns * GARDEN_DESKTOP_SLOT_WIDTH
    + GARDEN_DESKTOP_WIDTH_GUTTER;
  const desktopScale = Math.min(1, desktopChartWidth / chartWidth);
  const desktopVerticalInset = (
    TOKEN_CHART_VIEW_HEIGHT - TOKEN_CHART_VIEW_HEIGHT * desktopScale
  ) / 2;
  const anchorX = TOKEN_CHART_BAR_OFFSET
    + metricIndex * TOKEN_CHART_SLOT_WIDTH
    + TOKEN_CHART_BAR_WIDTH / 2;

  return {
    id: `plant-${metricKey}-${ordinal}`,
    index: ordinal,
    metricKey,
    metricIndex,
    anchorXPercent: (anchorX / chartWidth) * 100,
    // SVG 默认 preserveAspectRatio="xMidYMid meet"；桌面 46px 槽会同步缩放 Y 轴并垂直居中。
    anchorY: desktopVerticalInset + anchorY * desktopScale,
    mobileAnchorY: anchorY,
    stemHeight: GARDEN_STEM_HEIGHT,
    stemWidth: GARDEN_STEM_WIDTH,
    headHueRotateDeg: Math.round(stableGardenRandom(accountRef, 'head-hue') * 64 - 32),
    stemColor: 'hsl(104 42% 38%)',
    mouthColor: 'hsl(8 52% 28%)',
    swayDurationMs: 2900,
    swayDelayMs: -Math.round(stableGardenRandom(accountRef, ordinal, 'phase') * 2700)
  };
}

/**
 * 把最多三株花钉在真实 Token 柱顶；柱子少于三根时不伪造额外落脚点。
 */
export function buildGardenLayout(accountRef: string, usage: AccountTokenUsage): GardenLayout {
  const metrics = buildTokenUsageMetrics(usage);
  const columns = metrics.length;
  const values = metrics.flatMap(({ value }) => (value === null ? [] : [value]));
  const maximum = Math.max(0, ...values);
  const positiveIndices = metrics
    .map((metric, index) => ({ metric, index }))
    .filter(({ metric }) => Number(metric.value) > 0)
    .map(({ index }) => index);
  const candidates = positiveIndices.length > 0
    ? positiveIndices
    : metrics.map((_metric, index) => index);
  const selected = candidates.length <= MAX_GARDEN_PLANTS
    ? candidates
    : [...candidates]
      .sort((left, right) => (
        stableGardenRandom(accountRef, metrics[left].key, 'anchor')
        - stableGardenRandom(accountRef, metrics[right].key, 'anchor')
      ))
      .slice(0, MAX_GARDEN_PLANTS)
      .sort((left, right) => left - right);

  return {
    columns,
    profiles: selected.map((metricIndex, ordinal) => {
      const metric = metrics[metricIndex];
      const height = getTokenUsageBarHeight(metric.value, maximum);
      return buildPlantProfile(
        accountRef,
        metric.key,
        metricIndex,
        ordinal,
        columns,
        TOKEN_CHART_BASELINE - height
      );
    })
  };
}

export function pruneGardenJobs(jobs: GardenJob[], now: number, plantCount: number) {
  return jobs.filter((job) => (
    job.endsAt > now
    && (job.plantIndex === null || job.plantIndex < plantCount)
  ));
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

function normalizeAngle(angleDeg: number) {
  return ((angleDeg + 180) % 360 + 360) % 360 - 180;
}

function formatPathNumber(value: number) {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatPathPoint(point: GardenPoint) {
  return `${formatPathNumber(point.x)} ${formatPathNumber(point.y)}`;
}

function getPointDistance(left: GardenPoint, right: GardenPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function getCubicPoint(
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

function approximateCubicLength(
  start: GardenPoint,
  control1: GardenPoint,
  control2: GardenPoint,
  end: GardenPoint
) {
  let length = 0;
  let previous = start;
  for (let step = 1; step <= 18; step += 1) {
    const point = getCubicPoint(start, control1, control2, end, step / 18);
    length += getPointDistance(previous, point);
    previous = point;
  }
  return length;
}

/**
 * 待机头到伤害值生成一条三次贝塞尔攻击路径：先上扬越过卡片，再从目标上方俯冲。
 * vinePathData 再把真实柱顶根部和攻击路径串成一个连续 SVG path；头部与吞咽凸起
 * 复用攻击段 pathData，避免根茎、头部和食团各走一套几何后产生接缝。
 */
export function buildGardenAttackGeometry(
  origin: GardenPoint,
  target: GardenPoint,
  root: GardenPoint = origin
): GardenAttackGeometry {
  const deltaX = target.x - origin.x;
  const deltaY = target.y - origin.y;
  const horizontalSpan = Math.abs(deltaX);
  const verticalSpan = Math.abs(deltaY);
  const arcLift = clamp(horizontalSpan * 0.22 + verticalSpan * 0.08, 64, 132);
  const apexY = Math.max(10, Math.min(origin.y, target.y) - arcLift);

  // 移动端两列可能近乎垂直排列；给窄路径一个侧向弯折，避免退化成上下直线。
  const lateralDirection = target.x <= origin.x ? -1 : 1;
  const lateralBend = lateralDirection * clamp(48 - horizontalSpan, 0, 34);
  const control1 = {
    x: origin.x + deltaX * 0.17 + lateralBend,
    y: apexY
  };
  const control2 = {
    x: origin.x + deltaX * 0.86 + lateralBend * 0.28,
    y: Math.min(target.y - 24, apexY + arcLift * 0.14)
  };
  const startTangentDeg = Math.atan2(
    control1.y - origin.y,
    control1.x - origin.x
  ) * 180 / Math.PI;
  const originOffsetRotationDeg = normalizeAngle(startTangentDeg + 180);
  const pathData = [
    `M ${formatPathPoint(origin)}`,
    `C ${formatPathPoint(control1)} ${formatPathPoint(control2)} ${formatPathPoint(target)}`
  ].join(' ');
  const rootSpan = getPointDistance(root, origin);
  // 根部到待机头严格沿植株当前轴线，Portal 绳索覆盖原花茎时不会出现双线或接缝。
  const rootControl1 = {
    x: root.x + (origin.x - root.x) / 3,
    y: root.y + (origin.y - root.y) / 3
  };
  const rootControl2 = {
    x: root.x + (origin.x - root.x) * 2 / 3,
    y: root.y + (origin.y - root.y) * 2 / 3
  };
  const hasRootSegment = rootSpan > 0.5;
  const vinePathData = hasRootSegment
    ? [
      `M ${formatPathPoint(root)}`,
      `C ${formatPathPoint(rootControl1)} ${formatPathPoint(rootControl2)} ${formatPathPoint(origin)}`,
      `C ${formatPathPoint(control1)} ${formatPathPoint(control2)} ${formatPathPoint(target)}`
    ].join(' ')
    : pathData;
  const rootLength = hasRootSegment
    ? approximateCubicLength(root, rootControl1, rootControl2, origin)
    : 0;
  const attackLength = approximateCubicLength(origin, control1, control2, target);
  const totalLength = Math.max(1, rootLength + attackLength);
  const ropeRestPercent = (rootLength / totalLength) * 100;
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
    // motion-path 会让嘴朝行进方向；在柱顶用反向补偿恢复原位朝向。
    originCorrectionDeg: normalizeAngle(-originOffsetRotationDeg)
  };
}

/**
 * 无队列抢食调度：每个新伤害只看当前空闲花；容量不足或命中失败立即落下。
 */
export function scheduleGardenDrops({
  accountRef,
  drops,
  profiles,
  jobs = [],
  now,
  catchChance = GARDEN_DEFAULT_CATCH_CHANCE,
  minimumDelayMs = 0
}: {
  accountRef: string;
  drops: TokenDropEvent[];
  profiles: GardenPlantProfile[];
  jobs?: GardenJob[];
  now: number;
  catchChance?: number;
  minimumDelayMs?: number;
}): { jobs: GardenJob[]; scheduled: GardenJob[] } {
  const retained = pruneGardenJobs(jobs, now, profiles.length);
  const knownDropIds = new Set(retained.map((job) => job.drop.id));
  const busyPlants = new Set(
    retained
      .filter((job) => job.outcome === 'caught' && job.plantIndex !== null)
      .map((job) => job.plantIndex as number)
  );
  const chance = clamp(Number(catchChance) || 0, 0, 1);
  const baseDelay = Math.max(0, Math.round(Number(minimumDelayMs) || 0));
  const scheduled: GardenJob[] = [];
  const orderedDrops = [...drops].sort((left, right) => (
    Number(left.occurredAt || 0) - Number(right.occurredAt || 0)
    || String(left.id).localeCompare(String(right.id))
  ));

  orderedDrops.forEach((drop) => {
    if (!drop?.id || knownDropIds.has(drop.id)) return;
    knownDropIds.add(drop.id);
    const available = profiles
      .map((_profile, index) => index)
      .filter((index) => !busyPlants.has(index));
    const catches = available.length > 0
      && stableGardenRandom(accountRef, drop.id, 'catch') < chance;
    const plantIndex = catches
      ? available[Math.floor(stableGardenRandom(accountRef, drop.id, 'plant') * available.length)]
      : null;
    const delayMs = baseDelay + Math.round(stableGardenRandom(accountRef, drop.id, 'delay') * 120);
    const outcome = plantIndex === null ? 'missed' : 'caught';
    const reason = plantIndex !== null
      ? 'caught'
      : available.length === 0
        ? 'capacity_miss'
        : 'chance_miss';
    if (plantIndex !== null) busyPlants.add(plantIndex);
    const attackAt = now + delayMs;
    scheduled.push({
      id: `garden-${drop.id}`,
      drop,
      outcome,
      reason,
      plantIndex,
      createdAt: now,
      attackAt,
      endsAt: attackAt + (outcome === 'caught' ? GARDEN_ATTACK_MS : GARDEN_MISS_MS)
    });
  });

  return { jobs: [...retained, ...scheduled], scheduled };
}

export function getGardenPlantPhase({
  lifecycle,
  now,
  job
}: {
  lifecycle: GardenLifecyclePhase;
  now: number;
  job?: GardenJob;
}): GardenPlantPhase {
  if (lifecycle === 'hidden') return 'dormant';
  if (lifecycle === 'emerging') return 'emerging';
  if (lifecycle === 'retreating') return 'retreating';
  if (!job || job.outcome !== 'caught' || job.endsAt <= now) return 'swaying';
  if (now < job.attackAt) return 'hunting';
  const elapsed = now - job.attackAt;
  if (elapsed < GARDEN_HUNT_MS) return 'hunting';
  if (elapsed < GARDEN_HUNT_MS + GARDEN_BITE_MS) return 'bite';
  if (elapsed < GARDEN_HUNT_MS + GARDEN_BITE_MS + GARDEN_CHEW_MS) return 'chewing';
  return 'recover';
}
