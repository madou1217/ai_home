import React, { useCallback, useMemo, useRef } from 'react';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import { useWebTerminalManager } from './web-terminal-context';
import './global-web-terminal.css';

function clampPosition(x: number, y: number, width: number) {
  if (typeof window === 'undefined') return { x, y };
  const maxX = Math.max(8, window.innerWidth - Math.min(width, window.innerWidth - 16) - 8);
  const maxY = Math.max(8, window.innerHeight - 42);
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}
export default function GlobalWebTerminalHost() {
  const manager = useWebTerminalManager();
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
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
        manager.position.width
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
  }, [manager.position.x, manager.position.y, manager.position.width, manager.setPosition]);

  if (!manager.tabs.length) return null;
  const activeTab = manager.tabs.find((tab) => tab.id === manager.activeTabId) || manager.tabs[0];
  const position = clampPosition(manager.position.x, manager.position.y, manager.position.width);
  return (
    <div
      className="global-web-terminal-window"
      role="region"
      aria-label="Web Terminal"
      style={{ left: position.x, top: position.y, width: `min(${manager.position.width}px, calc(100vw - 16px))` }}
    >
      <ShellTerminalPanel
        visible
        persistent
        title="Web Terminal"
        minimized={manager.minimized}
        onMinimizedChange={manager.setMinimized}
        onHeaderMouseDown={onHeaderMouseDown}
        sessionTabs={sessionTabs}
        onTabClose={manager.closeTab}
        onClose={manager.closeAll}
        activeTabId={activeTab.id}
        onActiveTabChange={manager.setActiveTab}
        allowNewTab={false}
      />
    </div>
  );
}
