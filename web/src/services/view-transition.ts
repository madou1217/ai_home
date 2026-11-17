// 桌面端通用预提交（Pre-Commit）View Transitions 事务经纪人。
//
// 单一职责：协调 theme / route / surface 三类合成器快照事务的生命周期与互斥抢占。
// 路由 history 监听适配独立在 services/route-view-transition.ts。
//
// 核心契约：
// 1. 状态变更（commitImmediate / commitFlush）恰好执行一次（exactly-once）：
//    无论 ready/finished 拒绝、被后续点击抢占、或文档切入后台隐藏，待提交状态立即同步落盘。
// 2. 局部元素使用单调递增的唯一 view-transition-name，在完成、取消、卸载时立即清空，
//    静态停靠态零残留 stacking context；伪元素层 pointer-events: none，不阻塞真实交互。
// 3. 页面隐藏、减少动态效果、移动端 HUD 或终端拖拽调尺寸（html.aih-terminal-resizing）时，
//    严禁启动 ViewTransition 或全表面 WAAPI 位移，仅同步执行状态变更。

import { flushSync } from 'react-dom';

export type ViewTransitionKind = 'theme' | 'route' | 'surface';
export type ViewTransitionDirection = 'forward' | 'backward' | 'neutral';

interface ViewTransitionHandle {
  ready?: Promise<unknown>;
  updateCallbackDone?: Promise<unknown>;
  finished?: Promise<unknown>;
  skipTransition?: () => void;
}

export type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => ViewTransitionHandle;
};

interface ActiveTransaction {
  handle: ViewTransitionHandle | null;
  targetElement: HTMLElement | null;
  commitFlush: () => void;
  commitImmediate: () => void;
  cleanup: () => void;
}

const fallbackAnimations = new WeakMap<HTMLElement, Animation>();

let activeTransaction: ActiveTransaction | null = null;
let surfaceNameSeq = 0;
let visibilityListenerInstalled = false;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_error) {
    return false;
  }
}

export function isMobileHudActive(doc: Document): boolean {
  return doc.documentElement.hasAttribute('data-mobile-hud');
}

function isDocumentVisibleAndStable(doc: Document | null): doc is Document {
  if (!doc) return false;
  if (doc.hidden) return false;
  if (typeof doc.visibilityState === 'string' && doc.visibilityState !== 'visible') return false;
  if (doc.documentElement.classList.contains('aih-terminal-resizing')) return false;
  return true;
}

export function canStartCompositorTransition(
  doc: ViewTransitionDocument | null,
): doc is ViewTransitionDocument & {
  startViewTransition: (update: () => void | Promise<void>) => ViewTransitionHandle;
} {
  if (!isDocumentVisibleAndStable(doc)) return false;
  if (typeof doc.startViewTransition !== 'function') return false;
  if (prefersReducedMotion()) return false;
  return true;
}

function observePromise(
  promise: Promise<unknown> | undefined,
  onRejected?: () => void,
  onSettled?: () => void,
): void {
  if (!promise || typeof promise.then !== 'function') return;
  promise.then(
    () => {
      onSettled?.();
    },
    () => {
      onRejected?.();
      onSettled?.();
    },
  );
}

export function hasActiveViewTransition(): boolean {
  return activeTransaction !== null;
}

/**
 * 立即结算并跳过当前挂起的过渡事务：
 * 先同步落盘前序状态（若尚未提交），再清理临时 DOM 属性与过渡句柄。
 */
export function supersedeActiveTransition(): void {
  const previous = activeTransaction;
  if (!previous) return;
  activeTransaction = null;
  try {
    previous.commitImmediate();
  } finally {
    previous.cleanup();
    const handle = previous.handle;
    if (handle && typeof handle.skipTransition === 'function') {
      try {
        handle.skipTransition();
      } catch (_error) {
        // 忽略已完成或已中止过渡上的 skipTransition 异常。
      }
    }
  }
}

/**
 * 同步冲刷当前挂起的过渡事务（含 React flushSync 视图提交）：
 * 用于表单校验/提交等需要挂起字段变更与条件子字段挂载立即生效的边界（INDEPENDENT-3 #2）。
 */
export function flushActiveTransitionSync(): void {
  const previous = activeTransaction;
  if (!previous) return;
  activeTransaction = null;
  try {
    previous.commitFlush();
  } catch (_error) {
    previous.commitImmediate();
  } finally {
    previous.cleanup();
    const handle = previous.handle;
    if (handle && typeof handle.skipTransition === 'function') {
      try {
        handle.skipTransition();
      } catch (_error) {
        // 忽略已完成或已中止过渡上的 skipTransition 异常。
      }
    }
  }
}

/**
 * 在宿主 DOM 节点分离（detach）或卸载时清理其绑定的过渡状态与临时属性，
 * 不重放任何组件级副作用。
 */
export function cancelSurfaceTransitionForElement(element: HTMLElement | null): void {
  if (!element) return;
  const runningAnim = fallbackAnimations.get(element);
  if (runningAnim) {
    fallbackAnimations.delete(element);
    try {
      runningAnim.cancel();
    } catch (_error) {
      // 忽略已结束 WAAPI 动画的取消异常。
    }
  }
  if (activeTransaction && activeTransaction.targetElement === element) {
    supersedeActiveTransition();
    return;
  }
  if (element.style.viewTransitionName) {
    element.style.viewTransitionName = '';
  }
}

function ensureVisibilityGuard(): void {
  if (visibilityListenerInstalled || typeof document === 'undefined') return;
  visibilityListenerInstalled = true;
  const flushIfHidden = () => {
    if (
      document.hidden
      || (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible')
    ) {
      supersedeActiveTransition();
    }
  };
  document.addEventListener('visibilitychange', flushIfHidden, { passive: true });
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', supersedeActiveTransition, { passive: true });
  }
}

