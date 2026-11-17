import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import {
  cancelSurfaceTransitionForElement,
  hasActiveViewTransition,
  runSurfaceViewTransition,
  type ViewTransitionDirection,
} from '@/services/view-transition';

export interface SurfaceSwitchOptions {
  /** 过渡方向：forward（向右/下推进）、backward（向左/上回退）、neutral（原位淡出淡入） */
  direction?: ViewTransitionDirection;
  /** 同一 surface 下存在多个独立控制轴时的区分槽名（默认 'default'） */
  slot?: string;
  /** 组件当前已提交渲染的旧值（配合 next 做感知挂起意图的幂等判重） */
  current?: unknown;
  /** 本次用户交互请求切换到的目标值 */
  next?: unknown;
  /** 可选的目标 DOM 覆盖节点（如 Chat/Work 共享同一协调器时按动作选择全区或中心会话栏） */
  element?: HTMLElement | null;
}

interface PendingIntentEntry {
  value: unknown;
  token: number;
  promise: Promise<unknown>;
}

let nextIntentToken = 0;

/**
 * 在进入 switchSurface 之前需要判重时的安全辅助函数：
 * 仅当全局不存在挂起过渡且新旧值一致时才视为冗余点击；若存在未提交的挂起过渡，
 * 绝不提前早退，确保快速反向点击（如 Chat -> Work 尚未落盘时立刻点回 Chat）能够抢占并提交最新意图。
 */
export function isSameCommittedIntent(current: unknown, next: unknown): boolean {
  return !hasActiveViewTransition() && Object.is(current, next);
}

/**
 * 桌面端「预提交（pre-commit）」局部区域切换原语：
 * 在 Segmented / 筛选器 / 视图模式 / 分页 / 表单受控触发器的交互回调里包裹状态提交，
 * 先对当前真实 DOM 截取离场帧（::view-transition-old），再同步提交新状态并播放进场帧（::view-transition-new）。
 *
 * 1. 卸载清理保障（INDEPENDENT-1 P2）：通过自定义 current setter 在节点 detach 瞬间清理原 DOM 引用。
 * 2. 快速反转意图保障（INDEPENDENT-2 #2）：按 slot 记录尚未渲染落盘的挂起目标值（pendingIntents），
 *    比对有效最新意图而非陈旧闭包值，既允许 A->B->A 反向抢占，又防止 A->B->B 连点重复请求与 A->A 无意义闪烁。
 */
export function useSurfaceSwitch<E extends HTMLElement = HTMLDivElement>() {
  const attachedNodeRef = useRef<E | null>(null);
  const pendingIntentsRef = useRef<Map<string, PendingIntentEntry>>(new Map());

  const surfaceRef = useMemo<MutableRefObject<E | null>>(() => {
    const holder = {} as MutableRefObject<E | null>;
    Object.defineProperty(holder, 'current', {
      enumerable: true,
      configurable: false,
      get() {
        return attachedNodeRef.current;
      },
      set(next: E | null) {
        const previous = attachedNodeRef.current;
        if (previous && previous !== next) {
          cancelSurfaceTransitionForElement(previous);
        }
        attachedNodeRef.current = next;
      },
    });
    return holder;
  }, []);

  useEffect(() => {
    return () => {
      pendingIntentsRef.current.clear();
      if (attachedNodeRef.current) {
        cancelSurfaceTransitionForElement(attachedNodeRef.current);
        attachedNodeRef.current = null;
      }
    };
  }, []);

  const switchSurface = useCallback(
    <T = void>(commitState: () => T | Promise<T>, options?: SurfaceSwitchOptions): Promise<T> => {
      const slot = options?.slot || 'default';
      const hasIntentPair = Boolean(options && 'next' in options);
      let token = 0;
      let pendingEntry: PendingIntentEntry | null = null;
      if (hasIntentPair) {
        const pending = pendingIntentsRef.current.get(slot);
        if (pending) {
          if (Object.is(pending.value, options?.next)) {
            return pending.promise as Promise<T>;
          }
        } else if (!hasActiveViewTransition() && Object.is(options?.current, options?.next)) {
          return new Promise<T>((resolve, reject) => {
            try {
              Promise.resolve(commitState()).then(resolve, reject);
            } catch (error) {
              reject(error);
            }
          });
        }
        token = ++nextIntentToken;
        pendingEntry = {
          value: options?.next,
          token,
          promise: Promise.resolve(),
        };
        pendingIntentsRef.current.set(slot, pendingEntry);
      }

      const wrappedCommit = () => {
        try {
          return commitState();
        } finally {
          if (hasIntentPair) {
            const release = () => {
              if (pendingIntentsRef.current.get(slot)?.token === token) {
                pendingIntentsRef.current.delete(slot);
              }
            };
            if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
              window.requestAnimationFrame(release);
            } else {
              release();
            }
          }
        }
      };

      const targetElement = options && 'element' in options
        ? (options.element ?? null)
        : attachedNodeRef.current;

      const resultPromise = runSurfaceViewTransition<T>(
        targetElement,
        wrappedCommit,
        options?.direction || 'neutral',
      );
      if (pendingEntry) {
        pendingEntry.promise = resultPromise;
      }
      return resultPromise;
    },
    [],
  );

  return { surfaceRef, switchSurface };
}

/** 根据离散选项在列表中的前后顺序推导切换方向。 */
export function resolveOrderedDirection<T>(
  orderList: readonly T[],
  previous: T,
  next: T,
): ViewTransitionDirection {
  const prevIdx = orderList.indexOf(previous);
  const nextIdx = orderList.indexOf(next);
  if (prevIdx === -1 || nextIdx === -1 || prevIdx === nextIdx) return 'neutral';
  return nextIdx > prevIdx ? 'forward' : 'backward';
}

export default useSurfaceSwitch;
