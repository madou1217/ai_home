import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CodeOutlined } from '@ant-design/icons';
import { message } from 'antd';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import { resolveLiveActiveServerId } from '@/features/session-office/office-computer-power';
import {
  readOfficeComputerPreferences,
  subscribeOfficeComputerPreferences,
} from '@/features/session-office/office-computer-state';
import { terminalAPI } from '@/services/api';
import { addActiveControlPlaneProfileChangeListener } from '@/services/control-plane-selection';
import { useWebTerminalManager, type WebTerminalTab } from './web-terminal-context';
import { useTerminalWindowGesture } from './use-terminal-window-gesture';
import { moveTerminalWindow } from './terminal-window-geometry';
import { useOfficeTerminalRouteOwnership } from './web-terminal-route-ownership';
import './global-web-terminal.css';

type ViewerIdentityTuple = readonly [id: string, sessionKey: string, serverId: string];

let globalPrefsRevision = 0;
let unsubscribeGlobalPrefs: (() => void) | null = null;
const globalPrefsListeners = new Set<() => void>();

function subscribeGlobalComputerPrefsRevision(listener: () => void): () => void {
  globalPrefsListeners.add(listener);
  if (!unsubscribeGlobalPrefs) {
    unsubscribeGlobalPrefs = subscribeOfficeComputerPreferences(() => {
      globalPrefsRevision += 1;
      for (const item of [...globalPrefsListeners]) {
        item();
      }
    });
  }
  return () => {
    globalPrefsListeners.delete(listener);
    if (globalPrefsListeners.size === 0 && unsubscribeGlobalPrefs) {
      unsubscribeGlobalPrefs();
      unsubscribeGlobalPrefs = null;
    }
  };
}

function getGlobalComputerPrefsRevision(): number {
  return globalPrefsRevision;
}

function getServerGlobalComputerPrefsRevision(): number {
  return 0;
}

function subscribeLiveServerScope(listener: () => void): () => void {
  return addActiveControlPlaneProfileChangeListener(listener);
}

function getServerLiveServerScope(): string {
  return 'local';
}

function filterAdmittedPoweredOnTabs(
  managerServerId: string,
  liveActiveServerId: string,
  tabs: ReadonlyArray<WebTerminalTab>,
  revision: number,
): WebTerminalTab[] {
  const sid = String(managerServerId || '').trim();
  const liveSid = String(liveActiveServerId || '').trim();
  if (revision < 0 || !sid || !liveSid || sid !== liveSid) return [];
  if (resolveLiveActiveServerId() !== sid) return [];
  return tabs.filter((tab) => {
    const id = String(tab.id || '').trim();
    const skey = String(tab.sessionKey || '').trim();
    const tabSid = String(tab.serverId || '').trim();
    if (!id || !skey || tabSid !== sid) return false;
    return readOfficeComputerPreferences(sid, skey).power === 'on';
  });
}

function buildCollisionSafeMembershipKey(
  admittedServerId: string,
  tuples: ReadonlyArray<ViewerIdentityTuple>,
): string {
  if (!admittedServerId || tuples.length === 0) {
    return JSON.stringify([admittedServerId, []]);
  }
  const canonicalTuples = tuples
    .slice()
    .sort((a, b) => (
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    ));
  return JSON.stringify([admittedServerId, canonicalTuples]);
}

function clampPosition(x: number, y: number, width: number, height = 420) {
  if (typeof window === 'undefined') return { x, y };
  const effectiveWidth = window.innerWidth > 720 ? Math.max(420, width) : width;
  const maxX = Math.max(8, window.innerWidth - Math.min(effectiveWidth, window.innerWidth - 16) - 8);
  const maxY = Math.max(8, window.innerHeight - Math.min(height, window.innerHeight - 16) - 8);
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}

// 停靠气泡的位置/尺寸必须与 global-web-terminal.css 的 .global-web-terminal-dock 一致：
// 最小化动画的终点、恢复动画的起点都由它算出来（FLIP）。
const DOCK_BUBBLE_SIZE = 52;
const DOCK_RIGHT = 20;
const DOCK_BOTTOM = 90;
const COLLAPSE_MS = 260;
const EXPAND_MS = 300;
const CLOSE_MS = 160;

