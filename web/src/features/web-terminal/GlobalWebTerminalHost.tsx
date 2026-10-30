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
  const position = clampPosition(manager.position.x, manager.position.y, manager.position.width, manager.position.height);
  const windowStyle = manager.minimized ? undefined : { left: `${position.x}px`, top: `${position.y}px`, width: `min(${manager.position.width}px, calc(100vw - 16px))`, height: `min(${manager.position.height}px, calc(100vh - 16px))` };
  const startGesture = useTerminalWindowGesture(windowRef, manager.setPosition, `${manager.serverId}:${manager.minimized}:${hasTabs}`, windowStyle);
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

  if (!manager.tabs.length) return null;
  const activeTab = manager.tabs.find((tab) => tab.id === manager.activeTabId) || manager.tabs[0];
  const availableWidth = typeof window === 'undefined' ? manager.position.width : Math.max(1, window.innerWidth - 16);
  const availableHeight = typeof window === 'undefined' ? manager.position.height : Math.max(1, window.innerHeight - 16);
  return (
    <div
      ref={windowRef}
      className={`global-web-terminal-window${manager.minimized ? ' is-minimized' : ''}`}
      role="region"
      aria-label="Web Terminal"
      style={windowStyle}
    >
      {manager.minimized ? <button type="button" className="global-web-terminal-restore" aria-label="恢复 Web Terminal" title="恢复 Web Terminal" onClick={() => manager.setMinimized(false)}><CodeOutlined /><span>{manager.tabs.length}</span></button> : null}
      {!manager.minimized && ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => (
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
        minimized={manager.minimized}
        onMinimizedChange={manager.setMinimized}
        onHeaderPointerDown={(event) => startGesture('move', event)}
        panelHeight={Math.min(manager.position.height, typeof window === 'undefined' ? manager.position.height : window.innerHeight - 16)}
        sessionTabs={sessionTabs}
        onTabClose={manager.closeTab}
        onClose={manager.closeAll}
        activeTabId={activeTab.id}
        onActiveTabChange={manager.setActiveTab}
        onNewTab={onNewTab}
        creatingTab={creatingTab}
        isCreatingTab={isCreatingTab}
        layout={manager.layout}
        onLayoutChange={manager.setLayout}
      />
    </div>
  );
}
