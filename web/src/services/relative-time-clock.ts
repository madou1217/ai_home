export interface RelativeTimeClockEnv {
  now: () => number;
  isVisible: () => boolean;
  startTimer: (tick: () => void) => () => void;
  watchVisibility: (update: () => void) => () => void;
}

/** 所有相对时间共用一个时钟；后台暂停，回到前台立即校准。 */
export function createRelativeTimeClock(env: RelativeTimeClockEnv) {
  const listeners = new Set<() => void>();
  let snapshot = env.now();
  let stopTimer: (() => void) | null = null;
  let stopVisibilityWatch: (() => void) | null = null;

  const tick = () => {
    const next = env.now();
    if (next === snapshot) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const updateVisibility = () => {
    if (!env.isVisible()) {
      stopTimer?.();
      stopTimer = null;
      return;
    }
    tick();
    if (!stopTimer && listeners.size > 0) stopTimer = env.startTimer(tick);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stopVisibilityWatch = env.watchVisibility(updateVisibility);
        updateVisibility();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopTimer?.();
        stopTimer = null;
        stopVisibilityWatch?.();
        stopVisibilityWatch = null;
      };
    },
  };
}

export const relativeTimeClock = createRelativeTimeClock({
  now: () => Date.now(),
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  startTimer: (tick) => {
    const timer = setInterval(tick, 30000);
    return () => clearInterval(timer);
  },
  watchVisibility: (update) => {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  },
});
