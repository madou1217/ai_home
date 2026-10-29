import React, { useCallback, useMemo, useRef } from 'react';
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
export default function GlobalWebTerminalHost() {
  const manager = useWebTerminalManager();
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ edge: string; startX: number; startY: number; originX: number; originY: number; width: number; height: number } | null>(null);
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

  if (!manager.tabs.length) return null;
  const activeTab = manager.tabs.find((tab) => tab.id === manager.activeTabId) || manager.tabs[0];
  const position = clampPosition(manager.position.x, manager.position.y, manager.position.width, manager.position.height);
  return (
    <div
      className={`global-web-terminal-window${manager.minimized ? ' is-minimized' : ''}`}
      role="region"
      aria-label="Web Terminal"
      style={manager.minimized ? undefined : { left: position.x, top: position.y, width: `min(${manager.position.width}px, calc(100vw - 16px))`, height: `min(${manager.position.height}px, calc(100vh - 16px))` }}
    >
      {manager.minimized ? <button type="button" className="global-web-terminal-restore" aria-label="恢复 Web Terminal" title="恢复 Web Terminal" onClick={() => manager.setMinimized(false)}><CodeOutlined /><span>{manager.tabs.length}</span></button> : null}
      {!manager.minimized && ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => (
        <span key={edge} className={`global-web-terminal-resize global-web-terminal-resize-${edge}`} onMouseDown={(event) => onResizeStart(edge, event)} />
      ))}
      <ShellTerminalPanel
        key={manager.serverId}
        visible
        persistent
        title="Web Terminal"
        minimized={manager.minimized}
        onMinimizedChange={manager.setMinimized}
        onHeaderMouseDown={onHeaderMouseDown}
        panelHeight={Math.min(manager.position.height, typeof window === 'undefined' ? manager.position.height : window.innerHeight - 16)}
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
