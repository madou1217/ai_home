// 桌面端工作区主路由的预提交（Pre-Commit）history 事务适配器。
//
// 单一职责：在 Umi rootContainer 阶段桥接底层 history.listen，在 BrowserRoutes setState 之前
// 截取 .aih-route-stage 旧页面快照，并保证任意顺序的 PUSH / POP / REPLACE 严格按因果序单次提交。

import { flushSync } from 'react-dom';
import {
  executeViewTransition,
  isMobileHudActive,
  runWaapiSurfaceFallback,
  supersedeActiveTransition,
  type ViewTransitionDirection,
} from '@/services/view-transition';

export interface HistoryLocationLike {
  pathname: string;
  search?: string;
  hash?: string;
  state?: unknown;
  key?: string;
}

export interface HistoryUpdateLike {
  action: string;
  location: HistoryLocationLike;
}

export interface HistoryLike {
  readonly action: string;
  readonly location: HistoryLocationLike;
  listen: (listener: (update: HistoryUpdateLike) => void) => () => void;
}

const BARE_REDIRECT_PATHS = new Set(['/', '/studio', '/translation']);
const patchedHistories = new WeakSet<object>();

function normalizeRoutePathname(raw: string | undefined): string {
  const withoutQuery = String(raw || '/').split(/[?#]/, 1)[0].trim() || '/';
  let path = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path === '/ui') {
    path = '/';
  } else if (path.startsWith('/ui/')) {
    path = path.slice(3);
  }
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path || '/';
}

function waitForRouteStageMount(stageNode: HTMLElement, maxWaitMs = 42): Promise<void> | void {
  if (stageNode.childElementCount > 0 || typeof MutationObserver === 'undefined') {
    return undefined;
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (stageNode.childElementCount > 0) {
        done();
      }
    });
    observer.observe(stageNode, { childList: true });
    const timer = window.setTimeout(done, maxWaitMs);
    if (stageNode.childElementCount > 0) {
      done();
    }
  });
}

export function installRouteViewTransition(
  rawHistory: HistoryLike | null | undefined,
  resolveRouteOrder: (pathname: string | undefined) => number | null,
): void {
  if (!rawHistory || typeof rawHistory.listen !== 'function') return;
  if (patchedHistories.has(rawHistory)) return;
  patchedHistories.add(rawHistory);

  const rawListen = rawHistory.listen.bind(rawHistory);
  const subscribers = new Set<(update: HistoryUpdateLike) => void>();
  const pendingQueue: Array<{ seq: number; update: HistoryUpdateLike }> = [];
  let upstreamUnlisten: (() => void) | null = null;
  let renderedPathname = normalizeRoutePathname(rawHistory.location?.pathname);
  let isNotifying = false;
  let latestEventSeq = 0;
  let latestDeliveredSeq = 0;

  const deliverToSubscribers = (update: HistoryUpdateLike, seq: number) => {
    if (seq <= latestDeliveredSeq) return;
    if (isNotifying) {
      pendingQueue.push({ seq, update });
      return;
    }
    isNotifying = true;
    try {
      let current: { seq: number; update: HistoryUpdateLike } | undefined = { seq, update };
      while (current) {
        if (current.seq > latestDeliveredSeq) {
          latestDeliveredSeq = current.seq;
          renderedPathname = normalizeRoutePathname(current.update.location?.pathname);
          const currentUpdate = current.update;
          Array.from(subscribers).forEach((listener) => {
            listener(currentUpdate);
          });
        }
        current = pendingQueue.shift();
      }
    } finally {
      isNotifying = false;
    }
  };

  const dispatchHistoryUpdate = (update: HistoryUpdateLike) => {
    const eventSeq = ++latestEventSeq;

    // 若在一次同步订阅者广播内部触发了嵌套路由变更（例如 onPageChange 门禁 history.replace），
    // 入队串行化，待当前事件通知完全部订阅者后再按严格到达序广播，防止内外层订阅者乱序。
    if (isNotifying) {
      pendingQueue.push({ seq: eventSeq, update });
      return;
    }

    // 关键顺序防护（INDEPENDENT-1 P1 & INDEPENDENT-3 #1）：
    // 1) 任何外部到达的新历史事件先结算此前挂起的过渡回调；
    // 2) 若结算旧事件期间订阅者同步触发了更新的嵌套重定向 D（使 latestEventSeq > eventSeq），
    //    浏览器真实 history 已停在 D 且全部订阅者已按序收到 B -> D，此时陈旧外层事件必须放弃，杜绝把订阅者倒退回旧路由。
    supersedeActiveTransition();
    if (eventSeq !== latestEventSeq || eventSeq <= latestDeliveredSeq) {
      return;
    }

    const prevPath = renderedPathname;
    const nextPath = normalizeRoutePathname(update.location?.pathname);
    const action = String(update.action || '').toUpperCase();

    if (
      subscribers.size === 0
      || action === 'REPLACE'
      || prevPath === nextPath
      || BARE_REDIRECT_PATHS.has(nextPath)
      || prevPath === '/chat/quick'
      || nextPath === '/chat/quick'
      || typeof document === 'undefined'
      || isMobileHudActive(document)
    ) {
      deliverToSubscribers(update, eventSeq);
      return;
    }

    const stageNode = document.querySelector<HTMLElement>('.aih-route-stage');
    if (!stageNode || !stageNode.isConnected) {
      deliverToSubscribers(update, eventSeq);
      return;
    }

    const prevOrder = resolveRouteOrder(prevPath);
    const nextOrder = resolveRouteOrder(nextPath);
    let direction: ViewTransitionDirection = action === 'POP' ? 'backward' : 'forward';
    if (prevOrder !== null && nextOrder !== null && prevOrder !== nextOrder) {
      direction = nextOrder > prevOrder ? 'forward' : 'backward';
    }

    executeViewTransition({
      kind: 'route',
      direction,
      targetElement: stageNode,
      transitionName: 'aih-route-stage',
      commitFlush: () => {
        if (eventSeq <= latestDeliveredSeq) return;
        flushSync(() => {
          deliverToSubscribers(update, eventSeq);
        });
      },
      commitImmediate: () => {
        deliverToSubscribers(update, eventSeq);
      },
      afterFlushWait: () => waitForRouteStageMount(stageNode),
      onFallbackAnimate: () => runWaapiSurfaceFallback(stageNode, direction),
    });
  };

  (rawHistory as { listen: typeof rawHistory.listen }).listen = (listener) => {
    subscribers.add(listener);
    if (!upstreamUnlisten) {
      renderedPathname = normalizeRoutePathname(rawHistory.location?.pathname);
      upstreamUnlisten = rawListen(dispatchHistoryUpdate);
    }
    return () => {
      subscribers.delete(listener);
      if (subscribers.size === 0 && upstreamUnlisten) {
        supersedeActiveTransition();
        upstreamUnlisten();
        upstreamUnlisten = null;
      }
    };
  };
}
