import React, { useCallback, useMemo, useRef, useState } from 'react';
import { CodeOutlined } from '@ant-design/icons';
import { message } from 'antd';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import { terminalAPI } from '@/services/api';
import { useWebTerminalManager } from './web-terminal-context';
import { useTerminalWindowGesture } from './use-terminal-window-gesture';
import './global-web-terminal.css';

function clampPosition(x: number, y: number, width: number, height = 420) {
  if (typeof window === 'undefined') return { x, y };
  const maxX = Math.max(8, window.innerWidth - Math.min(width, window.innerWidth - 16) - 8);
  const maxY = Math.max(8, window.innerHeight - Math.min(height, window.innerHeight - 16) - 8);
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}
export default function GlobalWebTerminalHost() {
  const manager = useWebTerminalManager();
  const [creatingTab, setCreatingTab] = useState(false);
  const creatingRef = useRef(false);
  const isCreatingTab = useCallback(() => creatingRef.current, []);
  const windowRef = useRef<HTMLDivElement>(null);
  const startGesture = useTerminalWindowGesture(windowRef, manager.setPosition, `${manager.serverId}:${manager.minimized}:${manager.tabs.length > 0}`);
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

  if (!manager.tabs.length) return null;
  const activeTab = manager.tabs.find((tab) => tab.id === manager.activeTabId) || manager.tabs[0];
  const position = clampPosition(manager.position.x, manager.position.y, manager.position.width, manager.position.height);
  return (
    <div
      ref={windowRef}
      className={`global-web-terminal-window${manager.minimized ? ' is-minimized' : ''}`}
      role="region"
      aria-label="Web Terminal"
      style={manager.minimized ? undefined : { left: position.x, top: position.y, width: `min(${manager.position.width}px, calc(100vw - 16px))`, height: `min(${manager.position.height}px, calc(100vh - 16px))` }}
    >
      {manager.minimized ? <button type="button" className="global-web-terminal-restore" aria-label="恢复 Web Terminal" title="恢复 Web Terminal" onClick={() => manager.setMinimized(false)}><CodeOutlined /><span>{manager.tabs.length}</span></button> : null}
      {!manager.minimized && ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => (
        <span key={edge} className={`global-web-terminal-resize global-web-terminal-resize-${edge}`} onPointerDown={(event) => startGesture(edge, event)} />
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
