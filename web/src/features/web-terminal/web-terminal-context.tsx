import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { resolveActiveServer } from '@/services/webui-auth-transport';

export type WebTerminalTabKind = 'account-cli' | 'shell';

export interface WebTerminalTab {
  id: string;
  sessionKey: string;
  label: string;
  cwd: string;
  serverId: string;
  kind: WebTerminalTabKind;
  harness?: string;
  model?: string;
}
interface WebTerminalLayoutState {
  tabs: WebTerminalTab[];
  activeTabId: string;
  minimized: boolean;
  position: { x: number; y: number; width: number; height: number };
}
interface StoredState {
  version: 1;
  servers: Record<string, WebTerminalLayoutState>;
}

export interface OpenWebTerminalTabInput {
  sessionKey: string;
  label: string;
  cwd?: string;
  serverId?: string;
  kind?: WebTerminalTabKind;
  harness?: string;
  model?: string;
}

interface WebTerminalManagerValue extends WebTerminalLayoutState {
  openTab: (input: OpenWebTerminalTabInput) => void;
  closeTab: (id: string) => void;
  closeAll: () => void;
  setActiveTab: (id: string) => void;
  setMinimized: (value: boolean) => void;
  setPosition: (position: Partial<WebTerminalLayoutState['position']>) => void;
}

const STORAGE_KEY = 'aih:web-terminal-global:v1';
const DEFAULT_WIDTH = 900;
const DEFAULT_STATE: WebTerminalLayoutState = {
  tabs: [],
  activeTabId: '',
  minimized: false,
  position: { x: 0, y: 0, width: DEFAULT_WIDTH, height: 420 }
};

const WebTerminalManagerContext = createContext<WebTerminalManagerValue | null>(null);

function currentServerId(): string {
  try {
    return String(resolveActiveServer().serverId || 'local').trim() || 'local';
  } catch (_error) {
    return 'local';
  }
}

function normalizeTab(value: unknown, serverId: string): WebTerminalTab | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<WebTerminalTab>;
  const sessionKey = String(item.sessionKey || '').trim();
  if (!sessionKey) return null;
  return {
    id: String(item.id || sessionKey).trim() || sessionKey,
    sessionKey,
    label: String(item.label || 'Web Terminal').trim() || 'Web Terminal',
    cwd: String(item.cwd || ''),
    serverId: String(item.serverId || serverId).trim() || serverId,
    kind: item.kind === 'account-cli' ? 'account-cli' : 'shell',
    harness: String(item.harness || '').trim() || undefined,
    model: String(item.model || '').trim() || undefined
  };
}

function normalizeState(value: unknown, serverId: string): WebTerminalLayoutState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_STATE, position: { ...DEFAULT_STATE.position } };
  const item = value as Partial<WebTerminalLayoutState>;
  const tabs = Array.isArray(item.tabs)
    ? item.tabs.map((tab) => normalizeTab(tab, serverId)).filter((tab): tab is WebTerminalTab => Boolean(tab))
    : [];
  const activeTabId = tabs.some((tab) => tab.id === item.activeTabId)
    ? String(item.activeTabId)
    : (tabs[0]?.id || '');
  const sourcePosition = item.position && typeof item.position === 'object' ? item.position : {};
  const x = Number((sourcePosition as { x?: number }).x);
  const y = Number((sourcePosition as { y?: number }).y);
  const width = Number((sourcePosition as { width?: number }).width);
  const height = Number((sourcePosition as { height?: number }).height);
  return {
    tabs,
    activeTabId,
    minimized: item.minimized === true,
    position: {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      width: Number.isFinite(width) && width >= 420 ? width : DEFAULT_WIDTH,
      height: Number.isFinite(height) && height >= 180 ? height : 420
    }
  };
}

