import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeOutlined } from '@ant-design/icons';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import { useWebTerminalManager } from './web-terminal-context';
import './global-web-terminal.css';

function clampPosition(x: number, y: number, width: number, height = 420) {
  if (typeof window === 'undefined') return { x, y };
  const maxX = Math.max(8, window.innerWidth - Math.min(width, window.innerWidth - 16) - 8);
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
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ edge: string; startX: number; startY: number; originX: number; originY: number; width: number; height: number } | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const [motion, setMotion] = useState<TerminalMotion | null>(null);
  const motionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    persistent: true
  })), [manager.tabs]);
  const onHeaderMouseDown = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('[data-terminal-tab]')) return;
    event.preventDefault();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: manager.position.x,
      originY: manager.position.y
    };
    const onMove = (move: globalThis.MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = clampPosition(
        drag.originX + move.clientX - drag.startX,
        drag.originY + move.clientY - drag.startY,
        manager.position.width,
        manager.position.height
      );
      manager.setPosition(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [manager.position.x, manager.position.y, manager.position.width, manager.position.height, manager.setPosition]);

  const onResizeStart = useCallback((edge: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = { edge, startX: event.clientX, startY: event.clientY, originX: manager.position.x, originY: manager.position.y, width: manager.position.width, height: manager.position.height };
    const onMove = (move: globalThis.MouseEvent) => {
      const item = resizeRef.current;
      if (!item) return;
      const dx = move.clientX - item.startX;
      const dy = move.clientY - item.startY;
      const left = item.edge.includes('w');
      const top = item.edge.includes('n');
      const horizontal = left || item.edge.includes('e');
      const vertical = top || item.edge.includes('s');
      const width = horizontal ? Math.max(420, Math.min(window.innerWidth - 16, item.width + (left ? -dx : dx))) : item.width;
      const height = vertical ? Math.max(180, Math.min(window.innerHeight - 16, item.height + (top ? -dy : dy))) : item.height;
      const rawX = left ? item.originX + item.width - width : item.originX;
      const rawY = top ? item.originY + item.height - height : item.originY;
      const clamped = clampPosition(rawX, rawY, width, height);
      manager.setPosition({ x: clamped.x, y: clamped.y, width, height });
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [manager.position.height, manager.position.width, manager.position.x, manager.position.y, manager.setPosition]);

  const closings = motion?.phase === 'closing';
  if (!manager.tabs.length && !closings) return null;
  const activeTab = manager.tabs.find((tab) => tab.id === manager.activeTabId) || manager.tabs[0];
  const position = clampPosition(manager.position.x, manager.position.y, manager.position.width, manager.position.height);
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
          style={{
            left: position.x,
            top: position.y,
            width: `min(${manager.position.width}px, calc(100vw - 16px))`,
            height: `min(${manager.position.height}px, calc(100vh - 16px))`,
            ...(motion && motion.phase !== 'closing' ? motion.vars : null)
          }}
        >
          {['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => (
            <span key={edge} className={`global-web-terminal-resize global-web-terminal-resize-${edge}`} onMouseDown={(event) => onResizeStart(edge, event)} />
          ))}
          <ShellTerminalPanel
            key={manager.serverId}
            visible
            persistent
            title="Web Terminal"
            minimized={panelMinimized}
            onMinimizedChange={(value) => { if (value) beginMinimize(); else beginRestore(); }}
            onHeaderMouseDown={onHeaderMouseDown}
            panelHeight={Math.min(manager.position.height, typeof window === 'undefined' ? manager.position.height : window.innerHeight - 16)}
            sessionTabs={sessionTabs}
            onTabClose={manager.closeTab}
            onClose={beginClose}
            activeTabId={activeTab?.id || ''}
            onActiveTabChange={manager.setActiveTab}
            allowNewTab={false}
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
