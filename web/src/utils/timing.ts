/**
 * 防抖 / 节流工具（统一交互节流标准）。
 * - debounce：停止触发后延迟 wait 才执行，适合搜索输入、resize。
 * - throttle：每 wait 最多执行一次，适合 scroll、mousemove 等高频事件。
 * 详见 web/DESIGN.md「交互 · 防抖」。
 */

export interface Debounced<A extends any[]> {
  (...args: A): void;
  cancel: () => void;
  flush: () => void;
}

export function debounce<A extends any[]>(fn: (...args: A) => void, wait = 200): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const debounced = ((...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs) fn(...lastArgs);
      lastArgs = null;
    }, wait);
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.flush = () => {
    if (timer && lastArgs) {
      clearTimeout(timer);
      timer = null;
      fn(...lastArgs);
      lastArgs = null;
    }
  };

  return debounced;
}

export function throttle<A extends any[]>(fn: (...args: A) => void, wait = 100): Debounced<A> {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const invoke = (time: number) => {
    last = time;
    if (lastArgs) fn(...lastArgs);
    lastArgs = null;
  };

  const throttled = ((...args: A) => {
    lastArgs = args;
    // Date.now 在浏览器可用；这里仅做时间节流，不影响 SSR。
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      invoke(now);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        invoke(Date.now());
      }, remaining);
    }
  }) as Debounced<A>;

  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = 0;
    lastArgs = null;
  };
  throttled.flush = () => {
    if (lastArgs) invoke(Date.now());
  };

  return throttled;
}
