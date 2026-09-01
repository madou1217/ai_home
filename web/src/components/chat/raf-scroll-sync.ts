type RafCallback = () => void;

export interface ScrollSyncHandle {
  notifyScroll: () => void;
  dispose: () => void;
}

/**
 * 用 requestAnimationFrame 合并高频滚动更新：
 * 同一帧内多次 scroll 事件只触发一次 apply，且 apply 时读取最新 scrollTop。
 */
export function createRafScrollSync(
  readScrollTop: () => number,
  applyScrollTop: (value: number) => void,
  raf: (cb: RafCallback) => number = (cb) => requestAnimationFrame(cb),
  cancelRaf: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
): ScrollSyncHandle {
  let pendingFrame: number | null = null;
  return {
    notifyScroll() {
      if (pendingFrame !== null) return;
      pendingFrame = raf(() => {
        pendingFrame = null;
        applyScrollTop(readScrollTop());
      });
    },
    dispose() {
      if (pendingFrame === null) return;
      cancelRaf(pendingFrame);
      pendingFrame = null;
    },
  };
}
