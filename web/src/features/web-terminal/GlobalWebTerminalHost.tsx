import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeOutlined } from '@ant-design/icons';
import { message } from 'antd';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import { terminalAPI } from '@/services/api';
import { useWebTerminalManager } from './web-terminal-context';
import { useTerminalWindowGesture } from './use-terminal-window-gesture';
import { moveTerminalWindow } from './terminal-window-geometry';
import './global-web-terminal.css';

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

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_error) {
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
  const manager = useWebTerminalManager();
  const [creatingTab, setCreatingTab] = useState(false);
  const [, setViewportRevision] = useState(0);
  const hasTabs = manager.tabs.length > 0;
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
  const position = clampPosition(manager.position.x, manager.position.y, manager.position.width, manager.position.height);
  const windowStyle: React.CSSProperties = {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `min(${manager.position.width}px, calc(100vw - 16px))`,
    height: `min(${manager.position.height}px, calc(100vh - 16px))`,
    ...(motion && motion.phase !== 'closing' ? motion.vars : null)
  };
  const startGesture = useTerminalWindowGesture(windowRef, manager.setPosition, `${manager.serverId}:${manager.minimized}:${hasTabs}`, windowStyle);

  const clearMotionTimer = useCallback(() => {
    if (motionTimer.current) {
      clearTimeout(motionTimer.current);
      motionTimer.current = null;
    }
  }, []);

  useEffect(() => clearMotionTimer, [clearMotionTimer]);

  const scheduleMotionEnd = useCallback((delay: number, finish: () => void) => {
    clearMotionTimer();
    motionTimer.current = setTimeout(() => {
      motionTimer.current = null;
      setMotion(null);
      finish();
    }, delay);
  }, [clearMotionTimer]);

  const beginMinimize = useCallback(() => {
    if (manager.minimized || motion) return;
    const el = windowRef.current;
    if (!el || prefersReducedMotion()) {
      manager.setMinimized(true);
      return;
    }
    const rect = el.getBoundingClientRect();
    setMotion({ phase: 'collapsing', vars: flipVars(rect) });
    scheduleMotionEnd(COLLAPSE_MS, () => manager.setMinimized(true));
  }, [manager, motion, scheduleMotionEnd]);

  const beginRestore = useCallback(() => {
    if (!manager.minimized || motion || typeof window === 'undefined') return;
    if (prefersReducedMotion()) {
      manager.setMinimized(false);
      return;
    }
    const clamped = clampPosition(manager.position.x, manager.position.y, manager.position.width, manager.position.height);
    const rect: RectLike = {
      left: clamped.x,
      top: clamped.y,
      width: Math.min(manager.position.width, window.innerWidth - 16),
      height: Math.min(manager.position.height, window.innerHeight - 16)
    };
    setMotion({ phase: 'expanding', vars: flipVars(rect) });
    scheduleMotionEnd(EXPAND_MS, () => manager.setMinimized(false));
  }, [manager, motion, scheduleMotionEnd]);

  // 关闭需要先确认所有 PTY 都关掉（ShellTerminalPanel.closePanel 负责），这里只给成功关闭后的
  // 卸载播一次淡出：onClose 被调用时 PTY 已关闭，动画结束后再清空页签。
  const beginClose = useCallback(() => {
    if (motion) return;
    const reduce = typeof window !== 'undefined' && prefersReducedMotion();
    if (reduce || manager.minimized) {
      manager.closeAll();
      return;
    }
    setMotion({ phase: 'closing', vars: {} });
    scheduleMotionEnd(CLOSE_MS, () => manager.closeAll());
  }, [manager, motion, scheduleMotionEnd]);

  const sessionTabs = useMemo(() => manager.tabs.map((tab) => ({
    id: tab.id,
    sessionKey: tab.sessionKey,
    label: tab.label,
    cwd: tab.cwd,
    kind: tab.kind,
    persistent: true
  })), [manager.tabs]);
  const onNewTab = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreatingTab(true);
    try {
      const active = manager.tabs.find((tab) => tab.id === manager.activeTabId);
      const random = new Uint8Array(16);
      globalThis.crypto.getRandomValues(random);
      const key = `shell-${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      const result = await terminalAPI.open(80, 24, undefined, active?.cwd, key);
      if (!result.ok || !result.termId) {
        message.error(`新建终端失败: ${result.error || 'unknown'}`);
        return;
      }
      const labels = new Set(manager.tabs.map((tab) => tab.label));
      let number = 1;
      while (labels.has(`Shell ${number}`)) number += 1;
      manager.openTab({ sessionKey: key, serverId: manager.serverId, label: `Shell ${number}`, cwd: active?.cwd, kind: 'shell' });
    } finally {
      creatingRef.current = false;
      setCreatingTab(false);
    }
  }, [manager]);
  const onResizeKeyDown = useCallback((edge: string, event: React.KeyboardEvent) => {
    const horizontal = edge === 'e' || edge === 'w';
    const direction = event.key === (horizontal ? 'ArrowRight' : 'ArrowDown') ? 1
      : event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp') ? -1 : 0;
    const node = windowRef.current;
    if (!direction || !node) return;
    event.preventDefault();
    const rect = node.getBoundingClientRect();
    const delta = direction * (event.shiftKey ? 48 : 12);
    manager.setPosition(moveTerminalWindow(
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      edge, horizontal ? delta : 0, horizontal ? 0 : delta, window.innerWidth, window.innerHeight,
    ));
  }, [manager.setPosition]);

  const closings = motion?.phase === 'closing';
  if (!manager.tabs.length && !closings) return null;
  const activeTab = manager.tabs.find((tab) => tab.id === manager.activeTabId) || manager.tabs[0];
  const availableWidth = typeof window === 'undefined' ? manager.position.width : Math.max(1, window.innerWidth - 16);
  const availableHeight = typeof window === 'undefined' ? manager.position.height : Math.max(1, window.innerHeight - 16);
  // 折叠/展开动画期间，窗口与停靠气泡同时在场：窗口做 FLIP，气泡做交汇淡入/淡出。
  const showWindow = closings || !manager.minimized || motion?.phase === 'expanding';
  const showDock = !closings && (manager.minimized || motion?.phase === 'collapsing');
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
          <ShellTerminalPanel
            key={manager.serverId}
            visible
            persistent
            title="Web Terminal"
            minimized={panelMinimized}
            onMinimizedChange={(value) => { if (value) beginMinimize(); else beginRestore(); }}
            onHeaderPointerDown={(event) => startGesture('move', event)}
            panelHeight={Math.min(manager.position.height, typeof window === 'undefined' ? manager.position.height : window.innerHeight - 16)}
            sessionTabs={sessionTabs}
            onTabClose={manager.closeTab}
            onClose={beginClose}
            activeTabId={activeTab?.id || ''}
            onActiveTabChange={manager.setActiveTab}
            onNewTab={onNewTab}
            creatingTab={creatingTab}
            isCreatingTab={isCreatingTab}
            layout={manager.layout}
            onLayoutChange={manager.setLayout}
          />
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
            <span>{manager.tabs.length}</span>
          </button>
        </div>
      ) : null}
    </>
  );
}
