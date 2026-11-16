import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { resolveActiveServer } from '@/services/webui-auth-transport';
import { addActiveControlPlaneProfileChangeListener } from '@/services/control-plane-selection';
import { updateTerminalScope } from './web-terminal-scope';
import { useTerminalDirectory } from './use-terminal-directory';
import { useTerminalAvailability } from './use-terminal-availability';

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
  nativeSessionId?: string;
}
interface WebTerminalLayoutState {
  tabs: WebTerminalTab[];
  activeTabId: string;
  minimized: boolean;
  layout: 'tabs' | 'sidebar' | 'gallery';
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
  nativeSessionId?: string;
}

interface WebTerminalManagerValue extends WebTerminalLayoutState {
  serverId: string;
  overviewVisible: boolean;
  setOverviewVisible: (visible: boolean) => void;
  openTab: (input: OpenWebTerminalTabInput) => void;
  adoptSessions: (inputs: OpenWebTerminalTabInput[]) => void;
  unavailableTabs: WebTerminalTab[];
  directory: ReturnType<typeof useTerminalDirectory>;
  closeTab: (id: string) => void;
  closeAll: () => void;
  setActiveTab: (id: string) => void;
  setMinimized: (value: boolean) => void;
  setLayout: (layout: WebTerminalLayoutState['layout']) => void;
  setPosition: (position: Partial<WebTerminalLayoutState['position']>) => void;
}

