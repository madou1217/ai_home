import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { terminalAPI } from '@/services/api';
import { resolveActiveServer } from '@/services/webui-auth-transport';
import {
  DEFAULT_OFFICE_COMPUTER_PREFERENCES,
  readOfficeComputerPreferences,
  subscribeOfficeComputerPreferences,
  updateOfficeComputerPreferences,
  type OfficeComputerPreferences,
} from './office-computer-state';
import type { OfficeSessionItem } from './session-office-types';

export type BootRestorePhase =
  | 'idle'
  | 'checking'
  | 'attaching'
  | 'restored'
  | 'unavailable'
  | 'exited';

export interface SessionDurabilityNote {
  badge: string;
  summary: string;
  isNative: boolean;
}

export interface DesktopActionSemanticItem {
  id: 'minimize' | 'return-room' | 'virtual-power' | 'terminate-session';
  label: string;
  summary: string;
  destructive: boolean;
}

export const OFFICE_DESKTOP_ACTION_SEMANTICS: readonly DesktopActionSemanticItem[] = Object.freeze([
  {
    id: 'minimize',
    label: '窗口最小化',
    summary: '仅收起当前窗口到底部任务栏，虚拟电脑保持开机，终端实时连接不断开。',
    destructive: false,
  },
  {
    id: 'return-room',
    label: '返回房间',
    summary: '退出全屏桌面回到 3D 办公室，当前虚拟电源状态与后台进程原样保持。',
    destructive: false,
  },
  {
    id: 'virtual-power',
    label: '虚拟电脑关机 / 开机',
    summary: '关机仅熄灭虚拟显示器并断开前端终端附着流，绝不发送 close 或退出进程；开机按原 sessionKey 重连。',
    destructive: false,
  },
  {
    id: 'terminate-session',
    label: '关闭会话',
    summary: '不可逆停止并清理该 Web Shell 服务端进程（需确认）；原生 CLI 受独立宿主边界保护而禁用。',
    destructive: true,
  },
]);

const FALLBACK_PREFERENCES: OfficeComputerPreferences = DEFAULT_OFFICE_COMPUTER_PREFERENCES;

/**
 * Normalizes the live global API server scope identically to WebTerminalManagerProvider
 * (`String(resolveActiveServer().serverId || 'local').trim() || 'local'`).
 */
export function resolveLiveActiveServerId(): string {
  try {
    return String(resolveActiveServer().serverId || 'local').trim() || 'local';
  } catch {
    return 'local';
  }
}

/**
 * Validates that `serverId`, `session.serverId`, live active API server scope,
 * and (when present) `session.tab` identity/server scope all strictly agree.
 */
export function isSessionServerScopeAdmitted(
  serverId: string,
  session: Pick<OfficeSessionItem, 'serverId' | 'sessionKey' | 'tab'> | null | undefined,
): boolean {
  const sid = String(serverId || '').trim();
  const skey = String(session?.sessionKey || '').trim();
  const sessionSid = String(session?.serverId || '').trim();
  if (!sid || !skey || !sessionSid) return false;
  if (sessionSid !== sid) return false;
  if (resolveLiveActiveServerId() !== sid) return false;
  if (session?.tab) {
    const tabKey = String(session.tab.sessionKey || '').trim();
    const tabSid = String(session.tab.serverId || '').trim();
    if (!tabKey || tabKey !== skey) return false;
    if (!tabSid || tabSid !== sid) return false;
  }
  return true;
}

/**
 * Strict admission required before preflight `terminalAPI.listSessions()` and before
 * mounting `ShellTerminalPanel` with controlled `sessionTabs`.
 */
export function isTerminalTabScopeAdmitted(
  serverId: string,
  session: Pick<OfficeSessionItem, 'serverId' | 'sessionKey' | 'tab'> | null | undefined,
): boolean {
  if (!isSessionServerScopeAdmitted(serverId, session)) return false;
  const tab = session?.tab;
  if (!tab) return false;
  const tabId = String(tab.id || '').trim();
  const tabKey = String(tab.sessionKey || '').trim();
  const tabSid = String(tab.serverId || '').trim();
  const sid = String(serverId || '').trim();
  const skey = String(session?.sessionKey || '').trim();
  return Boolean(tabId && tabKey === skey && tabSid === sid);
}

let localRevision = 0;
let unsubSharedStore: (() => void) | null = null;
const revisionListeners = new Set<() => void>();

function subscribeRevision(listener: () => void): () => void {
  revisionListeners.add(listener);
  if (!unsubSharedStore) {
    unsubSharedStore = subscribeOfficeComputerPreferences(() => {
      localRevision += 1;
      for (const item of [...revisionListeners]) {
        item();
      }
    });
  }
  return () => {
    revisionListeners.delete(listener);
    if (revisionListeners.size === 0 && unsubSharedStore) {
      unsubSharedStore();
      unsubSharedStore = null;
    }
  };
}

