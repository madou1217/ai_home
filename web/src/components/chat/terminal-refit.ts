export interface TerminalRefitInstance {
  readonly opened: boolean;
  readonly fit: { proposeDimensions(): { cols: number; rows: number } | undefined };
  readonly term: { readonly cols: number; readonly rows: number; resize(cols: number, rows: number): void };
}

export interface TerminalRefitter {
  notifyResize: () => void;
  flush: () => void;
  dispose: () => void;
}

export const TERMINAL_RESIZE_FINISHED = 'aih-terminal-resize-finished';

/**
 * Measure with FitAddon's public API, then resize through xterm's public API.
 * The DOM renderer redraws every row on resize; FitAddon.fit() first clears
 * those same rows, creating unnecessary DOM churn during a drag.
 */
export function fitActiveTerminal(
  instances: ReadonlyMap<string, TerminalRefitInstance>,
  activeId: string,
): void {
  const inst = instances.get(activeId);
  if (!inst || !inst.opened) return;
  try {
    const size = inst.fit.proposeDimensions();
    if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
    if (size.cols !== inst.term.cols || size.rows !== inst.term.rows) inst.term.resize(size.cols, size.rows);
  } catch { /* 容器暂无尺寸 */ }
}

/**
 * 用 requestAnimationFrame 合并高频 ResizeObserver 回调：
 * 拖拽三栏分隔条时容器宽度逐像素变化，同一帧内只 fit 一次激活终端。
 */
export function createTerminalRefitter(
  fitActive: () => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancelRaf: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
  options: {
    minInterval?: () => number;
    now?: () => number;
    setTimer?: (cb: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
    afterFlush?: () => void;
  } = {},
): TerminalRefitter {
  let pendingFrame: number | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let flushRequested = false;
  let lastFit = -Infinity;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const scheduleFrame = () => {
    if (pendingFrame !== null) return;
    pendingFrame = raf(() => {
      pendingFrame = null;
      lastFit = now();
      fitActive();
      if (flushRequested) {
        flushRequested = false;
        options.afterFlush?.();
      }
    });
  };
  return {
    notifyResize() {
      if (pendingFrame !== null || pendingTimer !== null) return;
      const wait = Math.max(0, (options.minInterval?.() || 0) - (now() - lastFit));
      if (wait === 0) scheduleFrame();
      else pendingTimer = setTimer(() => { pendingTimer = null; scheduleFrame(); }, wait);
    },
    flush() {
      if (pendingTimer !== null) clearTimer(pendingTimer);
      pendingTimer = null;
      flushRequested = true;
      scheduleFrame();
    },
    dispose() {
      if (pendingFrame !== null) cancelRaf(pendingFrame);
      if (pendingTimer !== null) clearTimer(pendingTimer);
      pendingFrame = null;
      pendingTimer = null;
      flushRequested = false;
    },
  };
}
