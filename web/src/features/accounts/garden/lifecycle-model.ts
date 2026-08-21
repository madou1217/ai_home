export const GARDEN_EMERGE_MS = 560;
export const GARDEN_RETREAT_MS = 520;

export type GardenLifecyclePhase = 'hidden' | 'emerging' | 'visible' | 'retreating';

export interface GardenLifecycleState {
  phase: GardenLifecyclePhase;
  startedAt: number;
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
