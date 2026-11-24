import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { resolveActiveServer } from '@/services/webui-auth-transport';
import { addActiveControlPlaneProfileChangeListener } from '@/services/control-plane-selection';
import { updateTerminalScope } from './web-terminal-scope';
import { useTerminalDirectory } from './use-terminal-directory';
import { useTerminalAvailability } from './use-terminal-availability';
import {
  isFloatingHostTab,
  isFloatingViewerVisible,
  normalizeTabOrigin,
  promoteTabOrigin,
  shouldPollTerminalDirectory,
  type WebTerminalTabOrigin,
} from './web-terminal-lifecycle';
import { isOfficeTerminalRoute, useOfficeTerminalRouteOwnership } from './web-terminal-route-ownership';

export type WebTerminalTabKind = 'account-cli' | 'shell';

export interface WebTerminalTab {
  id: string;
  sessionKey: string;
  label: string;
  cwd: string;
  serverId: string;
  kind: WebTerminalTabKind;
  origin?: WebTerminalTabOrigin;
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
  origin?: WebTerminalTabOrigin;
  harness?: string;
  model?: string;
  nativeSessionId?: string;
}

interface WebTerminalManagerValue extends WebTerminalLayoutState {
  serverId: string;
  overviewVisible: boolean;
  floatingOpen: boolean;
  focusRequestSeq: number;
  setOverviewVisible: (visible: boolean) => void;
  openTab: (input: OpenWebTerminalTabInput) => void;
  adoptSessions: (inputs: OpenWebTerminalTabInput[]) => void;
  unavailableTabs: WebTerminalTab[];
  /** 连续两次目录快照都确认服务端已不存在的 project-shell 会话键。 */
  goneShellKeys: ReadonlySet<string>;
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
  minimized: true,
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
    origin: normalizeTabOrigin(item.origin),
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
    minimized: item.minimized !== false,
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
      const accountTab = { ...migrated, kind: 'account-cli' as const, origin: 'explicit' as const };
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
  const officeRouteOwned = useOfficeTerminalRouteOwnership();
  const [{ serverId, serverGeneration, state }, setScopedState] = useState(() => {
    const id = currentServerId();
    return { serverId: id, serverGeneration: 1, state: readStoredState(id) };
  });
  // Transient explicit user intent for the global floating viewer, fenced by
  // both serverId and monotonic serverGeneration (rejects stale A -> B and A -> B -> A).
  const [floatingIntent, setFloatingIntent] = useState<{
    open: boolean;
    serverId: string;
    serverGeneration: number;
    focusSeq: number;
  }>({ open: false, serverId: '', serverGeneration: 0, focusSeq: 0 });

  const inOffice = overviewVisible || officeRouteOwned;
  const inOfficeRef = useRef(inOffice);
  inOfficeRef.current = inOffice;
  const liveServerScopeRef = useRef({ serverId, generation: serverGeneration });
  if (liveServerScopeRef.current.serverId !== serverId && serverGeneration > liveServerScopeRef.current.generation) {
    liveServerScopeRef.current = { serverId, generation: serverGeneration };
  }

  const isIssuedScopeLive = useCallback((issuedServerId: string, issuedGeneration: number): boolean => (
    liveServerScopeRef.current.serverId === issuedServerId
    && liveServerScopeRef.current.generation === issuedGeneration
    && currentServerId() === issuedServerId
  ), []);

  const floatingOpenForServer = (
    floatingIntent.open
    && floatingIntent.serverId === serverId
    && floatingIntent.serverGeneration === serverGeneration
  );
  const directoryEnabled = shouldPollTerminalDirectory({
    overviewVisible,
    officeRouteOwned,
    floatingOpen: floatingOpenForServer,
    tabs: state.tabs,
  });

  const { directory, interactiveTabs, unavailableTabs, isUnavailable, goneShellKeys } = useTerminalAvailability(
    serverId,
    state.tabs,
    directoryEnabled,
    serverGeneration,
  );

  const hasStoredFloatingTabs = useMemo(
    () => state.tabs.some((tab) => tab.serverId === serverId && isFloatingHostTab(tab)),
    [serverId, state.tabs],
  );
  const hasInteractiveFloatingTabs = useMemo(
    () => interactiveTabs.some((tab) => tab.serverId === serverId && isFloatingHostTab(tab)),
    [interactiveTabs, serverId],
  );

  // Entering an office route, switching servers, or closing the last explicit
  // floating tab clears transient floating viewer intent so navigating away
  // never wakes the global host unprompted.
  useEffect(() => {
    setFloatingIntent((prev) => {
      if (!prev.open) return prev;
      if (
        inOffice
        || prev.serverId !== serverId
        || prev.serverGeneration !== serverGeneration
        || !hasStoredFloatingTabs
      ) {
        return { ...prev, open: false, serverId: '', serverGeneration: 0 };
      }
      return prev;
    });
  }, [hasStoredFloatingTabs, inOffice, serverGeneration, serverId]);

