export interface TerminalRefitInstance {
  readonly opened: boolean;
  readonly fit: { fit(): void };
}

export interface TerminalRefitter {
  notifyResize: () => void;
  dispose: () => void;
}

/**
 * fit 当前激活且已挂载的终端实例。
 * 容器尚无尺寸（如隐藏页签）时 FitAddon 抛错，吞掉等下一轮回调。
 */
export function fitActiveTerminal(
  instances: ReadonlyMap<string, TerminalRefitInstance>,
  activeId: string,
): void {
  const inst = instances.get(activeId);
  if (!inst || !inst.opened) return;
  try { inst.fit.fit(); } catch { /* 容器暂无尺寸 */ }
}

/**
 * 用 requestAnimationFrame 合并高频 ResizeObserver 回调：
 * 拖拽三栏分隔条时容器宽度逐像素变化，同一帧内只 fit 一次激活终端。
 */
export function createTerminalRefitter(
  fitActive: () => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancelRaf: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
): TerminalRefitter {
  let pendingFrame: number | null = null;
  return {
    notifyResize() {
      if (pendingFrame !== null) return;
      pendingFrame = raf(() => {
        pendingFrame = null;
        fitActive();
      });
    },
    dispose() {
      if (pendingFrame === null) return;
      cancelRaf(pendingFrame);
      pendingFrame = null;
    },
  };
}
