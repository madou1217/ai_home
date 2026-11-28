import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import {
  AimOutlined,
  ApartmentOutlined,
  AppstoreOutlined,
  CheckOutlined,
  CompassOutlined,
  CompressOutlined,
  CopyOutlined,
  DesktopOutlined,
  DragOutlined,
  EyeOutlined,
  LeftOutlined,
  MoreOutlined,
  PlusOutlined,
  PoweroffOutlined,
  RightOutlined,
  StopOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, type MenuProps } from 'antd';
import HudStateView from '@/components/hud/HudStateView';
import { useThemeMode } from '@/hooks/use-theme-mode';
import type {
  DesktopOriginRect,
  OfficeCameraPreset,
  OfficeProjectRoom,
  OfficeSessionItem,
  SessionAvailability,
} from './session-office-types';
import type {
  OfficeHoverInfo,
  OfficeMonitorDragMode,
  OfficeMonitorIndex,
  OfficeSceneCallbacks,
  OfficeSceneSyncState,
} from './office-scene-types';
import {
  clampOfficeMonitorTransform,
  DEFAULT_OFFICE_MONITOR_TRANSFORMS,
  readOfficeComputerPreferences,
  readOfficeComputerPreferencesRevision,
  resetOfficeComputerMonitors,
  subscribeOfficeComputerPreferences,
  updateOfficeComputerPreferences,
  type OfficeComputerPreferences,
  type OfficeMonitorTransform,
} from './office-computer-state';
import { OfficeSceneController } from './office-scene-controller';
import OfficeMonitorControls from './OfficeMonitorControls';
import './OfficeRoom.css';

export interface OfficeRoomProps {
  serverId: string;
  room: OfficeProjectRoom | null;
  selectedSessionId: string | null;
  zoomingSessionId: string | null;
  cameraPreset: OfficeCameraPreset;
  onCameraPresetChange: (preset: OfficeCameraPreset) => void;
  onOpenMonitor: (session: OfficeSessionItem, originRect?: DesktopOriginRect) => void;
  onCopyIdentity: (session: OfficeSessionItem) => void;
  onOpenNewTerminal: (cwd?: string) => void;
  directoryLoading: boolean;
  onTerminateSession?: (session: OfficeSessionItem) => void | Promise<void>;
  onToggleStationPower?: (session: OfficeSessionItem) => void;
  terminatingSessionKey?: string | null;
}

const ZONE_PAGE_SIZE = 8;
const MAX_SHOW_ALL_STATIONS = 12;

const CAMERA_OPTIONS: ReadonlyArray<{
  preset: OfficeCameraPreset;
  label: string;
  title: string;
}> = [
  { preset: 'isometric', label: '等距视角', title: '立体等距视角 (Isometric)' },
  { preset: 'corridor', label: '走廊视角', title: '纵深走廊视角 (Corridor)' },
  { preset: 'overview', label: '全景俯瞰', title: '空间全景俯瞰 (Overview)' },
];

function renderCameraIcon(preset: OfficeCameraPreset) {
  switch (preset) {
    case 'isometric':
      return <CompassOutlined aria-hidden="true" />;
    case 'corridor':
      return <EyeOutlined aria-hidden="true" />;
    case 'overview':
      return <ApartmentOutlined aria-hidden="true" />;
  }
}

function getAvailabilityMeta(availability: SessionAvailability): {
  label: string;
  ledClass: string;
  toneClass: string;
} {
  switch (availability) {
    case 'interactive':
      return {
        label: '运行中',
        ledClass: 'hud-led hud-led--ok hud-led--live',
        toneClass: 'office-tone--interactive',
      };
    case 'directory-only':
      return {
        label: '目录在线',
        ledClass: 'hud-led hud-led--info',
        toneClass: 'office-tone--directory',
      };
    case 'unavailable':
      return {
        label: '标识保留',
        ledClass: 'hud-led hud-led--warn',
        toneClass: 'office-tone--unavailable',
      };
    case 'exited':
      return {
        label: '已退出',
        ledClass: 'hud-led',
        toneClass: 'office-tone--exited',
      };
  }
}

function isTerminableWebShell(session: OfficeSessionItem): boolean {
  if (session.source !== 'web') return false;
  if (session.availability === 'exited' || session.availability === 'unavailable') return false;
  return true;
}

function resolveRealDockSnippet(session: OfficeSessionItem): {
  tag: string;
  text: string;
} {
  const preview = (session.contentPreview || '').trim();
  if (preview) {
    return { tag: 'PREVIEW', text: preview };
  }
  const cwd = (session.cwd || '').trim();
  if (cwd && cwd !== '__no_cwd__') {
    return { tag: 'CWD', text: cwd };
  }
  return {
    tag: 'ID',
    text: session.nativeSessionId || session.sessionKey,
  };
}

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const getServerPrefsRevision = (): number => 0;