  // Server selection can change without remounting the application shell. Swap
  // to that server's persisted terminal layout and bump monotonic serverGeneration
  // synchronously so stale async callbacks from A (even after A -> B -> A) are fenced.
  useEffect(() => {
    const syncScope = () => {
      const nextServerId = currentServerId();
      if (liveServerScopeRef.current.serverId !== nextServerId) {
        liveServerScopeRef.current = {
          serverId: nextServerId,
          generation: liveServerScopeRef.current.generation + 1,
        };
      }
      const nextGeneration = liveServerScopeRef.current.generation;
      setScopedState((current) => (current.serverId === nextServerId && current.serverGeneration === nextGeneration
        ? current
        : { serverId: nextServerId, serverGeneration: nextGeneration, state: readStoredState(nextServerId) }));
      setFloatingIntent((prev) => (prev.open && (prev.serverId !== nextServerId || prev.serverGeneration !== nextGeneration)
        ? { ...prev, open: false, serverId: '', serverGeneration: 0 }
        : prev));
    };
    syncScope();
    return addActiveControlPlaneProfileChangeListener(syncScope);
  }, []);

  const update = useCallback((next: WebTerminalLayoutState | ((current: WebTerminalLayoutState) => WebTerminalLayoutState)) => {
    setScopedState((current) => {
      const change = typeof next === 'function' ? next : () => next;
      const updated = updateTerminalScope(current, serverId, change, readStoredState, persistState);
      return updated === current ? current : { ...current, state: updated.state };
    });
  }, [serverId]);

  const openTab = useCallback((input: OpenWebTerminalTabInput) => {
    const sessionKey = String(input.sessionKey || '').trim();
    if (!sessionKey) return;
    const issuedServerId = serverId;
    const issuedGeneration = serverGeneration;
    const targetServerId = String(input.serverId || issuedServerId).trim() || issuedServerId;
    const openingInOffice = inOfficeRef.current || isOfficeTerminalRoute();
    const requestedOrigin: WebTerminalTabOrigin = input.origin || (openingInOffice ? 'adopted' : 'explicit');
    const canActivateFloating = (
      !openingInOffice
      && requestedOrigin === 'explicit'
      && targetServerId === issuedServerId
      && isIssuedScopeLive(issuedServerId, issuedGeneration)
    );
    const tab: WebTerminalTab = {
      id: makeTabId(sessionKey),
      sessionKey,
      label: String(input.label || 'Web Terminal').trim() || 'Web Terminal',
      cwd: String(input.cwd || ''),
      serverId: targetServerId,
      kind: input.kind || 'account-cli',
      origin: requestedOrigin,
      harness: String(input.harness || '').trim() || undefined,
      model: String(input.model || '').trim() || undefined,
      nativeSessionId: String(input.nativeSessionId || '').trim() || undefined
    };
    setScopedState((current) => {
      // A launch may finish after the user switches servers. Preserve it in
      // the originating server's layout instead of attaching it to this one.
      const updated = updateTerminalScope(current, targetServerId, (targetState) => {
        const existing = targetState.tabs.findIndex((item) => item.id === tab.id);
        const tabs = targetState.tabs.slice();
        if (existing >= 0) {
          tabs[existing] = {
            ...tabs[existing],
            ...tab,
            origin: promoteTabOrigin(tabs[existing].origin, requestedOrigin),
          };
        } else {
          tabs.push(tab);
        }
        return {
          ...targetState,
          tabs,
          activeTabId: tab.id,
          minimized: canActivateFloating ? false : targetState.minimized,
        };
      }, readStoredState, persistState);
      return updated === current ? current : { ...current, state: updated.state };
    });
    if (canActivateFloating) {
      setFloatingIntent((prev) => ({
        open: true,
        serverId: issuedServerId,
        serverGeneration: issuedGeneration,
        focusSeq: prev.focusSeq + 1,
      }));
    }
  }, [isIssuedScopeLive, serverGeneration, serverId]);

  const closeTab = useCallback((id: string) => {
    update((current) => {
      const selected = current.tabs.find((tab) => tab.id === id);
      // Removing an unavailable viewer is not a request to forget its task.
      // 项目 shell 没有可保的任务：它的 PTY 已不存在，保留只会留下幽灵工位。
      const shellWithoutTask = Boolean(selected) && !selected!.sessionKey.startsWith('native:');
      if (selected && isUnavailable(selected.sessionKey) && !shellWithoutTask) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      return { ...current, tabs, activeTabId: current.activeTabId === id ? (tabs[tabs.length - 1]?.id || '') : current.activeTabId };
    });
  }, [isUnavailable, update]);