export function runWaapiSurfaceFallback(
  element: HTMLElement,
  direction: ViewTransitionDirection,
): void {
  const doc = element.ownerDocument;
  // 页面隐藏、减少动效、移动端外壳或终端拖拽调尺寸期间严禁触发 WAAPI 表面位移。
  if (
    !isDocumentVisibleAndStable(doc)
    || isMobileHudActive(doc)
    || prefersReducedMotion()
    || typeof element.animate !== 'function'
  ) {
    return;
  }
  const prev = fallbackAnimations.get(element);
  let startOpacity = 0.36;
  if (prev) {
    try {
      const computed = Number.parseFloat(getComputedStyle(element).opacity);
      if (Number.isFinite(computed) && computed > 0.05 && computed < 0.98) {
        startOpacity = computed;
      }
      prev.cancel();
    } catch (_error) {
      // 忽略取消异常。
    }
  }
  const offsetX = direction === 'forward' ? 8 : direction === 'backward' ? -8 : 0;
  const offsetY = offsetX === 0 ? 5 : 0;
  const anim = element.animate(
    [
      { opacity: startOpacity, transform: `translate3d(${offsetX}px, ${offsetY}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ],
    {
      duration: 175,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fill: 'none',
    },
  );
  fallbackAnimations.set(element, anim);
  const clear = () => {
    if (fallbackAnimations.get(element) === anim) {
      fallbackAnimations.delete(element);
    }
  };
  anim.onfinish = clear;
  anim.oncancel = clear;
}

export interface TransactionConfig {
  kind: ViewTransitionKind;
  direction?: ViewTransitionDirection;
  targetElement?: HTMLElement | null;
  transitionName?: string;
  commitFlush: () => void;
  commitImmediate: () => void;
  afterFlushWait?: () => Promise<void> | void;
  onFallbackAnimate?: () => void;
}

export function executeViewTransition(config: TransactionConfig): void {
  ensureVisibilityGuard();
  const doc = typeof document === 'undefined' ? null : (document as ViewTransitionDocument);
  const direction = config.direction || 'neutral';

  let committed = false;
  const runImmediate = () => {
    if (committed) return;
    committed = true;
    config.commitImmediate();
  };
  const runFlush = () => {
    if (committed) return;
    committed = true;
    config.commitFlush();
  };

  if (!canStartCompositorTransition(doc)) {
    supersedeActiveTransition();
    runImmediate();
    config.onFallbackAnimate?.();
    return;
  }

  if (config.kind !== 'theme' && isMobileHudActive(doc)) {
    supersedeActiveTransition();
    runImmediate();
    return;
  }

  supersedeActiveTransition();

  const root = doc.documentElement;
  const target = config.targetElement || null;
  if (target && config.transitionName) {
    target.style.viewTransitionName = config.transitionName;
  }
  root.setAttribute('data-vt-kind', config.kind);
  root.setAttribute('data-vt-dir', direction);

  let cleaned = false;
  const entry: ActiveTransaction = {
    handle: null,
    targetElement: target,
    commitFlush: runFlush,
    commitImmediate: runImmediate,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      if (target && config.transitionName && target.style.viewTransitionName === config.transitionName) {
        target.style.viewTransitionName = '';
      }
      if (!activeTransaction || activeTransaction === entry) {
        root.removeAttribute('data-vt-kind');
        root.removeAttribute('data-vt-dir');
      }
    },
  };
  activeTransaction = entry;

  try {
    const handle = doc.startViewTransition(() => {
      runFlush();
      return config.afterFlushWait?.();
    });
    entry.handle = handle || null;
    observePromise(handle?.ready, () => {
      runImmediate();
      if (activeTransaction === entry) {
        activeTransaction = null;
      }
      entry.cleanup();
    });
    observePromise(handle?.updateCallbackDone, runImmediate);
    observePromise(handle?.finished, runImmediate, () => {
      if (activeTransaction === entry) {
        activeTransaction = null;
      }
      entry.cleanup();
    });
  } catch (_error) {
    if (activeTransaction === entry) {
      activeTransaction = null;
    }
    entry.cleanup();
    runImmediate();
    config.onFallbackAnimate?.();
  }
}

export function runThemeViewTransition(applyTheme: () => void): void {
  executeViewTransition({
    kind: 'theme',
    direction: 'neutral',
    commitFlush: applyTheme,
    commitImmediate: applyTheme,
  });
}

export function runSurfaceViewTransition<T = void>(
  element: HTMLElement | null,
  commitState: () => T | Promise<T>,
  direction: ViewTransitionDirection = 'neutral',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let invoked = false;
    const invokeOnce = () => {
      if (invoked) return;
      invoked = true;
      try {
        const result = commitState();
        Promise.resolve(result).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    };

    if (!element || !element.isConnected) {
      supersedeActiveTransition();
      invokeOnce();
      return;
    }
    const doc = typeof document === 'undefined' ? null : (document as ViewTransitionDocument);
    if (!doc || isMobileHudActive(doc)) {
      supersedeActiveTransition();
      invokeOnce();
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      supersedeActiveTransition();
      invokeOnce();
      return;
    }

    const uniqueName = `aih-surface-${++surfaceNameSeq}`;
    executeViewTransition({
      kind: 'surface',
      direction,
      targetElement: element,
      transitionName: uniqueName,
      commitFlush: () => {
        flushSync(() => {
          invokeOnce();
        });
      },
      commitImmediate: invokeOnce,
      onFallbackAnimate: () => runWaapiSurfaceFallback(element, direction),
    });
  });
}
