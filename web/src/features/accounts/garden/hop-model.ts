import type { GardenPerch } from './perch-model';
import { resolvePerchIndex } from './perch-model';
import { stableGardenRandom, stableGardenRange } from './stable-random';

/**
 * 一次跳跃的总时长。它不只是"在空中的时间"：起跳前的蓄力和落地后的回弹都算
 * 在里面（见 plant.css 的时间轴），少了这两头，跳跃看着就是平移贴图。
 */
export const GARDEN_HOP_FLIGHT_MS = 780;
/** 两次跳跃之间的停留区间——固定间隔会看出节拍，所以按账号+跳次取随机值。 */
export const GARDEN_HOP_MIN_IDLE_MS = 2600;
export const GARDEN_HOP_MAX_IDLE_MS = 6200;

export type HopPhase = 'settled' | 'airborne';

export interface HopState {
  phase: HopPhase;
  /** 落脚点身份：柱子重排后靠它认路，而不是靠序号。 */
  perchMetricKey: string;
  perchIndex: number;
  /** 起跳点，仅 airborne 期间有意义（渲染抛物线要两端）。 */
  fromPerchIndex: number;
  /** 单调递增的跳跃序号：跳跃目标的随机盐，保证同一次跳跃重渲染不变。 */
  hopIndex: number;
  /** 当前相位的起点。 */
  startedAt: number;
  /** settled 期间的下一次起跳时刻。 */
  nextHopAt: number;
}

export interface HopReconcileInput {
  accountRef: string;
  perches: GardenPerch[];
  now: number;
  /** 出场未完成或正在捕食时不跳：花不能咬着东西飞走。 */
  canHop: boolean;
}

function scheduleNextHop(accountRef: string, hopIndex: number, now: number) {
  return now + Math.round(stableGardenRange(
    GARDEN_HOP_MIN_IDLE_MS,
    GARDEN_HOP_MAX_IDLE_MS,
    accountRef,
    hopIndex,
    'hop-idle'
  ));
}

export function createHopState(
  accountRef: string,
  perches: GardenPerch[],
  now: number
): HopState {
  const perchIndex = perches.length === 0
    ? -1
    : Math.floor(stableGardenRandom(accountRef, 'hop-seat') * perches.length) % perches.length;
  return {
    phase: 'settled',
    perchMetricKey: perchIndex >= 0 ? perches[perchIndex].metricKey : '',
    perchIndex,
    fromPerchIndex: perchIndex,
    hopIndex: 0,
    startedAt: now,
    nextHopAt: scheduleNextHop(accountRef, 0, now)
  };
}

/**
 * 从当前落脚点之外挑一根柱子。只有一根柱子时返回当前值——原地摇摆，不做零距离跳。
 */
export function pickHopTarget(
  accountRef: string,
  hopIndex: number,
  perchCount: number,
  currentIndex: number
): number {
  if (perchCount <= 1) return currentIndex;
  const candidates: number[] = [];
  for (let index = 0; index < perchCount; index += 1) {
    if (index !== currentIndex) candidates.push(index);
  }
  const pick = Math.floor(
    stableGardenRandom(accountRef, hopIndex, 'hop-target') * candidates.length
  );
  return candidates[Math.min(pick, candidates.length - 1)];
}

/**
 * 跳跃状态的唯一转移器：落脚点失效就重新落座，到点就起跳，飞完就落地。
 * 纯函数（时间由外部传入），所以"柱子被折叠掉"这类边界可以直接单测。
 */
export function reconcileHopState(
  state: HopState,
  { accountRef, perches, now, canHop }: HopReconcileInput
): HopState {
  if (perches.length === 0) {
    return state.perchIndex === -1
      ? state
      : {
        ...state,
        phase: 'settled',
        perchIndex: -1,
        fromPerchIndex: -1,
        perchMetricKey: ''
      };
  }

  // 脚下的柱子可能整根消失（用量变化触发折叠）；先重新落座，绝不悬空。
  const seatedIndex = resolvePerchIndex(perches, state.perchMetricKey, state.perchIndex);
  let current = state;
  if (
    seatedIndex !== state.perchIndex
    || perches[seatedIndex].metricKey !== state.perchMetricKey
  ) {
    current = {
      ...state,
      // 重新落座不是一次跳跃：立刻贴到新柱顶，不播抛物线。
      phase: 'settled',
      perchIndex: seatedIndex,
      fromPerchIndex: seatedIndex,
      perchMetricKey: perches[seatedIndex].metricKey,
      startedAt: now,
      nextHopAt: Math.max(state.nextHopAt, now + GARDEN_HOP_MIN_IDLE_MS)
    };
  }

  if (current.phase === 'airborne') {
    if (now - current.startedAt < GARDEN_HOP_FLIGHT_MS) return current;
    return {
      ...current,
      phase: 'settled',
      fromPerchIndex: current.perchIndex,
      startedAt: now,
      nextHopAt: scheduleNextHop(accountRef, current.hopIndex, now)
    };
  }

  if (!canHop || perches.length <= 1 || now < current.nextHopAt) return current;

  const hopIndex = current.hopIndex + 1;
  const target = pickHopTarget(accountRef, hopIndex, perches.length, current.perchIndex);
  if (target === current.perchIndex) return current;
  return {
    phase: 'airborne',
    perchMetricKey: perches[target].metricKey,
    perchIndex: target,
    fromPerchIndex: current.perchIndex,
    hopIndex,
    startedAt: now,
    nextHopAt: now + GARDEN_HOP_FLIGHT_MS
  };
}

/** 下一次需要唤醒的间隔；null 表示当前状态不靠时间推进（例如只有一根柱子）。 */
export function getHopDelayMs(
  state: HopState,
  { perchCount, now, canHop }: { perchCount: number; now: number; canHop: boolean }
): number | null {
  if (perchCount === 0) return null;
  if (state.phase === 'airborne') {
    return Math.max(0, GARDEN_HOP_FLIGHT_MS - (now - state.startedAt));
  }
  if (!canHop || perchCount <= 1) return null;
  return Math.max(0, state.nextHopAt - now);
}