export function OfficeRoom({
  serverId,
  room,
  selectedSessionId,
  zoomingSessionId,
  cameraPreset,
  onCameraPresetChange,
  onOpenMonitor,
  onCopyIdentity,
  onOpenNewTerminal,
  directoryLoading,
  onTerminateSession,
  onToggleStationPower,
  terminatingSessionKey = null,
}: OfficeRoomProps) {
  const themeMode = useThemeMode();
  const prefsRevision = useSyncExternalStore(
    subscribeOfficeComputerPreferences,
    readOfficeComputerPreferencesRevision,
    getServerPrefsRevision
  );
  const [reducedMotion, setReducedMotion] = useState<boolean>(readReducedMotion);
  const [zoneIndex, setZoneIndex] = useState(0);
  const [showAllPods, setShowAllPods] = useState(false);
  const [focusedSessionKey, setFocusedSessionKey] = useState<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<OfficeHoverInfo | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [webglError, setWebglError] = useState('');
  const [monitorEditMode, setMonitorEditMode] = useState(false);
  const [activeEditMonitorIndex, setActiveEditMonitorIndex] = useState<OfficeMonitorIndex>(0);
  const [monitorDragMode, setMonitorDragMode] = useState<OfficeMonitorDragMode>('xz');
  const [liveMonitorPreview, setLiveMonitorPreview] = useState<{
    serverId: string;
    sessionKey: string;
    monitorIndex: OfficeMonitorIndex;
    transform: OfficeMonitorTransform;
  } | null>(null);

  const canvasHostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<OfficeSceneController | null>(null);
  const stationButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const prevRoomKeyRef = useRef<string>('');
  const prevSelectedPropIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = () => setReducedMotion(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const roomKey = room?.projectKey || '';
  const totalSessions = room?.sessions.length ?? 0;
  const canShowAll = totalSessions > ZONE_PAGE_SIZE && totalSessions <= MAX_SHOW_ALL_STATIONS;
  const effectiveShowAll = showAllPods && canShowAll;
  const totalZones = Math.max(1, Math.ceil(totalSessions / ZONE_PAGE_SIZE));

  // Reset pagination when switching project rooms
  useEffect(() => {
    if (prevRoomKeyRef.current !== roomKey) {
      prevRoomKeyRef.current = roomKey;
      setZoneIndex(0);
      setShowAllPods(false);
      setHoverInfo(null);
      setMonitorEditMode(false);
      setLiveMonitorPreview(null);
    }
  }, [roomKey]);

  // Clamp zoneIndex if filtered session list shrinks
  useEffect(() => {
    if (zoneIndex >= totalZones) {
      setZoneIndex(Math.max(0, totalZones - 1));
    }
  }, [totalZones, zoneIndex]);

  // Keep focusedSessionKey synchronized when parent room or selectedSessionId prop changes,
  // while letting local 3D clicks & keyboard selection move freely between stations.
  useEffect(() => {
    if (!room) {
      setFocusedSessionKey(null);
      prevSelectedPropIdRef.current = null;
      return;
    }

    const propSession = selectedSessionId
      ? room.sessions.find((item) => item.id === selectedSessionId) ?? null
      : null;

    const propChanged = prevSelectedPropIdRef.current !== selectedSessionId;
    prevSelectedPropIdRef.current = selectedSessionId;

    if (propChanged && propSession) {
      setFocusedSessionKey(propSession.sessionKey);
      if (!effectiveShowAll) {
        const idx = room.sessions.findIndex((item) => item.sessionKey === propSession.sessionKey);
        if (idx >= 0) {
          const targetZone = Math.floor(idx / ZONE_PAGE_SIZE);
          setZoneIndex((prev) => (prev === targetZone ? prev : targetZone));
        }
      }
      return;
    }

    setFocusedSessionKey((current) => {
      if (current && room.sessions.some((item) => item.sessionKey === current)) {
        return current;
      }
      if (propSession) return propSession.sessionKey;
      return room.sessions[0]?.sessionKey ?? null;
    });
  }, [effectiveShowAll, room, selectedSessionId]);

  const visibleSessions = useMemo(() => {
    if (!room) return [];
    if (effectiveShowAll || room.sessions.length <= ZONE_PAGE_SIZE) {
      return room.sessions;
    }
    const start = zoneIndex * ZONE_PAGE_SIZE;
    return room.sessions.slice(start, start + ZONE_PAGE_SIZE);
  }, [effectiveShowAll, room, zoneIndex]);

  // Resolve active selected session within current room/zone
  const activeSession = useMemo<OfficeSessionItem | null>(() => {
    if (!room || room.sessions.length === 0) return null;
    if (focusedSessionKey) {
      const inVisible = visibleSessions.find((item) => item.sessionKey === focusedSessionKey);
      if (inVisible) return inVisible;
      const inRoom = room.sessions.find((item) => item.sessionKey === focusedSessionKey);
      if (inRoom) return inRoom;
    }
    return visibleSessions[0] ?? room.sessions[0] ?? null;
  }, [focusedSessionKey, room, visibleSessions]);

  const effectiveSelectedKey = activeSession?.sessionKey ?? null;
  const resolvedServerId = serverId || activeSession?.serverId || room?.sessions[0]?.serverId || 'local';

  const computerPreferencesByKey = useMemo<Readonly<Record<string, OfficeComputerPreferences>>>(() => {
    if (prefsRevision < 0) return {};
    const map: Record<string, OfficeComputerPreferences> = {};
    for (const session of visibleSessions) {
      const sid = serverId || session.serverId || 'local';
      map[session.sessionKey] = readOfficeComputerPreferences(sid, session.sessionKey);
    }
    return map;
  }, [prefsRevision, serverId, visibleSessions]);

  const activeComputerPrefs = useMemo<OfficeComputerPreferences | null>(() => {
    if (!activeSession) return null;
    const sid = serverId || activeSession.serverId || 'local';
    return computerPreferencesByKey[activeSession.sessionKey]
      ?? readOfficeComputerPreferences(sid, activeSession.sessionKey);
  }, [activeSession, computerPreferencesByKey, serverId]);
  const isMonitorEditActive = Boolean(monitorEditMode && activeSession && activeComputerPrefs);

  useEffect(() => {
    if (!activeComputerPrefs?.dualMonitor) {
      if (activeEditMonitorIndex === 1) {
        setActiveEditMonitorIndex(0);
      }
      setLiveMonitorPreview((prev) => (prev?.monitorIndex === 1 ? null : prev));
    }
  }, [activeComputerPrefs?.dualMonitor, activeEditMonitorIndex]);

  useEffect(() => {
    setLiveMonitorPreview(null);
  }, [effectiveSelectedKey, monitorEditMode, resolvedServerId]);

  useEffect(() => {
    const editingActive = monitorEditMode && Boolean(effectiveSelectedKey);
    controllerRef.current?.setMonitorEditState(
      editingActive,
      activeEditMonitorIndex,
      monitorDragMode
    );
  }, [activeEditMonitorIndex, effectiveSelectedKey, monitorDragMode, monitorEditMode]);

  const sceneSyncState = useMemo<OfficeSceneSyncState | null>(() => {
    if (!room) return null;
    return {
      serverId: resolvedServerId,
      roomKey: room.projectKey,
      roomName: room.projectName,
      projectPath: room.projectPath,
      isFallbackRoom: room.isFallbackRoom,
      runningCount: room.runningCount,
      totalSessionCount: room.sessions.length,
      sessions: visibleSessions,
      selectedSessionKey: effectiveSelectedKey,
      computerPreferences: computerPreferencesByKey,
      cameraPreset,
      theme: themeMode,
      reducedMotion,
    };
  }, [
    cameraPreset,
    computerPreferencesByKey,
    effectiveSelectedKey,
    reducedMotion,
    resolvedServerId,
    room,
    themeMode,
    visibleSessions,
  ]);

  // Keep latest callbacks and session snapshots in refs so the single WebGL controller
  // persists across room switches, message ticks, and preview refreshes.
  const latestRef = useRef({
    propServerId: serverId,
    serverId: resolvedServerId,
    roomSessions: room?.sessions ?? [],
    onOpenMonitor,
  });
  latestRef.current = {
    propServerId: serverId,
    serverId: resolvedServerId,
    roomSessions: room?.sessions ?? [],
    onOpenMonitor,
  };

  const latestMonitorEditRef = useRef({
    enabled: monitorEditMode && Boolean(effectiveSelectedKey),
    activeMonitorIndex: activeEditMonitorIndex,
    dragMode: monitorDragMode,
  });
  latestMonitorEditRef.current = {
    enabled: monitorEditMode && Boolean(effectiveSelectedKey),
    activeMonitorIndex: activeEditMonitorIndex,
    dragMode: monitorDragMode,
  };

  const latestSyncStateRef = useRef<OfficeSceneSyncState | null>(sceneSyncState);
  latestSyncStateRef.current = sceneSyncState;

  const hasRoom = Boolean(room);

  useEffect(() => {
    if (!hasRoom) return undefined;
    const host = canvasHostRef.current;
    if (!host) return undefined;

    let effectDisposed = false;
    let controller: OfficeSceneController | null = null;

    const callbacks: OfficeSceneCallbacks = {
      onSelectStation: (sessionKey) => {
        if (effectDisposed) return;
        setFocusedSessionKey(sessionKey);
      },
      onOpenMonitor: (sessionKey, originRect) => {
        if (effectDisposed) return;
        const session = latestRef.current.roomSessions.find(
          (item) => item.sessionKey === sessionKey
        );
        if (session) {
          setFocusedSessionKey(sessionKey);
          latestRef.current.onOpenMonitor(session, originRect);
        }
      },
      onHoverTarget: (info) => {
        if (effectDisposed) return;
        setHoverInfo(info);
      },
      onActiveEditMonitorChange: (monitorIndex) => {
        if (effectDisposed) return;
        setActiveEditMonitorIndex(monitorIndex);
      },
      onPreviewMonitorTransform: (originServerId, sessionKey, monitorIndex, transform) => {
        if (effectDisposed) return;
        if (!originServerId || latestRef.current.serverId !== originServerId) return;
        const hasSession = latestRef.current.roomSessions.some(
          (item) => item.sessionKey === sessionKey
        );
        if (!hasSession) return;
        setLiveMonitorPreview({
          serverId: originServerId,
          sessionKey,
          monitorIndex,
          transform,
        });
      },
      onCommitMonitorTransform: (originServerId, sessionKey, monitorIndex, transform) => {
        if (effectDisposed) return;
        setLiveMonitorPreview((prev) => (
          prev
          && prev.serverId === originServerId
          && prev.sessionKey === sessionKey
          && prev.monitorIndex === monitorIndex
            ? null
            : prev
        ));
        if (!originServerId || latestRef.current.serverId !== originServerId) {
          return;
        }
        const matchedSession = latestRef.current.roomSessions.find(
          (item) => item.sessionKey === sessionKey
        );
        if (!matchedSession) {
          return;
        }
        const targetSid = latestRef.current.propServerId || matchedSession.serverId || originServerId;
        if (targetSid !== originServerId) {
          return;
        }
        const current = readOfficeComputerPreferences(targetSid, sessionKey);
        const nextMonitors: [OfficeMonitorTransform, OfficeMonitorTransform] = [
          monitorIndex === 0 ? transform : current.monitors[0],
          monitorIndex === 1 ? transform : current.monitors[1],
        ];
        updateOfficeComputerPreferences(targetSid, sessionKey, { monitors: nextMonitors });
      },
      onCancelMonitorTransform: (originServerId, sessionKey, monitorIndex) => {
        if (effectDisposed) return;
        setLiveMonitorPreview((prev) => (
          prev
          && prev.serverId === originServerId
          && prev.sessionKey === sessionKey
          && prev.monitorIndex === monitorIndex
            ? null
            : prev
        ));
      },
      onContextLostChange: (lost) => {
        if (effectDisposed) return;
        setContextLost(lost);
      },
    };

    try {
      const initialState = latestSyncStateRef.current;
      controller = new OfficeSceneController(
        host,
        callbacks,
        initialState?.theme ?? 'dark',
        initialState?.reducedMotion ?? false
      );
      if (initialState) {
        controller.syncState(initialState);
      }
      controller.setMonitorEditState(
        latestMonitorEditRef.current.enabled,
        latestMonitorEditRef.current.activeMonitorIndex,
        latestMonitorEditRef.current.dragMode
      );
      controllerRef.current = controller;
      setWebglError('');
      setContextLost(false);

      return () => {
        effectDisposed = true;
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
        controller?.dispose();
        controller = null;
      };
    } catch (error: unknown) {
      effectDisposed = true;
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      if (controller) {
        try {
          controller.dispose();
        } catch {
          // Ignore secondary cleanup failure after initialization/initial sync error
        }
        controller = null;
      }
      const msg = error instanceof Error ? error.message : '无法初始化 WebGL 3D 渲染器';
      setWebglError(msg);
      return undefined;
    }
  }, [hasRoom]);

  useEffect(() => {
    if (sceneSyncState && controllerRef.current) {
      controllerRef.current.syncState(sceneSyncState);
    }
  }, [sceneSyncState]);

  const handleOpenRoomTerminal = useCallback(() => {
    if (!room || room.isFallbackRoom || !room.projectPath || room.projectPath === '__no_cwd__') {
      onOpenNewTerminal(undefined);
      return;
    }
    onOpenNewTerminal(room.projectPath);
  }, [onOpenNewTerminal, room]);

  const handleCameraPresetSelect = useCallback((preset: OfficeCameraPreset) => {
    if (preset === cameraPreset) {
      controllerRef.current?.resetCamera(preset);
      return;
    }
    onCameraPresetChange(preset);
  }, [cameraPreset, onCameraPresetChange]);

  const handleResetCamera = useCallback(() => {
    controllerRef.current?.resetCamera(cameraPreset);
  }, [cameraPreset]);

  const handleFocusSelectedStation = useCallback(() => {
    if (effectiveSelectedKey) {
      controllerRef.current?.focusStation(effectiveSelectedKey);
    }
  }, [effectiveSelectedKey]);

  const handleOpenSelectedMonitor = useCallback(() => {
    if (!activeSession) return;
    const originRect = controllerRef.current?.projectStationPartToRect(
      activeSession.sessionKey,
      'monitor'
    );
    onOpenMonitor(activeSession, originRect);
  }, [activeSession, onOpenMonitor]);

  const handleCopySelectedIdentity = useCallback(() => {
    if (!activeSession) return;
    onCopyIdentity(activeSession);
  }, [activeSession, onCopyIdentity]);

  const handleTerminateSelected = useCallback(() => {
    if (!activeSession || !onTerminateSession || !isTerminableWebShell(activeSession)) return;
    void onTerminateSession(activeSession);
  }, [activeSession, onTerminateSession]);

  const cameraMenuItems: MenuProps['items'] = [
    ...CAMERA_OPTIONS.map((opt) => ({
      key: opt.preset,
      icon: renderCameraIcon(opt.preset),
      label: cameraPreset === opt.preset ? `${opt.label} · 当前` : opt.label,
    })),
    { type: 'divider' as const },
    { key: 'reset', icon: <UndoOutlined />, label: '重置视角' },
    ...(activeSession
      ? [{ key: 'focus', icon: <AimOutlined />, label: `聚焦 ${activeSession.shortLabel}` }]
      : []),
  ];

  const handleCameraMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'reset') {
      handleResetCamera();
      return;
    }
    if (key === 'focus') {
      handleFocusSelectedStation();
      return;
    }
    handleCameraPresetSelect(key as OfficeCameraPreset);
  };

  const moreMenuItems: MenuProps['items'] = [
    {
      key: 'monitor',
      icon: isMonitorEditActive ? <CheckOutlined /> : <DragOutlined />,
      label: isMonitorEditActive ? '完成显示器调整' : '调整显示器',
    },
    { key: 'copy', icon: <CopyOutlined />, label: '复制标识' },
    ...(onToggleStationPower
      ? [
        { type: 'divider' as const },
        {
          key: 'power',
          icon: activeComputerPrefs?.power === 'off' ? <ThunderboltOutlined /> : <PoweroffOutlined />,
          label: activeComputerPrefs?.power === 'off' ? '虚拟开机' : '虚拟关机',
        },
      ]
      : []),
  ];

  const handleMoreMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'monitor') {
      setMonitorEditMode((prev) => !prev);
      return;
    }
    if (key === 'copy') {
      handleCopySelectedIdentity();
      return;
    }
    if (key === 'power' && activeSession) {
      onToggleStationPower?.(activeSession);
    }
  };

  const handleToggleDualMonitor = useCallback((nextDual: boolean) => {
    if (!activeSession) return;
    const targetSid = serverId || activeSession.serverId || 'local';
    updateOfficeComputerPreferences(targetSid, activeSession.sessionKey, {
      dualMonitor: nextDual,
    });
  }, [activeSession, serverId]);

  const handleStepMonitorAxis = useCallback(
    (axis: keyof OfficeMonitorTransform, delta: number) => {
      if (!activeSession) return;
      const targetSid = serverId || activeSession.serverId || 'local';
      const current = readOfficeComputerPreferences(targetSid, activeSession.sessionKey);
      const targetIdx: OfficeMonitorIndex =
        activeEditMonitorIndex === 1 && current.dualMonitor ? 1 : 0;
      const base = current.monitors[targetIdx];
      const nextTransform = clampOfficeMonitorTransform(
        { ...base, [axis]: base[axis] + delta },
        DEFAULT_OFFICE_MONITOR_TRANSFORMS[targetIdx]
      );
      const nextMonitors: [OfficeMonitorTransform, OfficeMonitorTransform] = [
        targetIdx === 0 ? nextTransform : current.monitors[0],
        targetIdx === 1 ? nextTransform : current.monitors[1],
      ];
      setLiveMonitorPreview(null);
      updateOfficeComputerPreferences(targetSid, activeSession.sessionKey, {
        monitors: nextMonitors,
      });
    },
    [activeEditMonitorIndex, activeSession, serverId]
  );

  const handleResetMonitors = useCallback(() => {
    if (!activeSession) return;
    const targetSid = serverId || activeSession.serverId || 'local';
    setLiveMonitorPreview(null);
    resetOfficeComputerMonitors(targetSid, activeSession.sessionKey);
  }, [activeSession, serverId]);

  const handleDoneMonitorEdit = useCallback(() => {
    setMonitorEditMode(false);
  }, []);

  const registerStationButtonRef = useCallback(
    (sessionKey: string, node: HTMLButtonElement | null) => {
      if (node) {
        stationButtonRefs.current.set(sessionKey, node);
      } else {
        stationButtonRefs.current.delete(sessionKey);
      }
    },
    []
  );

  const handleStationRailKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (visibleSessions.length === 0) return;
      const currentIdx = Math.max(
        0,
        visibleSessions.findIndex((item) => item.sessionKey === effectiveSelectedKey)
      );

      let nextIdx = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIdx = (currentIdx + 1) % visibleSessions.length;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIdx = (currentIdx - 1 + visibleSessions.length) % visibleSessions.length;
      } else if (event.key === 'Home') {
        nextIdx = 0;
      } else if (event.key === 'End') {
        nextIdx = visibleSessions.length - 1;
      }

      if (nextIdx >= 0) {
        event.preventDefault();
        const nextSession = visibleSessions[nextIdx];
        if (nextSession) {
          setFocusedSessionKey(nextSession.sessionKey);
          stationButtonRefs.current.get(nextSession.sessionKey)?.focus();
        }
      }
    },
    [effectiveSelectedKey, visibleSessions]
  );

  if (directoryLoading && !room) {
    return (
      <section className="office-room-root office-room-root--state" aria-label="项目办公室加载中">
        <HudStateView
          variant="loading"
          code="SYS // BUILDING ROOM"
          title="正在构建 3D 项目办公室"
          description="正在同步当前服务器上的项目目录会话与实时消息"
        />
      </section>
    );
  }

  if (!room) {
    return (
      <section className="office-room-root office-room-root--state" aria-label="暂无匹配项目办公室">
        <HudStateView
          variant="empty"
          code="ROOM // STANDBY"
          title="暂无匹配的项目办公室"
          description="请调整搜索或类型筛选条件，或打开一个新的项目终端开启工位"
          extra={(
            <div className="office-room-state-actions">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => onOpenNewTerminal()}>
                新建终端
              </Button>
            </div>
          )}
        />
      </section>
    );
  }

  const startSeat = effectiveShowAll || totalSessions === 0 ? 1 : zoneIndex * ZONE_PAGE_SIZE + 1;
  const endSeat = effectiveShowAll
    ? totalSessions
    : Math.min(totalSessions, (zoneIndex + 1) * ZONE_PAGE_SIZE);
  const needsPagination = totalSessions > ZONE_PAGE_SIZE;

  const activeMeta = activeSession ? getAvailabilityMeta(activeSession.availability) : null;
  const activeSnippet = activeSession ? resolveRealDockSnippet(activeSession) : null;
  const canTerminateActive = Boolean(
    activeSession && onTerminateSession && isTerminableWebShell(activeSession)
  );
  const isTerminatingActive = Boolean(
    activeSession && terminatingSessionKey && terminatingSessionKey === activeSession.sessionKey
  );
  const isBusyTerminatingOther = Boolean(
    activeSession && terminatingSessionKey && terminatingSessionKey !== activeSession.sessionKey
  );
  const editMonitorIdx: OfficeMonitorIndex =
    activeComputerPrefs?.dualMonitor && activeEditMonitorIndex === 1 ? 1 : 0;
  const displayedMonitorTransform: OfficeMonitorTransform | null = activeSession && activeComputerPrefs
    ? (
        liveMonitorPreview
        && liveMonitorPreview.serverId === resolvedServerId
        && liveMonitorPreview.sessionKey === activeSession.sessionKey
        && liveMonitorPreview.monitorIndex === editMonitorIdx
          ? liveMonitorPreview.transform
          : activeComputerPrefs.monitors[editMonitorIdx]
      )
    : null;
  return (
    <section
      className="office-room-root"
      data-camera={cameraPreset}
      data-zooming={zoomingSessionId ? 'true' : 'false'}
      aria-label={`项目办公室 ${room.projectName}`}
    >
      {/* Compact Top Architectural Room Bar */}
      <header className="office-room-topbar">
        <div className="office-room-meta">
          <span className="office-room-eyebrow">
            <span
              className={room.runningCount > 0 ? 'hud-led hud-led--ok hud-led--live' : 'hud-led'}
              aria-hidden="true"
            />
            PROJECT ROOM
          </span>
          <h2 className="office-room-title" title={room.projectName}>
            {room.projectName}
          </h2>
          <code className="office-room-path" title={room.projectPath}>
            {room.isFallbackRoom ? '未归属目录 / 通用工区' : room.projectPath}
          </code>

          <div className="office-room-counters">
            <span className="office-pill office-pill--ok">运行 {room.runningCount}</span>
            {room.exitedCount > 0 ? (
              <span className="office-pill">已退 {room.exitedCount}</span>
            ) : null}
            {directoryLoading ? (
              <span className="office-pill office-pill--info">同步中…</span>
            ) : null}
          </div>
        </div>

        <div className="office-room-controls">
          {needsPagination ? (
            <div className="office-zone-bar" role="group" aria-label="工位分区切换">
              {!effectiveShowAll ? (
                <>
                  <Button
                    size="small"
                    icon={<LeftOutlined />}
                    disabled={zoneIndex <= 0}
                    onClick={() => setZoneIndex((prev) => Math.max(0, prev - 1))}
                    aria-label="上一工区"
                  />
                  <span className="office-zone-status">
                    区 {zoneIndex + 1}/{totalZones} · #{startSeat}-{endSeat}/{totalSessions}
                  </span>
                  <Button
                    size="small"
                    icon={<RightOutlined />}
                    disabled={zoneIndex >= totalZones - 1}
                    onClick={() => setZoneIndex((prev) => Math.min(totalZones - 1, prev + 1))}
                    aria-label="下一工区"
                  />
                </>
              ) : (
                <span className="office-zone-status">全部 {totalSessions} 个工位</span>
              )}
              {canShowAll ? (
                <Button
                  size="small"
                  icon={effectiveShowAll ? <CompressOutlined /> : <AppstoreOutlined />}
                  onClick={() => setShowAllPods((prev) => !prev)}
                >
                  {effectiveShowAll ? '分区视图' : '展开全部'}
                </Button>
              ) : null}
            </div>
          ) : null}

          <Dropdown
            trigger={['click']}
            menu={{ items: cameraMenuItems, onClick: handleCameraMenuClick }}
          >
            <Button
              size="small"
              icon={renderCameraIcon(cameraPreset)}
              aria-label="切换 3D 视角"
              title="切换 / 重置 / 聚焦 3D 视角"
            >
              视角
            </Button>
          </Dropdown>
        </div>
      </header>

      {/* Real WebGL Three.js 3D Stage (single mounted canvas per OfficeRoom) */}
      <div className="office-webgl-viewport">
        <div
          ref={canvasHostRef}
          className="office-webgl-host"
          role="img"
          aria-label={`项目办公室 ${room.projectName} 三维场景，共 ${visibleSessions.length} 个当前展示工位`}
        />

        {/* Lightweight HUD interaction bar */}
        <div className="office-webgl-hud-top" aria-hidden="true">
          <span className="office-webgl-hint">
            {isMonitorEditActive
              ? '显示器调整模式：拖拽选中工位显示器移动位置（Shift 旋转 / Alt 调高）· 空白处仍可旋转视角'
              : '左键拖拽旋转 · 右键平移 · 滚轮缩放 · 点击工位选中 / 点击显示器打开桌面'}
          </span>
          {hoverInfo ? (
            <span className="office-webgl-hover-pill">
              <strong>{hoverInfo.label}</strong>
              <span>{hoverInfo.hint}</span>
            </span>
          ) : null}
        </div>

        {/* Empty / WebGL context-loss / init-error compact overlays */}
        {room.sessions.length === 0 ? (
          <div className="office-webgl-overlay">
            <HudStateView
              compact
              code="BAY // EMPTY"
              title="当前项目房间暂无工位"
              description="可在当前目录打开新终端，或打开房间消息查看历史跨会话通信"
              extra={(
                <div className="office-room-state-actions">
                  <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenRoomTerminal}>
                    新建终端
                  </Button>
                </div>
              )}
            />
          </div>
        ) : webglError ? (
          <div className="office-webgl-overlay">
            <HudStateView
              compact
              tone="warn"
              code="WEBGL // STANDBY"
              title="3D 渲染画布暂不可用"
              description={webglError}
            />
          </div>
        ) : contextLost ? (
          <div className="office-webgl-overlay">
            <HudStateView
              compact
              variant="loading"
              tone="warn"
              code="WEBGL // RESTORING"
              title="正在恢复 3D 渲染上下文"
              description="检测到显卡上下文重置，请稍候或使用下方工位控制条继续操作"
            />
          </div>
        ) : null}
      </div>

      {/* Accessible Non-Canvas Station Rail & Selected Station Action Dock */}
      {visibleSessions.length > 0 ? (
        <footer className="office-station-dock" aria-label="工位键盘切换与操作面板">
          <div
            className="office-station-rail"
            role="listbox"
            aria-label="当前分区工位列表"
            onKeyDown={handleStationRailKeyDown}
          >
            {visibleSessions.map((session) => {
              const isSelected = session.sessionKey === effectiveSelectedKey;
              const availMeta = getAvailabilityMeta(session.availability);
              return (
                <button
                  key={session.sessionKey}
                  ref={(node) => registerStationButtonRef(session.sessionKey, node)}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`office-station-chip${isSelected ? ' is-selected' : ''}`}
                  data-availability={session.availability}
                  onClick={() => setFocusedSessionKey(session.sessionKey)}
                  title={`${session.label} (${availMeta.label})`}
                >
                  <span className={availMeta.ledClass} aria-hidden="true" />
                  <span className="office-station-chip-code">{session.persona.badgeCode}</span>
                  <span className="office-station-chip-name">{session.shortLabel}</span>
                </button>
              );
            })}
          </div>

          {activeSession && activeMeta && activeSnippet ? (
            <div className="office-selected-bar">
              <div className="office-selected-info">
                <span className={activeMeta.ledClass} aria-hidden="true" />
                <span className="office-selected-badge">{activeSession.persona.badgeCode}</span>
                <span className="office-selected-name" title={activeSession.label}>
                  {activeSession.label}
                </span>
                <span className="office-selected-chip">
                  {activeSession.provider || (activeSession.kind === 'shell' ? 'shell' : 'cli')}
                </span>
                {activeSession.previewModel || activeSession.model ? (
                  <span
                    className="office-selected-chip office-selected-chip--muted"
                    title={activeSession.previewModel || activeSession.model}
                  >
                    {activeSession.previewModel || activeSession.model}
                  </span>
                ) : null}
                <span className={`office-selected-chip ${activeMeta.toneClass}`}>
                  {activeMeta.label}
                </span>
                {activeComputerPrefs?.power === 'off' ? (
                  <span className="office-selected-chip office-tone--poweroff">已关机</span>
                ) : null}
                {activeComputerPrefs?.dualMonitor ? (
                  <span className="office-selected-chip office-tone--directory">双屏</span>
                ) : null}
                <span className="office-selected-preview" title={activeSnippet.text}>
                  <em>{activeSnippet.tag}</em>
                  <span>{activeSnippet.text}</span>
                </span>
              </div>

              <div className="office-selected-actions">
                <Button
                  size="small"
                  type="primary"
                  icon={<DesktopOutlined />}
                  onClick={handleOpenSelectedMonitor}
                >
                  {activeComputerPrefs?.power === 'off' ? '开机桌面' : '打开桌面'}
                </Button>
                <Dropdown
                  trigger={['click']}
                  menu={{ items: moreMenuItems, onClick: handleMoreMenuClick }}
                >
                  <Button
                    size="small"
                    type={isMonitorEditActive ? 'primary' : 'default'}
                    icon={<MoreOutlined />}
                    aria-label="更多工位操作"
                  >
                    更多
                  </Button>
                </Dropdown>
                {canTerminateActive ? (
                  <Button
                    size="small"
                    danger
                    icon={<StopOutlined />}
                    loading={isTerminatingActive}
                    disabled={isBusyTerminatingOther}
                    onClick={handleTerminateSelected}
                  >
                    结束终端
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {isMonitorEditActive && activeComputerPrefs && displayedMonitorTransform ? (
            <OfficeMonitorControls
              dualMonitor={activeComputerPrefs.dualMonitor}
              activeMonitorIndex={editMonitorIdx}
              dragMode={monitorDragMode}
              transform={displayedMonitorTransform}
              onToggleDualMonitor={handleToggleDualMonitor}
              onSelectMonitorIndex={setActiveEditMonitorIndex}
              onChangeDragMode={setMonitorDragMode}
              onStepAxis={handleStepMonitorAxis}
              onResetMonitors={handleResetMonitors}
              onDone={handleDoneMonitorEdit}
            />
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

export default OfficeRoom;