function getRevisionSnapshot(): number {
  return localRevision;
}

function getServerRevisionSnapshot(): number {
  return 0;
}

export function useOfficeComputerStoreRevision(): number {
  return useSyncExternalStore(subscribeRevision, getRevisionSnapshot, getServerRevisionSnapshot);
}

export function readStationPowerState(serverId: string, sessionKey: string): 'on' | 'off' {
  if (!serverId.trim() || !sessionKey.trim()) return 'on';
  return readOfficeComputerPreferences(serverId, sessionKey).power;
}

export function buildStationPowerMap(
  serverId: string,
  sessions: ReadonlyArray<{ sessionKey: string; serverId?: string }>,
  revision: number,
): Map<string, 'on' | 'off'> {
  const map = new Map<string, 'on' | 'off'>();
  const sid = serverId.trim();
  if (revision < 0 || !sid) return map;
  for (const item of sessions) {
    if (item.serverId && item.serverId.trim() !== sid) continue;
    map.set(item.sessionKey, readStationPowerState(sid, item.sessionKey));
  }
  return map;
}

export function useOfficeComputerPreferences(
  serverId: string,
  sessionKey: string,
  scopeAdmitted = true,
): OfficeComputerPreferences {
  const getSnapshot = useCallback((): OfficeComputerPreferences => {
    const sid = serverId.trim();
    const skey = sessionKey.trim();
    if (!scopeAdmitted || !sid || !skey) return FALLBACK_PREFERENCES;
    return readOfficeComputerPreferences(sid, skey);
  }, [scopeAdmitted, serverId, sessionKey]);

  const getServerSnapshot = useCallback((): OfficeComputerPreferences => FALLBACK_PREFERENCES, []);

  return useSyncExternalStore(
    subscribeOfficeComputerPreferences,
    getSnapshot,
    getServerSnapshot,
  );
}

export function describeSessionDurability(
  session: OfficeSessionItem | null | undefined,
): SessionDurabilityNote {
  if (!session) {
    return {
      badge: '未选定工位',
      summary: '请先选定工位后再切换虚拟电脑电源或外观偏好。',
      isNative: false,
    };
  }
  const isNative = session.source === 'native' || session.sessionKey.startsWith('native:');
  if (isNative) {
    return {
      badge: '独立宿主 CLI',
      summary: '虚拟关机仅断开当前浏览器附着流；原 CLI 在外部宿主进程中运行（不保证跨宿主机/系统重启或外部退出后仍存活）。开机按原标识尝试重连，缺失时如实提示且绝不静默新建会话。',
      isNative: true,
    };
  }
  return {
    badge: '受控会话通道',
    summary: '虚拟关机仅卸载终端面板并断开事件流，不调用 close 或结束 Shell；仅当服务端原会话或宿主 tmux 仍存活时可恢复（目录未提供 durable 证明，不保证跨后端或系统重启恢复），缺失时如实报告不可接入。',
    isNative: false,
  };
}

interface ScopedBootState {
  scopeId: string;
  phase: BootRestorePhase;
  reason: string;
}

export interface UseOfficeComputerPowerOptions {
  open: boolean;
  serverId: string;
  session: OfficeSessionItem | null;
  canAttachBase: boolean;
  isTerminating: boolean;
  terminalHostRef: RefObject<HTMLDivElement | null>;
  onRefreshAll: () => void;
}

export interface OfficeComputerPowerController {
  preferences: OfficeComputerPreferences;
  isPoweredOn: boolean;
  terminalReady: boolean;
  bootPhase: BootRestorePhase;
  bootReason: string;
  shouldMountTerminal: boolean;
  durabilityNote: SessionDurabilityNote;
  powerOffComputer: () => void;
  bootComputer: () => void;
  toggleDualMonitor: () => void;
  updateAppearance: (
    patch: Partial<Pick<OfficeComputerPreferences, 'wallpaper' | 'dualMonitor' | 'rgbEnabled' | 'rgbColor'>>,
  ) => void;
}

