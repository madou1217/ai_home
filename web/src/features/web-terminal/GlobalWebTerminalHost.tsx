import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CodeOutlined, LoadingOutlined } from '@ant-design/icons';
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
import { isFloatingHostTab } from './web-terminal-lifecycle';
import {
  createWebTerminalViewerAuthority,
  type CloseTarget,
  type TabIncarnation,
  type ViewerIdentityTuple,
} from './web-terminal-authority';
import { useTerminalWindowGesture } from './use-terminal-window-gesture';
import { moveTerminalWindow } from './terminal-window-geometry';
import { useOfficeTerminalRouteOwnership } from './web-terminal-route-ownership';
import './global-web-terminal.css';

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
    if (!isFloatingHostTab(tab)) return false;
    return readOfficeComputerPreferences(sid, skey).power === 'on';
  });
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
  originServerGeneration: number;
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
  // Explicit powered-ON native tabs whose server-side availability has not yet
  // been observed while the floating viewer is dormant. Used only to render the
  // lightweight non-attaching restore dock affordance without background polling.
  const dormantExplicitNativeTabs = useMemo(
    () => filterAdmittedPoweredOnTabs(normalizedManagerServerId, liveServerScope, manager.unavailableTabs, prefsRevision),
    [liveServerScope, manager.unavailableTabs, normalizedManagerServerId, prefsRevision],
  );
  const exactViewerTuples = useMemo<ReadonlyArray<ViewerIdentityTuple>>(
    () => poweredOnTabs.map((tab) => [
      String(tab.id || '').trim(),
      String(tab.sessionKey || '').trim(),
      admittedServerId,
    ] as const),
    [admittedServerId, poweredOnTabs],
  );

  // Synchronous per-server + per-identity incarnation authority shared between
  // host close/motion fencing and ShellTerminalPanel pre-fallback/pre-dispose
  // authorization. Invalidates immediately on server switches and power-OFF
  // transitions without waiting for a React render.
  const [viewerAuthority] = useState(() => createWebTerminalViewerAuthority({
    readLiveServerId: resolveLiveActiveServerId,
    isPoweredOn: (sid, sessionKey) => readOfficeComputerPreferences(sid, sessionKey).power === 'on',
  }));

  useEffect(() => addActiveControlPlaneProfileChangeListener(() => {
    viewerAuthority.onServerProfileChanged();
  }), [viewerAuthority]);

  useEffect(() => subscribeOfficeComputerPreferences(() => {
    viewerAuthority.onPowerPreferencesChanged();
  }), [viewerAuthority]);

  const {
    serverGeneration: currentServerGeneration,
    incarnationSignature,
  } = viewerAuthority.reconcile(serverAdmitted, admittedServerId, exactViewerTuples);

  const isSessionCurrent = useCallback(
    (id: string, closeToken?: string) => viewerAuthority.isSessionCurrent(id, closeToken),
    [viewerAuthority],
  );

  const [creatingTab, setCreatingTab] = useState(false);
  const [, setViewportRevision] = useState(0);
  const dockTabCount = poweredOnTabs.length + dormantExplicitNativeTabs.length;
  const hasInteractiveTabs = serverAdmitted && poweredOnTabs.length > 0;
  const hasRestorableTabs = serverAdmitted && dockTabCount > 0;
  const restoringNative = Boolean(
    !officeRouteOwnsTerminal
    && !manager.overviewVisible
    && serverAdmitted
    && manager.floatingOpen
    && !hasInteractiveTabs
    && hasRestorableTabs,
  );

  // When the user explicitly clicks Restore for dormant explicit native-only
  // tabs, discovery runs once to verify live server sessions. If discovery
  // settles without any matching running native session, return cleanly to
  // dormant mode so polling stops and saved identities remain retained.
  useEffect(() => {
    if (!restoringNative) return;
    if (!manager.directory.enabled || manager.directory.loading) return;
    const hasMatchingRunningNative = !manager.directory.error && manager.directory.sessions.some(
      (item) => item.source === 'native'
        && item.status === 'running'
        && dormantExplicitNativeTabs.some((tab) => tab.sessionKey === item.sessionKey),
    );
    if (hasMatchingRunningNative) return;
    if (manager.directory.error) {
      message.warning(`终端会话检查失败: ${manager.directory.error}`);
    } else {
      message.info('已保存的终端会话当前未运行，暂无法恢复');
    }
    setMinimized(true);
  }, [
    dormantExplicitNativeTabs,
    manager.directory.enabled,
    manager.directory.error,
    manager.directory.loading,
    manager.directory.sessions,
    restoringNative,
    setMinimized,
  ]);

  useEffect(() => {
    if (!hasInteractiveTabs) return;
    let frame: number | null = null;
    const resize = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; setViewportRevision((value) => value + 1); });
    };
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); if (frame !== null) cancelAnimationFrame(frame); };
  }, [hasInteractiveTabs]);
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
  const startGesture = useTerminalWindowGesture(windowRef, setPosition, `${admittedServerId}:${manager.minimized}:${hasInteractiveTabs}`, windowStyle);

  const clearMotionTimer = useCallback(() => {
    activeMotionRef.current = null;
    if (motionTimer.current) {
      clearTimeout(motionTimer.current);
      motionTimer.current = null;
    }
  }, []);

  useEffect(() => clearMotionTimer, [clearMotionTimer]);

  const isMotionFenceValid = useCallback((fence: ActiveMotionFence): boolean => (
    viewerAuthority.isMotionScopeCurrent(fence.originServerId, fence.originServerGeneration)
  ), [viewerAuthority]);

  // Invalidate pending timer and clear stale motion immediately on server
  // transitions or when interactive tabs disappear during expand/collapse.
  useEffect(() => {
    const fence = activeMotionRef.current;
    if (!fence) return;
    const matchesCurrentSnapshot = (
      serverAdmitted
      && admittedServerId === fence.originServerId
      && currentServerGeneration === fence.originServerGeneration
      && (motion?.phase === 'closing' || hasInteractiveTabs)
    );
    if (!matchesCurrentSnapshot || !isMotionFenceValid(fence)) {
      clearMotionTimer();
      setMotion(null);
    }
  }, [
    admittedServerId,
    clearMotionTimer,
    currentServerGeneration,
    hasInteractiveTabs,
    isMotionFenceValid,
    motion?.phase,
    serverAdmitted,
  ]);

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
    if (manager.minimized || motion || !serverAdmitted || !admittedServerId || !hasInteractiveTabs) return;
    const originServerGeneration = currentServerGeneration;
    const originServerId = admittedServerId;
    if (!viewerAuthority.isMotionScopeCurrent(originServerId, originServerGeneration)) {
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
      originServerGeneration,
    };
    setMotion({ phase: 'collapsing', vars: flipVars(rect) });
    scheduleMotionEnd(COLLAPSE_MS, fence, () => {
      if (!viewerAuthority.isMotionScopeCurrent(originServerId, originServerGeneration)) {
        return;
      }
      setMinimized(true);
    });
  }, [
    admittedServerId,
    currentServerGeneration,
    hasInteractiveTabs,
    manager.minimized,
    motion,
    scheduleMotionEnd,
    serverAdmitted,
    setMinimized,
    viewerAuthority,
  ]);

  const beginRestore = useCallback(() => {
    if (!manager.minimized || motion || typeof window === 'undefined' || !serverAdmitted || !admittedServerId || !hasRestorableTabs) return;
    const originServerGeneration = currentServerGeneration;
    const originServerId = admittedServerId;
    if (!viewerAuthority.isMotionScopeCurrent(originServerId, originServerGeneration)) {
      return;
    }
    // Saved explicit native-only tabs stay dormant with discovery disabled.
    // Explicit restore enables discovery first without mounting an empty panel;
    // once admitted, only exact live identities attach.
    if (!hasInteractiveTabs) {
      if (manager.floatingOpen) return;
      setMinimized(false);
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
      originServerGeneration,
    };
    setMotion({ phase: 'expanding', vars: flipVars(rect) });
    scheduleMotionEnd(EXPAND_MS, fence, () => {
      if (!viewerAuthority.isMotionScopeCurrent(originServerId, originServerGeneration)) {
        return;
      }
      setMinimized(false);
    });
  }, [
    admittedServerId,
    currentServerGeneration,
    hasInteractiveTabs,
    hasRestorableTabs,
    manager.floatingOpen,
    manager.minimized,
    manager.position.height,
    manager.position.width,
    manager.position.x,
    manager.position.y,
    motion,
    scheduleMotionEnd,
    serverAdmitted,
    setMinimized,
    viewerAuthority,
  ]);

  const removeExactValidatedIncarnation = useCallback((
    expectedServerId: string,
    expectedServerGeneration: number,
    expectedIncarnation: number,
    tuple: ViewerIdentityTuple,
  ): boolean => {
    if (!viewerAuthority.consumeIncarnationForClose(
      admittedServerId,
      expectedServerId,
      expectedServerGeneration,
      expectedIncarnation,
      tuple,
    )) {
      return false;
    }
    closeTab(tuple[0]);
    return true;
  }, [admittedServerId, closeTab, viewerAuthority]);

  const handleTabClose = useCallback((id: string, closeToken?: string) => {
    if (!viewerAuthority.consumeTokenForClose(admittedServerId, id, closeToken)) return;
    closeTab(id);
  }, [admittedServerId, closeTab, viewerAuthority]);

  const finalizeClosedIncarnations = useCallback((
    originServerId: string,
    capturedEntries: ReadonlyArray<TabIncarnation>,
  ) => {
    for (const entry of capturedEntries) {
      removeExactValidatedIncarnation(
        originServerId,
        entry.serverGeneration,
        entry.incarnation,
        entry.tuple,
      );
    }
  }, [removeExactValidatedIncarnation]);

  // 关闭绑定发起时的 serverId + serverGeneration + 每页签精确 incarnation 快照；
  // 兄弟页签增删不影响已发起关闭的结算，同时 OFF -> ON 同身份与切服（含 A -> B -> A）均严格拦截，绝不调用 closeAll。
  const beginClose = useCallback((closedTargets?: ReadonlyArray<CloseTarget>) => {
    if (closedTargets) {
      for (const target of closedTargets) {
        handleTabClose(target.id, target.closeToken);
      }
      return;
    }
    if (motion || !serverAdmitted || !admittedServerId) return;
    const originServerGeneration = currentServerGeneration;
    const originServerId = admittedServerId;
    const capturedEntries = viewerAuthority.snapshotLiveIncarnations(originServerId, originServerGeneration);
    if (!capturedEntries.length) return;
    const reduce = typeof window !== 'undefined' && prefersReducedMotion();
    if (reduce || manager.minimized) {
      finalizeClosedIncarnations(originServerId, capturedEntries);
      return;
    }
    const fence: ActiveMotionFence = {
      motionId: ++motionSeqRef.current,
      originServerId,
      originServerGeneration,
    };
    setMotion({ phase: 'closing', vars: {} });
    scheduleMotionEnd(CLOSE_MS, fence, () => {
      finalizeClosedIncarnations(originServerId, capturedEntries);
    });
  }, [
    admittedServerId,
    currentServerGeneration,
    finalizeClosedIncarnations,
    handleTabClose,
    manager.minimized,
    motion,
    scheduleMotionEnd,
    serverAdmitted,
    viewerAuthority,
  ]);

  const sessionTabs = useMemo(() => {
    const pairs = JSON.parse(incarnationSignature) as ReadonlyArray<readonly [string, string]>;
    const tokens = new Map(pairs);
    return poweredOnTabs.map((tab) => ({
      id: tab.id,
      sessionKey: tab.sessionKey,
      label: tab.label,
      cwd: tab.cwd,
      kind: tab.kind,
      persistent: true,
      closeToken: tokens.get(tab.id),
    }));
  }, [incarnationSignature, poweredOnTabs]);
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
      openTab({
        sessionKey: key,
        serverId: originServerId,
        label: `Shell ${number}`,
        cwd: active?.cwd,
        kind: 'shell',
        origin: 'explicit',
      });
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
  if (officeRouteOwnsTerminal || manager.overviewVisible || (!hasRestorableTabs && !closings)) return null;
  const activeTab = poweredOnTabs.find((tab) => tab.id === manager.activeTabId) || poweredOnTabs[0];
  const availableWidth = typeof window === 'undefined' ? manager.position.width : Math.max(1, window.innerWidth - 16);
  const availableHeight = typeof window === 'undefined' ? manager.position.height : Math.max(1, window.innerHeight - 16);
  // 折叠/展开动画期间，窗口与停靠气泡同时在场：窗口做 FLIP，气泡做交汇淡入/淡出。
  const showWindow = closings || (hasInteractiveTabs && (!manager.minimized || motion?.phase === 'expanding'));
  const showDock = !closings && hasRestorableTabs && (manager.minimized || motion?.phase === 'collapsing');
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
              key={admittedServerId}
              visible
              persistent
              autoFocus={false}
              focusRequestSeq={manager.focusRequestSeq}
              title="Web Terminal"
              minimized={panelMinimized}
              onMinimizedChange={(value) => { if (value) beginMinimize(); else beginRestore(); }}
              onHeaderPointerDown={(event) => startGesture('move', event)}
              panelHeight={Math.min(manager.position.height, typeof window === 'undefined' ? manager.position.height : window.innerHeight - 16)}
              sessionTabs={sessionTabs}
              isSessionCurrent={isSessionCurrent}
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
            aria-label={restoringNative ? '正在检查可恢复的 Web Terminal' : '恢复 Web Terminal'}
            aria-busy={restoringNative || undefined}
            title={restoringNative ? '正在检查可恢复的终端会话…' : '恢复 Web Terminal'}
            disabled={restoringNative}
            onClick={beginRestore}
          >
            {restoringNative ? <LoadingOutlined /> : <CodeOutlined />}
            <span>{dockTabCount}</span>
          </button>
        </div>
      ) : null}
    </>
  );
}