  // 连续两次目录快照都确认服务端已不存在该 shell：直接移除，不留幽灵工位。
  useEffect(() => {
    if (!goneShellKeys.size) return;
    update((current) => {
      const tabs = current.tabs.filter((tab) => !goneShellKeys.has(tab.sessionKey));
      if (tabs.length === current.tabs.length) return current;
      const activeTabId = tabs.some((tab) => tab.id === current.activeTabId)
        ? current.activeTabId
        : (tabs[tabs.length - 1]?.id || '');
      return { ...current, tabs, activeTabId };
    });
  }, [goneShellKeys, update]);

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
        tabs.push({
          id: makeTabId(input.sessionKey),
          sessionKey: input.sessionKey,
          serverId,
          label: input.label,
          cwd: input.cwd || '',
          kind: input.kind || 'account-cli',
          origin: 'adopted',
          harness: input.harness,
          nativeSessionId: input.nativeSessionId,
        });
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

  const setActiveTab = useCallback((id: string) => {
    const issuedServerId = serverId;
    const issuedGeneration = serverGeneration;
    if (!isIssuedScopeLive(issuedServerId, issuedGeneration)) return;
    const outsideOffice = !inOfficeRef.current && !isOfficeTerminalRoute();
    update((current) => {
      const idx = current.tabs.findIndex((tab) => tab.id === id);
      if (idx < 0) return current;
      const targetTab = current.tabs[idx];
      if (!outsideOffice || targetTab.origin === 'explicit') {
        return current.activeTabId === id ? current : { ...current, activeTabId: id };
      }
      const tabs = current.tabs.slice();
      tabs[idx] = { ...targetTab, origin: 'explicit' };
      return { ...current, tabs, activeTabId: id };
    });
    if (outsideOffice) {
      setFloatingIntent((prev) => (
        prev.open && prev.serverId === issuedServerId && prev.serverGeneration === issuedGeneration
          ? { ...prev, focusSeq: prev.focusSeq + 1 }
          : prev
      ));
    }
  }, [isIssuedScopeLive, serverGeneration, serverId, update]);

  const setMinimized = useCallback((value: boolean) => {
    const issuedServerId = serverId;
    const issuedGeneration = serverGeneration;
    if (!isIssuedScopeLive(issuedServerId, issuedGeneration)) return;
    update((current) => (current.minimized === value ? current : { ...current, minimized: value }));
    if (value) {
      setFloatingIntent((prev) => (prev.open ? { ...prev, open: false, serverId: '', serverGeneration: 0 } : prev));
      return;
    }
    if (!inOfficeRef.current && !isOfficeTerminalRoute()) {
      setFloatingIntent((prev) => ({
        open: true,
        serverId: issuedServerId,
        serverGeneration: issuedGeneration,
        focusSeq: prev.focusSeq + 1,
      }));
    }
  }, [isIssuedScopeLive, serverGeneration, serverId, update]);

  const setLayout = useCallback((layout: WebTerminalLayoutState['layout']) => update((current) => ({ ...current, layout })), [update]);
  const setPosition = useCallback((position: Partial<WebTerminalLayoutState['position']>) => update((current) => ({
    ...current,
    position: { ...current.position, ...position }
  })), [update]);

  const floatingVisible = isFloatingViewerVisible({
    floatingOpen: floatingIntent.open,
    floatingServerId: floatingIntent.serverId,
    floatingServerGeneration: floatingIntent.serverGeneration,
    currentServerId: serverId,
    currentServerGeneration: serverGeneration,
    overviewVisible,
    officeRouteOwned,
    hasFloatingTabs: hasInteractiveFloatingTabs,
  });

  const value = useMemo<WebTerminalManagerValue>(() => ({
    ...state,
    minimized: !floatingVisible,
    tabs: interactiveTabs,
    unavailableTabs,
    goneShellKeys,
    activeTabId: interactiveTabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : interactiveTabs[0]?.id || '',
    serverId,
    overviewVisible,
    floatingOpen: floatingOpenForServer,
    focusRequestSeq: floatingIntent.focusSeq,
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
  }), [adoptSessions, closeAll, closeTab, directory, floatingIntent.focusSeq, floatingOpenForServer, floatingVisible, interactiveTabs, openTab, overviewVisible, serverId, setActiveTab, setLayout, setMinimized, setPosition, state, unavailableTabs]);
  return <WebTerminalManagerContext.Provider value={value}>{children}</WebTerminalManagerContext.Provider>;
}

export function useWebTerminalManager(): WebTerminalManagerValue {
  const value = useContext(WebTerminalManagerContext);
  if (!value) throw new Error('useWebTerminalManager must be used inside WebTerminalManagerProvider');
  return value;
}