const STORAGE_KEY = 'aih:web-terminal-global:v1';
const DEFAULT_WIDTH = 900;
const DEFAULT_STATE: WebTerminalLayoutState = {
  tabs: [],
  activeTabId: '',
  minimized: false,
  layout: 'gallery',
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
    model: String(item.model || '').trim() || undefined,
    nativeSessionId: String(item.nativeSessionId || '').trim() || undefined
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
    layout: item.layout === 'sidebar' || item.layout === 'tabs' ? item.layout : 'gallery',
    position: {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      width: Number.isFinite(width) && width > 0 ? width : DEFAULT_WIDTH,
      height: Number.isFinite(height) && height > 0 ? height : 420
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
  const [overviewVisible, setOverviewVisible] = useState(false);
  const [{ serverId, state }, setScopedState] = useState(() => {
    const id = currentServerId();
    return { serverId: id, state: readStoredState(id) };
  });

  const { directory, interactiveTabs, unavailableTabs, isUnavailable } = useTerminalAvailability(serverId, state.tabs, overviewVisible);

  // Server selection can change without remounting the application shell. Swap
  // to that server's persisted terminal layout and let the host remount its
  // xterm panel; persistent PTYs from the previous server remain attachable.
  useEffect(() => addActiveControlPlaneProfileChangeListener(() => {
    const nextServerId = currentServerId();
    setScopedState((current) => current.serverId === nextServerId
      ? current
      : { serverId: nextServerId, state: readStoredState(nextServerId) });
  }), []);

  const update = useCallback((next: WebTerminalLayoutState | ((current: WebTerminalLayoutState) => WebTerminalLayoutState)) => {
    setScopedState((current) => {
      const change = typeof next === 'function' ? next : () => next;
      return updateTerminalScope(current, serverId, change, readStoredState, persistState);
    });
  }, [serverId]);

  const openTab = useCallback((input: OpenWebTerminalTabInput) => {
    const sessionKey = String(input.sessionKey || '').trim();
    if (!sessionKey) return;
    const targetServerId = String(input.serverId || serverId).trim() || serverId;
    const tab: WebTerminalTab = {
      id: makeTabId(sessionKey),
      sessionKey,
      label: String(input.label || 'Web Terminal').trim() || 'Web Terminal',
      cwd: String(input.cwd || ''),
      serverId: targetServerId,
      kind: input.kind || 'account-cli',
      harness: String(input.harness || '').trim() || undefined,
      model: String(input.model || '').trim() || undefined,
      nativeSessionId: String(input.nativeSessionId || '').trim() || undefined
    };
    setScopedState((current) => {
      // A launch may finish after the user switches servers. Preserve it in
      // the originating server's layout instead of attaching it to this one.
      return updateTerminalScope(current, targetServerId, (targetState) => {
        const existing = targetState.tabs.findIndex((item) => item.id === tab.id);
        const tabs = targetState.tabs.slice();
        if (existing >= 0) tabs[existing] = { ...tabs[existing], ...tab };
        else tabs.push(tab);
        return { ...targetState, tabs, activeTabId: tab.id };
      }, readStoredState, persistState);
    });
  }, [serverId]);

  const closeTab = useCallback((id: string) => {
    update((current) => {
      const selected = current.tabs.find((tab) => tab.id === id);
      // Removing an unavailable viewer is not a request to forget its task.
      // User callbacks may race discovery; never forget a retained identity.
      if (selected && isUnavailable(selected.sessionKey)) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      return { ...current, tabs, activeTabId: current.activeTabId === id ? (tabs[tabs.length - 1]?.id || '') : current.activeTabId };
    });
  }, [isUnavailable, update]);

  const adoptSessions = useCallback((inputs: OpenWebTerminalTabInput[]) => {
    update((current) => {
      const tabs = current.tabs.slice();
      let changed = false;
      for (const input of inputs) {
        if (!input.sessionKey) continue;
        const existing = tabs.findIndex((tab) => tab.sessionKey === input.sessionKey);
        if (existing >= 0) {
          if (!tabs[existing].nativeSessionId && input.nativeSessionId) {
            tabs[existing] = { ...tabs[existing], nativeSessionId: input.nativeSessionId };
            changed = true;
          }
          continue;
        }
        tabs.push({ id: makeTabId(input.sessionKey), sessionKey: input.sessionKey,
          serverId, label: input.label, cwd: input.cwd || '', kind: input.kind || 'account-cli',
          harness: input.harness, nativeSessionId: input.nativeSessionId });
        changed = true;
      }
      return changed ? { ...current, tabs, activeTabId: current.activeTabId || tabs[0]?.id || '' } : current;
    });
  }, [serverId, update]);

  const closeAll = useCallback(() => {
    const closed = new Set(interactiveTabs.map((tab) => tab.id));
    update((current) => {
      const tabs = current.tabs.filter((tab) => !closed.has(tab.id) || isUnavailable(tab.sessionKey));
      return { ...current, tabs, activeTabId: tabs.some((tab) => tab.id === current.activeTabId) ? current.activeTabId : tabs[0]?.id || '' };
    });
  }, [interactiveTabs, isUnavailable, update]);
  const setActiveTab = useCallback((id: string) => update((current) => current.tabs.some((tab) => tab.id === id) ? { ...current, activeTabId: id } : current), [update]);
  const setMinimized = useCallback((value: boolean) => update((current) => ({ ...current, minimized: value })), [update]);
  const setLayout = useCallback((layout: WebTerminalLayoutState['layout']) => update((current) => ({ ...current, layout })), [update]);
  const setPosition = useCallback((position: Partial<WebTerminalLayoutState['position']>) => update((current) => ({
    ...current,
    position: { ...current.position, ...position }
  })), [update]);

  const value = useMemo<WebTerminalManagerValue>(() => ({
    ...state,
    tabs: interactiveTabs,
    unavailableTabs,
    activeTabId: interactiveTabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : interactiveTabs[0]?.id || '',
    serverId,
    overviewVisible,
    setOverviewVisible,
    openTab,
    adoptSessions,
    directory,
    closeTab,
    closeAll,
    setActiveTab,
    setMinimized,
    setLayout,
    setPosition
  }), [adoptSessions, closeAll, closeTab, directory, interactiveTabs, openTab, overviewVisible, serverId, setActiveTab, setLayout, setMinimized, setPosition, state, unavailableTabs]);
  return <WebTerminalManagerContext.Provider value={value}>{children}</WebTerminalManagerContext.Provider>;
}

export function useWebTerminalManager(): WebTerminalManagerValue {
  const value = useContext(WebTerminalManagerContext);
  if (!value) throw new Error('useWebTerminalManager must be used inside WebTerminalManagerProvider');
  return value;
}