type MotionPhase = 'collapsing' | 'expanding' | 'closing';

interface TerminalMotion {
  phase: MotionPhase;
  /** FLIP 变量：把窗口矩形映射到停靠气泡的 transform。 */
  vars: Record<string, string>;
}

interface ActiveMotionFence {
  motionId: number;
  originServerId: string;
  originGeneration: number;
}

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function dockOrigin() {
  const maxX = Math.max(8, window.innerWidth - 16 - DOCK_BUBBLE_SIZE);
  const maxY = Math.max(8, window.innerHeight - 16 - DOCK_BUBBLE_SIZE);
  return {
    x: Math.min(maxX, Math.max(8, window.innerWidth - DOCK_RIGHT - DOCK_BUBBLE_SIZE)),
    y: Math.min(maxY, Math.max(8, window.innerHeight - DOCK_BOTTOM - DOCK_BUBBLE_SIZE)),
    size: DOCK_BUBBLE_SIZE
  };
}

// transform-origin 固定左上角：translate 把窗口左上角送到气泡左上角，scale 把窗口压到气泡大小。
// 这样最小化看起来是「窗口自己缩回停靠点」，恢复则是「从停靠点摊开回原来的位置/尺寸」。
function flipVars(rect: RectLike): Record<string, string> {
  const dock = dockOrigin();
  const sx = rect.width > 0 ? dock.size / rect.width : 1;
  const sy = rect.height > 0 ? dock.size / rect.height : 1;
  return {
    '--aih-terminal-tx': `${Math.round(dock.x - rect.left)}px`,
    '--aih-terminal-ty': `${Math.round(dock.y - rect.top)}px`,
    '--aih-terminal-sx': String(Number(sx.toFixed(5))),
    '--aih-terminal-sy': String(Number(sy.toFixed(5)))
  };
}