export function useOfficeComputerPowerController({
  open,
  serverId,
  session,
  canAttachBase,
  isTerminating,
  terminalHostRef,
  onRefreshAll,
}: UseOfficeComputerPowerOptions): OfficeComputerPowerController {
  const sessionAdmitted = isSessionServerScopeAdmitted(serverId, session);
  const tabAdmitted = isTerminalTabScopeAdmitted(serverId, session);
  const sessionKey = sessionAdmitted ? String(session?.sessionKey || '').trim() : '';
  const trimmedServerId = sessionAdmitted ? serverId.trim() : '';
  const scopeId = trimmedServerId && sessionKey ? `${trimmedServerId}\0${sessionKey}` : '';

  const preferences = useOfficeComputerPreferences(trimmedServerId, sessionKey, sessionAdmitted);
  const isPoweredOn = preferences.power === 'on';

  const [bootState, setBootState] = useState<ScopedBootState>({
    scopeId: '',
    phase: 'idle',
    reason: '',
  });
  const [readyScopeId, setReadyScopeId] = useState<string>('');

  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const latestScopeRef = useRef(scopeId);
  const latestPowerRef = useRef(preferences.power);
  latestPowerRef.current = preferences.power;
  const needsPostAttachSyncRef = useRef<string>('');
  const onRefreshAllRef = useRef(onRefreshAll);
  onRefreshAllRef.current = onRefreshAll;

  // Discard stale boot sequences synchronously during render BEFORE async effects/microtasks
  // whenever server/session scope switches or admission becomes invalid.
  if (latestScopeRef.current !== scopeId) {
    latestScopeRef.current = scopeId;
    requestSeqRef.current += 1;
    needsPostAttachSyncRef.current = '';
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!isPoweredOn || !scopeId) {
      requestSeqRef.current += 1;
      needsPostAttachSyncRef.current = '';
      setReadyScopeId((prev) => (prev ? '' : prev));
    }
  }, [isPoweredOn, scopeId]);

  const effectiveBootState: ScopedBootState = useMemo(() => {
    if (!scopeId || !isPoweredOn || bootState.scopeId !== scopeId) {
      return { scopeId, phase: 'idle', reason: '' };
    }
    return bootState;
  }, [bootState, isPoweredOn, scopeId]);

  const powerOffComputer = useCallback(() => {
    if (isTerminating || !isSessionServerScopeAdmitted(serverId, session) || !session) return;
    const sid = serverId.trim();
    const skey = session.sessionKey.trim();
    const targetScope = `${sid}\0${skey}`;
    requestSeqRef.current += 1;
    needsPostAttachSyncRef.current = '';
    latestPowerRef.current = 'off';
    setReadyScopeId('');
    setBootState({ scopeId: targetScope, phase: 'idle', reason: '' });
    // Virtual workstation power off ONLY: update scoped UI preference so
    // ShellTerminalPanel unmounts cleanly without close or manager tab removal.
    updateOfficeComputerPreferences(sid, skey, { power: 'off' });
  }, [isTerminating, serverId, session]);

  const bootComputer = useCallback(() => {
    if (isTerminating || !isSessionServerScopeAdmitted(serverId, session) || !session) return;
    const sid = serverId.trim();
    const skey = session.sessionKey.trim();
    const targetScope = `${sid}\0${skey}`;
    const reqId = ++requestSeqRef.current;
    const isNative = Boolean(session.source === 'native' || skey.startsWith('native:'));

    latestScopeRef.current = targetScope;
    latestPowerRef.current = 'on';
    setReadyScopeId('');
    updateOfficeComputerPreferences(sid, skey, { power: 'on' });

    if (!canAttachBase || !isTerminalTabScopeAdmitted(sid, session)) {
      const exited = session.availability === 'exited';
      setBootState({
        scopeId: targetScope,
        phase: exited ? 'exited' : 'unavailable',
        reason: exited
          ? '该工位关联的终端进程已退出；原会话标识已保留，系统不会静默新建替代终端。'
          : '当前工位未具备已核实的受控附着入口；已触发目录核对，绝不静默启动新 Shell。',
      });
      if (resolveLiveActiveServerId() === sid) {
        onRefreshAllRef.current();
      }
      return;
    }

    setBootState({
      scopeId: targetScope,
      phase: 'checking',
      reason: '正在核对服务端原会话标识与存活状态…',
    });

    const sessionSnapshot = session;
    void (async () => {
      const isCurrentAndAdmitted = () => (
        mountedRef.current
        && latestScopeRef.current === targetScope
        && latestPowerRef.current === 'on'
        && requestSeqRef.current === reqId
        && isTerminalTabScopeAdmitted(sid, sessionSnapshot)
      );

      if (!isCurrentAndAdmitted()) return;

      try {
        const listed = await terminalAPI.listSessions();
        if (!isCurrentAndAdmitted()) return;

        if (listed?.ok && Array.isArray(listed.sessions)) {
          const matched = listed.sessions.find((item) => item.sessionKey === skey);
          if (matched?.status === 'exited') {
            setBootState({
              scopeId: targetScope,
              phase: 'exited',
              reason: '原会话进程已在虚拟关机期间自然结束；历史标识已完整保留，未自动创建替代终端。',
            });
            onRefreshAllRef.current();
            return;
          }
          if (!matched && isNative) {
            setBootState({
              scopeId: targetScope,
              phase: 'unavailable',
              reason: '未在当前服务器检出该原生 CLI 的存活 tmux 会话；原标识已保留，未自动启动新会话。',
            });
            onRefreshAllRef.current();
            return;
          }
          if (!matched && !isNative) {
            needsPostAttachSyncRef.current = targetScope;
          } else {
            needsPostAttachSyncRef.current = '';
          }
        }
      } catch {
        if (!isCurrentAndAdmitted()) return;
      }

      if (!isCurrentAndAdmitted()) return;
      setBootState({
        scopeId: targetScope,
        phase: 'attaching',
        reason: '正在按原会话标识重新接入持久终端…',
      });
    })();
  }, [canAttachBase, isTerminating, serverId, session]);

  const shouldMountTerminal = Boolean(
    open
    && isPoweredOn
    && canAttachBase
    && tabAdmitted
    && effectiveBootState.phase !== 'checking'
    && effectiveBootState.phase !== 'unavailable'
    && effectiveBootState.phase !== 'exited',
  );

  // Observe ShellTerminalPanel's tab dot status on attach so:
  // 1) real ready state is observed truthfully for config facts;
  // 2) missing identities transition cleanly to explicit unavailable/exited UI without fallback shells.
  useEffect(() => {
    if (!shouldMountTerminal || !scopeId) {
      setReadyScopeId((prev) => (prev ? '' : prev));
      return undefined;
    }
    const host = terminalHostRef.current;
    if (!host || typeof MutationObserver === 'undefined') return undefined;

    const targetScope = scopeId;
    const targetSid = trimmedServerId;
    let reachedReady = false;
    const evaluateTabDot = () => {
      if (
        !mountedRef.current
        || latestScopeRef.current !== targetScope
        || latestPowerRef.current !== 'on'
        || resolveLiveActiveServerId() !== targetSid
      ) {
        return;
      }
      const dot = host.querySelector('[data-terminal-tab="true"] [data-status]');
      const status = dot?.getAttribute('data-status');
      if (status === 'ready') {
        reachedReady = true;
        setReadyScopeId(targetScope);
        setBootState((prev) => (
          prev.scopeId === targetScope && prev.phase === 'attaching'
            ? { scopeId: targetScope, phase: 'restored', reason: '已按原会话标识恢复连接' }
            : prev
        ));
        if (needsPostAttachSyncRef.current === targetScope) {
          needsPostAttachSyncRef.current = '';
          onRefreshAllRef.current();
        }
      } else {
        setReadyScopeId((prev) => (prev === targetScope ? '' : prev));
        if (
          !reachedReady
          && (effectiveBootState.phase === 'idle' || effectiveBootState.phase === 'attaching')
          && (status === 'error' || status === 'closed')
        ) {
          needsPostAttachSyncRef.current = '';
          setBootState({
            scopeId: targetScope,
            phase: status === 'closed' ? 'exited' : 'unavailable',
            reason: status === 'closed'
              ? '原会话进程已退出；原会话标识已保留，未自动创建替代终端。'
              : '服务端未能恢复接入该原会话（原终端会话不存在或已结束）；未自动创建替代终端。',
          });
          onRefreshAllRef.current();
        }
      }
    };

    evaluateTabDot();
    const observer = new MutationObserver(evaluateTabDot);
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-status'],
    });
    return () => observer.disconnect();
  }, [effectiveBootState.phase, scopeId, shouldMountTerminal, terminalHostRef, trimmedServerId]);

  const updateAppearance = useCallback((
    patch: Partial<Pick<OfficeComputerPreferences, 'wallpaper' | 'dualMonitor' | 'rgbEnabled' | 'rgbColor'>>,
  ) => {
    if (isTerminating || !isSessionServerScopeAdmitted(serverId, session) || !session) return;
    updateOfficeComputerPreferences(serverId.trim(), session.sessionKey.trim(), patch);
  }, [isTerminating, serverId, session]);

  const toggleDualMonitor = useCallback(() => {
    if (isTerminating || !isSessionServerScopeAdmitted(serverId, session) || !session) return;
    const sid = serverId.trim();
    const skey = session.sessionKey.trim();
    const current = readOfficeComputerPreferences(sid, skey);
    updateOfficeComputerPreferences(sid, skey, {
      dualMonitor: !current.dualMonitor,
    });
  }, [isTerminating, serverId, session]);

  const durabilityNote = useMemo(() => describeSessionDurability(session), [session]);
  const terminalReady = Boolean(shouldMountTerminal && scopeId && readyScopeId === scopeId);

  return {
    preferences,
    isPoweredOn,
    terminalReady,
    bootPhase: effectiveBootState.phase,
    bootReason: effectiveBootState.reason,
    shouldMountTerminal,
    durabilityNote,
    powerOffComputer,
    bootComputer,
    toggleDualMonitor,
    updateAppearance,
  };
}