function readStoredState(serverId: string): WebTerminalLayoutState {
  if (typeof window === 'undefined') return { ...DEFAULT_STATE, position: { ...DEFAULT_STATE.position } };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null') as StoredState | null;
    if (parsed?.version === 1 && parsed.servers) return normalizeState(parsed.servers[serverId], serverId);
    // One-time migration from the old account-only single launch record.
    const legacy = JSON.parse(window.localStorage.getItem('aih:account-web-terminal:v1') || 'null');
    const migrated = normalizeTab(legacy, serverId);
    if (migrated) {
      const accountTab = { ...migrated, kind: 'account-cli' as const };
      return { ...DEFAULT_STATE, tabs: [accountTab], activeTabId: accountTab.id, position: { ...DEFAULT_STATE.position } };
    }
  } catch (_error) {
    // Browser storage can be disabled or contain an interrupted write.
  }
  return { ...DEFAULT_STATE, position: { ...DEFAULT_STATE.position } };
}

function persistState(serverId: string, state: WebTerminalLayoutState): void {
  if (typeof window === 'undefined') return;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null') as Partial<StoredState> | null;
    const stored: StoredState = {
      version: 1,
      servers: parsed?.version === 1 && parsed.servers ? parsed.servers : {}
    };
    stored.servers[serverId] = state;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    window.localStorage.removeItem('aih:account-web-terminal:v1');
  } catch (_error) {
    // Keep PTY operation usable when localStorage is unavailable.
  }
}

function makeTabId(sessionKey: string): string {
  return `web-terminal:${sessionKey}`;
}

export function WebTerminalManagerProvider({ children }: { children: React.ReactNode }) {
  const serverId = currentServerId();
  const [state, setState] = useState<WebTerminalLayoutState>(() => readStoredState(serverId));

  const update = useCallback((next: WebTerminalLayoutState | ((current: WebTerminalLayoutState) => WebTerminalLayoutState)) => {
    setState((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      persistState(serverId, value);
      return value;
    });
  }, [serverId]);

  const openTab = useCallback((input: OpenWebTerminalTabInput) => {
    const sessionKey = String(input.sessionKey || '').trim();
    if (!sessionKey) return;
    const targetServerId = String(input.serverId || serverId).trim() || serverId;
    // A tab opened through the current browser must never attach to another
    // server's PTY. The server-scoped storage keeps the other server's tabs.
    if (targetServerId !== serverId) return;
    const tab: WebTerminalTab = {
      id: makeTabId(sessionKey),
      sessionKey,
      label: String(input.label || 'Web Terminal').trim() || 'Web Terminal',
      cwd: String(input.cwd || ''),
      serverId,
      kind: input.kind || 'account-cli',
      harness: String(input.harness || '').trim() || undefined,
      model: String(input.model || '').trim() || undefined
    };
    update((current) => {
    const existing = current.tabs.findIndex((item) => item.id === tab.id);
      const tabs = current.tabs.slice();
      if (existing >= 0) tabs[existing] = { ...tabs[existing], ...tab };
      else tabs.push(tab);
      return { ...current, tabs, activeTabId: tab.id };
    });
  }, [serverId, update]);

  const closeTab = useCallback((id: string) => {
    update((current) => {
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      return { ...current, tabs, activeTabId: current.activeTabId === id ? (tabs[tabs.length - 1]?.id || '') : current.activeTabId };
    });
  }, [update]);

  const closeAll = useCallback(() => update((current) => ({ ...current, tabs: [], activeTabId: '' })), [update]);
  const setActiveTab = useCallback((id: string) => update((current) => current.tabs.some((tab) => tab.id === id) ? { ...current, activeTabId: id } : current), [update]);
  const setMinimized = useCallback((value: boolean) => update((current) => ({ ...current, minimized: value })), [update]);
  const setPosition = useCallback((position: Partial<WebTerminalLayoutState['position']>) => update((current) => ({
    ...current,
    position: { ...current.position, ...position }
  })), [update]);

  const value = useMemo<WebTerminalManagerValue>(() => ({
    ...state,
    openTab,
    closeTab,
    closeAll,
    setActiveTab,
    setMinimized,
    setPosition
  }), [closeAll, closeTab, openTab, setActiveTab, setMinimized, setPosition, state]);
  return <WebTerminalManagerContext.Provider value={value}>{children}</WebTerminalManagerContext.Provider>;
}

export function useWebTerminalManager(): WebTerminalManagerValue {
  const value = useContext(WebTerminalManagerContext);
  if (!value) throw new Error('useWebTerminalManager must be used inside WebTerminalManagerProvider');
  return value;
}