export default function GlobalWebTerminalHost() {
  const officeRouteOwnsTerminal = useOfficeTerminalRouteOwnership();
  const manager = useWebTerminalManager();
  const { closeTab, openTab, setMinimized, setPosition } = manager;
  const prefsRevision = useSyncExternalStore(
    subscribeGlobalComputerPrefsRevision,
    getGlobalComputerPrefsRevision,
    getServerGlobalComputerPrefsRevision,
  );
  const liveServerScope = useSyncExternalStore(
    subscribeLiveServerScope,
    resolveLiveActiveServerId,
    getServerLiveServerScope,
  );

  const normalizedManagerServerId = String(manager.serverId || '').trim();
  const serverAdmitted = Boolean(
    normalizedManagerServerId
    && normalizedManagerServerId === liveServerScope
    && resolveLiveActiveServerId() === normalizedManagerServerId,
  );
  const admittedServerId = serverAdmitted ? normalizedManagerServerId : '';

  const poweredOnTabs = useMemo(
    () => filterAdmittedPoweredOnTabs(normalizedManagerServerId, liveServerScope, manager.tabs, prefsRevision),
    [liveServerScope, manager.tabs, normalizedManagerServerId, prefsRevision],
  );
  const exactViewerTuples = useMemo<ReadonlyArray<ViewerIdentityTuple>>(
    () => poweredOnTabs.map((tab) => [
      String(tab.id || '').trim(),
      String(tab.sessionKey || '').trim(),
      admittedServerId,
    ] as const),
    [admittedServerId, poweredOnTabs],
  );
  const poweredPanelKey = useMemo(
    () => buildCollisionSafeMembershipKey(admittedServerId, exactViewerTuples),
    [admittedServerId, exactViewerTuples],
  );

  // Monotonic viewer generation updated synchronously during render whenever
  // origin server admission or exact powered-ON membership transitions (including
  // ON -> OFF -> ON returning to the identical membership key string).
  const viewerStateRef = useRef<{
    generation: number;
    serverAdmitted: boolean;
    serverId: string;
    membershipKey: string;
    tuplesById: Map<string, ViewerIdentityTuple>;
  }>({
    generation: 0,
    serverAdmitted: false,
    serverId: '',
    membershipKey: '',
    tuplesById: new Map(),
  });

  if (
    viewerStateRef.current.serverAdmitted !== serverAdmitted
    || viewerStateRef.current.serverId !== admittedServerId
    || viewerStateRef.current.membershipKey !== poweredPanelKey
  ) {
    viewerStateRef.current.generation += 1;
    viewerStateRef.current.serverAdmitted = serverAdmitted;
    viewerStateRef.current.serverId = admittedServerId;
    viewerStateRef.current.membershipKey = poweredPanelKey;
  }

  const liveTuplesMap = new Map<string, ViewerIdentityTuple>();
  if (serverAdmitted) {
    for (const tuple of exactViewerTuples) {
      liveTuplesMap.set(tuple[0], tuple);
    }
  }
  viewerStateRef.current.tuplesById = liveTuplesMap;
  const currentViewerGeneration = viewerStateRef.current.generation;

  const [creatingTab, setCreatingTab] = useState(false);
  const [, setViewportRevision] = useState(0);
  const hasTabs = serverAdmitted && poweredOnTabs.length > 0;
  useEffect(() => {
    if (!hasTabs) return;
    let frame: number | null = null;
    const resize = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; setViewportRevision((value) => value + 1); });
    };
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); if (frame !== null) cancelAnimationFrame(frame); };
  }, [hasTabs]);
  const creatingRef = useRef(false);
  const isCreatingTab = useCallback(() => creatingRef.current, []);
  const windowRef = useRef<HTMLDivElement>(null);
  const [motion, setMotion] = useState<TerminalMotion | null>(null);
  const motionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const motionSeqRef = useRef(0);
  const activeMotionRef = useRef<ActiveMotionFence | null>(null);

  const position = clampPosition(manager.position.x, manager.position.y, manager.position.width, manager.position.height);
  const windowStyle: React.CSSProperties = {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `min(${manager.position.width}px, calc(100vw - 16px))`,
    height: `min(${manager.position.height}px, calc(100vh - 16px))`,
    ...(motion && motion.phase !== 'closing' ? motion.vars : null)
  };
  const startGesture = useTerminalWindowGesture(windowRef, setPosition, `${admittedServerId}:${manager.minimized}:${hasTabs}`, windowStyle);

  const clearMotionTimer = useCallback(() => {
    activeMotionRef.current = null;
    if (motionTimer.current) {
      clearTimeout(motionTimer.current);
      motionTimer.current = null;
    }
  }, []);

  useEffect(() => clearMotionTimer, [clearMotionTimer]);

  const isMotionFenceValid = useCallback((fence: ActiveMotionFence): boolean => {
    const live = viewerStateRef.current;
    if (!live.serverAdmitted || live.serverId !== fence.originServerId) return false;
    if (live.generation !== fence.originGeneration) return false;
    return resolveLiveActiveServerId() === fence.originServerId;
  }, []);

  // Invalidate pending timer and clear stale motion immediately on server or
  // powered-ON membership transitions.
  useEffect(() => {
    const fence = activeMotionRef.current;
    if (!fence) return;
    const matchesCurrentSnapshot = (
      serverAdmitted
      && admittedServerId === fence.originServerId
      && currentViewerGeneration === fence.originGeneration
    );
    if (!matchesCurrentSnapshot || !isMotionFenceValid(fence)) {
      clearMotionTimer();
      setMotion(null);
    }
  }, [admittedServerId, clearMotionTimer, currentViewerGeneration, isMotionFenceValid, serverAdmitted]);

  const scheduleMotionEnd = useCallback((
    delay: number,
    fence: ActiveMotionFence,
    finish: () => void,
  ) => {
    clearMotionTimer();
    activeMotionRef.current = fence;
    motionTimer.current = setTimeout(() => {
      if (activeMotionRef.current?.motionId !== fence.motionId) return;
      motionTimer.current = null;
      activeMotionRef.current = null;
      if (!isMotionFenceValid(fence)) {
        setMotion(null);
        return;
      }
      setMotion(null);
      finish();
    }, delay);
  }, [clearMotionTimer, isMotionFenceValid]);

  const beginMinimize = useCallback(() => {
    if (manager.minimized || motion || !serverAdmitted || !admittedServerId) return;
    const originGeneration = currentViewerGeneration;
    const originServerId = admittedServerId;
    if (
      viewerStateRef.current.generation !== originGeneration
      || viewerStateRef.current.serverId !== originServerId
      || resolveLiveActiveServerId() !== originServerId
    ) {
      return;
    }
    const el = windowRef.current;
    if (!el || prefersReducedMotion()) {
      setMinimized(true);
      return;
    }
    const rect = el.getBoundingClientRect();
    const fence: ActiveMotionFence = {
      motionId: ++motionSeqRef.current,
      originServerId,
      originGeneration,
    };
    setMotion({ phase: 'collapsing', vars: flipVars(rect) });
    scheduleMotionEnd(COLLAPSE_MS, fence, () => {
      if (
        viewerStateRef.current.generation !== originGeneration
        || viewerStateRef.current.serverId !== originServerId
        || resolveLiveActiveServerId() !== originServerId
      ) {
        return;
      }
      setMinimized(true);
    });
  }, [admittedServerId, currentViewerGeneration, manager.minimized, motion, scheduleMotionEnd, serverAdmitted, setMinimized]);

  const beginRestore = useCallback(() => {
    if (!manager.minimized || motion || typeof window === 'undefined' || !serverAdmitted || !admittedServerId) return;
    const originGeneration = currentViewerGeneration;
    const originServerId = admittedServerId;
    if (
      viewerStateRef.current.generation !== originGeneration
      || viewerStateRef.current.serverId !== originServerId
      || resolveLiveActiveServerId() !== originServerId
    ) {
      return;
    }
    if (prefersReducedMotion()) {
      setMinimized(false);
      return;
    }
    const clamped = clampPosition(manager.position.x, manager.position.y, manager.position.width, manager.position.height);
    const rect: RectLike = {
      left: clamped.x,
      top: clamped.y,
      width: Math.min(manager.position.width, window.innerWidth - 16),
      height: Math.min(manager.position.height, window.innerHeight - 16)
    };
    const fence: ActiveMotionFence = {
      motionId: ++motionSeqRef.current,
      originServerId,
      originGeneration,
    };
    setMotion({ phase: 'expanding', vars: flipVars(rect) });
    scheduleMotionEnd(EXPAND_MS, fence, () => {
      if (
        viewerStateRef.current.generation !== originGeneration
        || viewerStateRef.current.serverId !== originServerId
        || resolveLiveActiveServerId() !== originServerId
      ) {
        return;
      }
      setMinimized(false);
    });
  }, [
    admittedServerId,
    currentViewerGeneration,
    manager.minimized,
    manager.position.height,
    manager.position.width,
    manager.position.x,
    manager.position.y,
    motion,
    scheduleMotionEnd,
    serverAdmitted,
    setMinimized,
  ]);

  const removeExactValidatedTuple = useCallback((
    expectedGeneration: number,
    originServerId: string,
    tuple: ViewerIdentityTuple,
  ): boolean => {
    const live = viewerStateRef.current;
    if (!live.serverAdmitted || live.serverId !== originServerId) return false;
    if (live.generation !== expectedGeneration) return false;
    if (resolveLiveActiveServerId() !== originServerId) return false;
    const [id, sessionKey, tupleSid] = tuple;
    if (!id || !sessionKey || tupleSid !== originServerId) return false;
    const currentTuple = live.tuplesById.get(id);
    if (
      !currentTuple
      || currentTuple[0] !== id
      || currentTuple[1] !== sessionKey
      || currentTuple[2] !== originServerId
    ) {
      return false;
    }
    if (readOfficeComputerPreferences(originServerId, sessionKey).power !== 'on') {
      return false;
    }
    closeTab(id);
    return true;
  }, [closeTab]);

  const handleTabClose = useCallback((id: string) => {
    const originGeneration = currentViewerGeneration;
    const originServerId = admittedServerId;
    const originTuple = exactViewerTuples.find((item) => item[0] === id);
    if (!originServerId || !originTuple) return;
    removeExactValidatedTuple(originGeneration, originServerId, originTuple);
  }, [admittedServerId, currentViewerGeneration, exactViewerTuples, removeExactValidatedTuple]);

  const finalizeClosedTuples = useCallback((
    expectedGeneration: number,
    originServerId: string,
    capturedTuples: ReadonlyArray<ViewerIdentityTuple>,
  ) => {
    for (const tuple of capturedTuples) {
      removeExactValidatedTuple(expectedGeneration, originServerId, tuple);
    }
  }, [removeExactValidatedTuple]);

  // 关闭绑定发起时的 generation + serverId + 精确可见元组快照；
  // 任何过期的回调或延迟定时器在设置动画或移除元数据前均立即短路，绝不调用 closeAll。
  const beginClose = useCallback(() => {
    if (motion || !serverAdmitted || !admittedServerId) return;
    const originGeneration = currentViewerGeneration;
    const originServerId = admittedServerId;
    const capturedTuples = exactViewerTuples.slice();
    const live = viewerStateRef.current;
    if (
      !live.serverAdmitted
      || live.serverId !== originServerId
      || live.generation !== originGeneration
      || resolveLiveActiveServerId() !== originServerId
    ) {
      return;
    }
    const reduce = typeof window !== 'undefined' && prefersReducedMotion();
    if (reduce || manager.minimized) {
      finalizeClosedTuples(originGeneration, originServerId, capturedTuples);
      return;
    }
    const fence: ActiveMotionFence = {
      motionId: ++motionSeqRef.current,
      originServerId,
      originGeneration,
    };
    setMotion({ phase: 'closing', vars: {} });
    scheduleMotionEnd(CLOSE_MS, fence, () => {
      finalizeClosedTuples(originGeneration, originServerId, capturedTuples);
    });
  }, [
    admittedServerId,
    currentViewerGeneration,
    exactViewerTuples,
    finalizeClosedTuples,
    manager.minimized,
    motion,
    scheduleMotionEnd,
    serverAdmitted,
  ]);

  const sessionTabs = useMemo(() => poweredOnTabs.map((tab) => ({
    id: tab.id,
    sessionKey: tab.sessionKey,
    label: tab.label,
    cwd: tab.cwd,
    kind: tab.kind,
    persistent: true
  })), [poweredOnTabs]);
  const onNewTab = useCallback(async () => {
    if (creatingRef.current || !serverAdmitted || !admittedServerId) return;
    if (resolveLiveActiveServerId() !== admittedServerId) return;
    const originServerId = admittedServerId;
    creatingRef.current = true;
    setCreatingTab(true);
    try {
      const active = poweredOnTabs.find((tab) => tab.id === manager.activeTabId) || poweredOnTabs[0];
      const random = new Uint8Array(16);
      globalThis.crypto.getRandomValues(random);
      const key = `shell-${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      if (resolveLiveActiveServerId() !== originServerId) return;
      const result = await terminalAPI.open(80, 24, undefined, active?.cwd, key);
      if (!result.ok || !result.termId) {
        message.error(`新建终端失败: ${result.error || 'unknown'}`);
        return;
      }
      const labels = new Set(manager.tabs.map((tab) => tab.label));
      let number = 1;
      while (labels.has(`Shell ${number}`)) number += 1;
      openTab({ sessionKey: key, serverId: originServerId, label: `Shell ${number}`, cwd: active?.cwd, kind: 'shell' });
    } finally {
      creatingRef.current = false;
      setCreatingTab(false);
    }
  }, [admittedServerId, manager.activeTabId, manager.tabs, openTab, poweredOnTabs, serverAdmitted]);
  const onResizeKeyDown = useCallback((edge: string, event: React.KeyboardEvent) => {
    const horizontal = edge === 'e' || edge === 'w';
    const direction = event.key === (horizontal ? 'ArrowRight' : 'ArrowDown') ? 1
      : event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp') ? -1 : 0;
    const node = windowRef.current;
    if (!direction || !node) return;
    event.preventDefault();
    const rect = node.getBoundingClientRect();
    const delta = direction * (event.shiftKey ? 48 : 12);
    setPosition(moveTerminalWindow(
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      edge, horizontal ? delta : 0, horizontal ? 0 : delta, window.innerWidth, window.innerHeight,
    ));
  }, [setPosition]);

  const closings = serverAdmitted && motion?.phase === 'closing';
  if (officeRouteOwnsTerminal || manager.overviewVisible || (!hasTabs && !closings)) return null;
  const activeTab = poweredOnTabs.find((tab) => tab.id === manager.activeTabId) || poweredOnTabs[0];
  const availableWidth = typeof window === 'undefined' ? manager.position.width : Math.max(1, window.innerWidth - 16);
  const availableHeight = typeof window === 'undefined' ? manager.position.height : Math.max(1, window.innerHeight - 16);
  // 折叠/展开动画期间，窗口与停靠气泡同时在场：窗口做 FLIP，气泡做交汇淡入/淡出。
  const showWindow = closings || !manager.minimized || motion?.phase === 'expanding';
  const showDock = !closings && hasTabs && (manager.minimized || motion?.phase === 'collapsing');
  const panelMinimized = motion?.phase === 'expanding' || motion?.phase === 'closing'
    ? false
    : (manager.minimized && !motion);
  const windowClass = [
    'global-web-terminal-window',
    motion ? `is-${motion.phase}` : ''
  ].filter(Boolean).join(' ');
  return (
    <>
      {showWindow ? (
        <div
          ref={windowRef}
          className={windowClass}
          role="region"
          aria-label="Web Terminal"
          style={windowStyle}
        >
          {['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => (
            <span
              key={edge}
              className={`global-web-terminal-resize global-web-terminal-resize-${edge}`}
              onPointerDown={(event) => startGesture(edge, event)}
              {...(edge.length === 1 ? {
                role: 'separator',
                tabIndex: 0,
                'aria-label': `调整终端${edge === 'e' || edge === 'w' ? '宽度' : '高度'}（方向键调整，Shift 加速）`,
                'aria-orientation': (edge === 'e' || edge === 'w' ? 'vertical' : 'horizontal') as 'vertical' | 'horizontal',
                'aria-valuemin': edge === 'e' || edge === 'w' ? Math.min(420, availableWidth) : Math.min(180, availableHeight),
                'aria-valuemax': edge === 'e' || edge === 'w' ? availableWidth : availableHeight,
                'aria-valuenow': edge === 'e' || edge === 'w' ? Math.min(Math.max(manager.position.width, Math.min(420, availableWidth)), availableWidth) : Math.min(Math.max(manager.position.height, Math.min(180, availableHeight)), availableHeight),
                onKeyDown: (event: React.KeyboardEvent) => onResizeKeyDown(edge, event),
              } : { 'aria-hidden': true })}
            />
          ))}
          {serverAdmitted && sessionTabs.length > 0 ? (
            <ShellTerminalPanel
              key={poweredPanelKey}
              visible
              persistent
              title="Web Terminal"
              minimized={panelMinimized}
              onMinimizedChange={(value) => { if (value) beginMinimize(); else beginRestore(); }}
              onHeaderPointerDown={(event) => startGesture('move', event)}
              panelHeight={Math.min(manager.position.height, typeof window === 'undefined' ? manager.position.height : window.innerHeight - 16)}
              sessionTabs={sessionTabs}
              onTabClose={handleTabClose}
              onClose={beginClose}
              activeTabId={activeTab?.id || ''}
              onActiveTabChange={manager.setActiveTab}
              onNewTab={onNewTab}
              creatingTab={creatingTab}
              isCreatingTab={isCreatingTab}
              layout={manager.layout}
              onLayoutChange={manager.setLayout}
            />
          ) : null}
        </div>
      ) : null}
      {showDock ? (
        <div className="global-web-terminal-dock" data-phase={motion?.phase || 'idle'}>
          <button
            type="button"
            className="global-web-terminal-restore"
            aria-label="恢复 Web Terminal"
            title="恢复 Web Terminal"
            onClick={beginRestore}
          >
            <CodeOutlined />
            <span>{poweredOnTabs.length}</span>
          </button>
        </div>
      ) : null}
    </>
  );
}
