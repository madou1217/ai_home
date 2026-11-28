import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CopyOutlined,
  DeleteOutlined,
  DesktopOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FolderOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Button, Input, Modal, Select, Tooltip, message } from 'antd';
import HudStateView from '@/components/hud/HudStateView';
import InlineNote from '@/components/ui/InlineNote';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import OfficeRoom from './OfficeRoom';
import SessionDesktop from './SessionDesktop';
import {
  isSessionServerScopeAdmitted,
  readStationPowerState,
} from './office-computer-power';
import { updateOfficeComputerPreferences } from './office-computer-state';
import type {
  DesktopOriginRect,
  DesktopWindowLayout,
  OfficeCameraPreset,
  OfficeProjectRoom,
  OfficeSessionItem,
} from './session-office-types';
import { useSessionOfficeData } from './use-session-office-data';
import './SessionOffice.css';

export interface SessionOfficeProps {
  defaultRoomKey?: string;
  defaultSessionKey?: string;
}

const ZOOM_CUE_MS = 260;

const NATIVE_CLOSE_DISABLED_REASON =
  '原生 CLI 会话由外部独立进程托管；终端 close 接口仅断开借用连接而不会终止原进程，如需结束请前往原 CLI 终端退出。';

function isTerminableWebSession(session: OfficeSessionItem): boolean {
  return session.source === 'web' && !session.sessionKey.startsWith('native:');
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function resolveRoomDisplayTitle(room: OfficeProjectRoom): string {
  if (room.projectName) return room.projectName;
  return room.isFallbackRoom ? '未指定目录会话' : '未命名项目';
}

function resolveRoomPathHint(room: OfficeProjectRoom): string {
  if (!room.projectPath || room.projectPath === '__no_cwd__') {
    return '无工作目录（fallback）';
  }
  return room.projectPath;
}

function matchesRoomRef(room: OfficeProjectRoom, refKey: string): boolean {
  const normalized = refKey.trim();
  if (!normalized) return false;
  return room.projectKey === normalized || room.projectPath === normalized || room.projectName === normalized;
}

function matchesSessionRef(session: OfficeSessionItem, refKey: string): boolean {
  const normalized = refKey.trim();
  if (!normalized) return false;
  return (
    session.sessionKey === normalized
    || session.id === normalized
    || Boolean(session.nativeSessionId && session.nativeSessionId === normalized)
  );
}

export default function SessionOffice({
  defaultRoomKey,
  defaultSessionKey,
}: SessionOfficeProps) {
  const {
    serverId,
    rooms,
    filteredRooms,
    allSessions,
    unavailableSessions,
    hiddenCount,
    providerOptions,
    query,
    setQuery,
    providerFilter,
    setProviderFilter,
    directoryLoading,
    directoryError,
    terminatingSessionKey,
    isSessionTerminating,
    refreshAll,
    openNewProjectTerminal,
    terminateWebSession,
    hideSession,
    restoreHiddenSessions,
    copySessionIdentity,
    activateManagerSession,
  } = useSessionOfficeData();

  const [selectedRoomKey, setSelectedRoomKey] = useState<string | null>(defaultRoomKey || null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [cameraPreset, setCameraPreset] = useState<OfficeCameraPreset>('isometric');

  const [desktopOpen, setDesktopOpen] = useState(false);
  const [desktopInitialMode, setDesktopInitialMode] = useState<DesktopWindowLayout>('terminal-focus');
  const [desktopOriginRect, setDesktopOriginRect] = useState<DesktopOriginRect | null>(null);
  const [zoomingSessionId, setZoomingSessionId] = useState<string | null>(null);

  const [unavailableExpanded, setUnavailableExpanded] = useState(true);

  const [confirmTarget, setConfirmTarget] = useState<OfficeSessionItem | null>(null);
  const [confirmError, setConfirmError] = useState<string>('');

  const mountedRef = useRef(true);
  const liveServerIdRef = useRef(serverId);
  liveServerIdRef.current = serverId;
  const prevServerIdRef = useRef(serverId);
  const renderServerIdRef = useRef(serverId);
  const serverGenerationRef = useRef(0);
  if (renderServerIdRef.current !== serverId) {
    renderServerIdRef.current = serverId;
    serverGenerationRef.current += 1;
  }

  const latestAllSessionsRef = useRef(allSessions);
  latestAllSessionsRef.current = allSessions;
  const latestSelectedRoomKeyRef = useRef(selectedRoomKey);
  latestSelectedRoomKeyRef.current = selectedRoomKey;
  const latestSelectedSessionIdRef = useRef(selectedSessionId);
  latestSelectedSessionIdRef.current = selectedSessionId;
  const latestConfirmTargetRef = useRef(confirmTarget);
  latestConfirmTargetRef.current = confirmTarget;

  const confirmIdentity = confirmTarget
    ? `${confirmTarget.serverId}\0${confirmTarget.sessionKey}\0${confirmTarget.id}`
    : '';
  const prevConfirmIdentityRef = useRef(confirmIdentity);
  const confirmGenerationRef = useRef(0);
  if (prevConfirmIdentityRef.current !== confirmIdentity) {
    prevConfirmIdentityRef.current = confirmIdentity;
    confirmGenerationRef.current += 1;
  }
  const inFlightConfirmGenRef = useRef<number | null>(null);

  const zoomTimerRef = useRef<number | null>(null);
  const deepLinkSignature = `${defaultRoomKey ?? ''}|${defaultSessionKey ?? ''}`;
  const appliedDeepLinkRef = useRef<string>('');

  const clearZoomTimer = useCallback(() => {
    if (zoomTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      serverGenerationRef.current += 1;
      clearZoomTimer();
    };
  }, [clearZoomTimer]);

  // 服务器切换时立即清理原服务器的缩放计时器、桌面、选中会话及关闭确认弹窗，防止跨节点状态残留或误发关闭请求。
  useEffect(() => {
    if (prevServerIdRef.current !== serverId) {
      prevServerIdRef.current = serverId;
      clearZoomTimer();
      setZoomingSessionId(null);
      setDesktopOpen(false);
      setDesktopOriginRect(null);
      setSelectedSessionId(null);
      setConfirmTarget(null);
      setConfirmError('');
    }
  }, [clearZoomTimer, serverId]);

  const triggerZoomCue = useCallback((sessionId: string) => {
    clearZoomTimer();
    if (prefersReducedMotion() || typeof window === 'undefined') {
      setZoomingSessionId(null);
      return;
    }
    setZoomingSessionId(sessionId);
    zoomTimerRef.current = window.setTimeout(() => {
      zoomTimerRef.current = null;
      setZoomingSessionId(null);
    }, ZOOM_CUE_MS);
  }, [clearZoomTimer]);

  // 深链定位房间或会话（仅在目标就绪后触发一次，避免关闭会话或桌面后被重复拉起）。
  useEffect(() => {
    if (appliedDeepLinkRef.current === deepLinkSignature) return;
    if (!defaultRoomKey && !defaultSessionKey) {
      appliedDeepLinkRef.current = deepLinkSignature;
      return;
    }
    if (rooms.length === 0 && allSessions.length === 0) return;

    const matchedSession = defaultSessionKey
      ? allSessions.find((session) => matchesSessionRef(session, defaultSessionKey)) ?? null
      : null;
    const matchedRoom = matchedSession
      ? rooms.find((room) => room.projectKey === matchedSession.projectKey) ?? null
      : (defaultRoomKey ? rooms.find((room) => matchesRoomRef(room, defaultRoomKey)) ?? null : null);

    if (matchedRoom) {
      setSelectedRoomKey(matchedRoom.projectKey);
    }
    if (matchedSession) {
      setSelectedSessionId(matchedSession.id);
      activateManagerSession(matchedSession.id);
      setDesktopOriginRect(null);
      setDesktopInitialMode('terminal-focus');
      setDesktopOpen(true);
      appliedDeepLinkRef.current = deepLinkSignature;
      return;
    }
    if (matchedRoom && !defaultSessionKey) {
      appliedDeepLinkRef.current = deepLinkSignature;
    }
  }, [
    activateManagerSession,
    allSessions,
    deepLinkSignature,
    defaultRoomKey,
    defaultSessionKey,
    rooms,
  ]);

  // 自动清理已不存在的选中会话并退出关联桌面，避免会话终止或退出后残留过期激活引用或桌面打开状态。
  useEffect(() => {
    if (!selectedSessionId) return;
    const stillExists = allSessions.some((session) => session.id === selectedSessionId);
    if (!stillExists) {
      clearZoomTimer();
      setZoomingSessionId(null);
      setDesktopOpen(false);
      setDesktopOriginRect(null);
      setSelectedSessionId(null);
    }
  }, [allSessions, clearZoomTimer, selectedSessionId]);

  const activeRoom = useMemo<OfficeProjectRoom | null>(() => {
    if (filteredRooms.length === 0) return null;
    if (selectedRoomKey) {
      const matched = filteredRooms.find((room) => room.projectKey === selectedRoomKey);
      if (matched) return matched;
    }
    return filteredRooms[0];
  }, [filteredRooms, selectedRoomKey]);

  const desktopSession = useMemo<OfficeSessionItem | null>(() => {
    if (!selectedSessionId) return null;
    return allSessions.find((session) => session.id === selectedSessionId) ?? null;
  }, [allSessions, selectedSessionId]);

  const desktopRoom = useMemo<OfficeProjectRoom | null>(() => {
    if (desktopSession) {
      const sessionRoom = rooms.find((room) => room.projectKey === desktopSession.projectKey);
      if (sessionRoom) return sessionRoom;
    }
    return activeRoom;
  }, [activeRoom, desktopSession, rooms]);

  const roomSelectedSessionId = useMemo<string | null>(() => {
    if (!activeRoom) return null;
    if (selectedSessionId && activeRoom.sessions.some((session) => session.id === selectedSessionId)) {
      return selectedSessionId;
    }
    return activeRoom.sessions[0]?.id ?? null;
  }, [activeRoom, selectedSessionId]);

  const runningSessionsCount = useMemo(
    () => allSessions.filter((session) => session.availability === 'interactive').length,
    [allSessions],
  );

  const activeRoomCwd = useMemo<string | undefined>(() => {
    if (!activeRoom || activeRoom.isFallbackRoom) return undefined;
    if (!activeRoom.projectPath || activeRoom.projectPath === '__no_cwd__') return undefined;
    return activeRoom.projectPath;
  }, [activeRoom]);

  const handleToggleStationPower = useCallback((station: OfficeSessionItem) => {
    if (isSessionTerminating(station.sessionKey) || !isSessionServerScopeAdmitted(serverId, station)) {
      return;
    }
    const sid = serverId.trim();
    const skey = station.sessionKey.trim();
    const current = readStationPowerState(sid, skey);
    updateOfficeComputerPreferences(sid, skey, {
      power: current === 'on' ? 'off' : 'on',
    });
  }, [isSessionTerminating, serverId]);

  const providerSelectOptions = useMemo(
    () => [
      { value: 'all', label: '全部类型' },
      ...providerOptions.map((provider) => ({ value: provider, label: provider })),
    ],
    [providerOptions],
  );

  const handleOpenMonitor = useCallback((session: OfficeSessionItem, originRect?: DesktopOriginRect) => {
    setSelectedRoomKey(session.projectKey);
    setSelectedSessionId(session.id);
    activateManagerSession(session.id);
    setDesktopOriginRect(originRect ?? null);
    setDesktopInitialMode('terminal-focus');
    triggerZoomCue(session.id);
    setDesktopOpen(true);
  }, [activateManagerSession, triggerZoomCue]);

  const handleCloseToRoom = useCallback(() => {
    clearZoomTimer();
    setZoomingSessionId(null);
    setDesktopOpen(false);
  }, [clearZoomTimer]);

  const handleSelectRoomSession = useCallback((session: OfficeSessionItem) => {
    setSelectedRoomKey(session.projectKey);
    setSelectedSessionId(session.id);
    activateManagerSession(session.id);
  }, [activateManagerSession]);

  const handleHideSession = useCallback((sessionId: string) => {
    hideSession(sessionId);
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null);
      setDesktopOpen(false);
    }
  }, [hideSession, selectedSessionId]);

  const handleCopyIdentity = useCallback((session: OfficeSessionItem) => {
    void copySessionIdentity(session);
  }, [copySessionIdentity]);

  const handleOpenNewTerminal = useCallback((cwd?: string) => {
    void openNewProjectTerminal(cwd ?? activeRoomCwd);
  }, [activeRoomCwd, openNewProjectTerminal]);

  const handleRequestTerminateSession = useCallback((session: OfficeSessionItem) => {
    if (!isTerminableWebSession(session)) {
      message.info(NATIVE_CLOSE_DISABLED_REASON);
      return;
    }
    if (isSessionTerminating(session.sessionKey)) {
      return;
    }
    setConfirmError('');
    setConfirmTarget(session);
  }, [isSessionTerminating]);

  const confirmBusy = Boolean(
    confirmTarget && isSessionTerminating(confirmTarget.sessionKey),
  );

  const handleCancelTerminateModal = useCallback(() => {
    if (confirmBusy) return;
    setConfirmTarget(null);
    setConfirmError('');
  }, [confirmBusy]);

  const handleConfirmTerminate = useCallback(async () => {
    if (!confirmTarget || confirmBusy) return;
    const target = confirmTarget;
    const requestGeneration = serverGenerationRef.current;
    const requestConfirmGeneration = confirmGenerationRef.current;
    if (inFlightConfirmGenRef.current === requestConfirmGeneration) return;

    if (target.serverId !== serverId || target.serverId !== liveServerIdRef.current) {
      setConfirmTarget(null);
      setConfirmError('');
      message.warning('当前服务器已切换，原服务器关闭确认已取消');
      return;
    }
    setConfirmError('');

    inFlightConfirmGenRef.current = requestConfirmGeneration;
    try {
      const result = await terminateWebSession(target);
      if (
        !mountedRef.current
        || serverGenerationRef.current !== requestGeneration
        || target.serverId !== liveServerIdRef.current
      ) {
        return;
      }

      const isSameActiveConfirm =
        confirmGenerationRef.current === requestConfirmGeneration
        && Boolean(latestConfirmTargetRef.current)
        && latestConfirmTargetRef.current?.serverId === target.serverId
        && latestConfirmTargetRef.current?.sessionKey === target.sessionKey
        && latestConfirmTargetRef.current?.id === target.id;

      if (!result.ok) {
        const errMsg = result.error || '关闭会话失败';
        if (isSameActiveConfirm) {
          setConfirmError(errMsg);
          message.error(errMsg);
        }
        return;
      }

      const currentSelectedId = latestSelectedSessionIdRef.current;
      const currentSelectedSession = currentSelectedId
        ? latestAllSessionsRef.current.find((item) => item.id === currentSelectedId) ?? null
        : null;
      const isViewingClosedTarget =
        currentSelectedId === target.id
        && (!currentSelectedSession || (
          currentSelectedSession.sessionKey === target.sessionKey
          && currentSelectedSession.serverId === target.serverId
        ));

      if (isViewingClosedTarget) {
        clearZoomTimer();
        setZoomingSessionId(null);
        setDesktopOriginRect(null);
        setSelectedSessionId(null);
        setDesktopOpen(false);
      }

      const remainingInRoom = latestAllSessionsRef.current.filter(
        (item) => item.projectKey === target.projectKey && item.sessionKey !== target.sessionKey,
      );
      if (remainingInRoom.length === 0 && latestSelectedRoomKeyRef.current === target.projectKey) {
        setSelectedRoomKey(null);
      }

      if (isSameActiveConfirm) {
        setConfirmTarget(null);
        setConfirmError('');
      }

      if (result.alreadyGone) {
        message.info(`会话「${target.label}」在服务端已结束，已清理残留视图并同步目录`);
      } else {
        message.success(`已关闭会话「${target.label}」`);
      }
    } finally {
      if (inFlightConfirmGenRef.current === requestConfirmGeneration) {
        inFlightConfirmGenRef.current = null;
      }
    }
  }, [
    clearZoomTimer,
    confirmBusy,
    confirmTarget,
    serverId,
    terminateWebSession,
  ]);

  const handleSelectRoom = useCallback((room: OfficeProjectRoom) => {
    setSelectedRoomKey(room.projectKey);
    if (!room.sessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(room.sessions[0]?.id ?? null);
    }
  }, [selectedSessionId]);

  const hasFilter = Boolean(query.trim()) || providerFilter !== 'all';

  return (
    <main className="session-office aih-panel-enter">
      <header className="session-office-command-bar hud-panel hud-panel--sm">
        <div className="session-office-brand">
          <div className="session-office-title-block">
            <span className="session-office-eyebrow">SYS // PROJECT OFFICE</span>
            <h1>
              <DesktopOutlined className="session-office-title-icon" />
              项目办公室
            </h1>
          </div>

          <div className="session-office-metrics" aria-label="办公室实时统计">
            <SettingStatusTag
              status={directoryError ? 'error' : directoryLoading ? 'saving' : runningSessionsCount > 0 ? 'applied' : 'unset'}
              label={directoryError ? '同步异常' : directoryLoading ? '同步中' : runningSessionsCount > 0 ? `运行中 ${runningSessionsCount}/${allSessions.length}` : '暂无活跃会话'}
              compact
              live="off"
            />
            <span className="session-office-metric">
              <span className="hud-label">房间</span>
              <strong className="hud-display">{rooms.length}</strong>
            </span>
            </div>
        </div>

        <div className="session-office-controls">
          <Input.Search
            className="session-office-search"
            aria-label="搜索项目房间、会话或路径"
            placeholder="搜索房间、会话、路径"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            allowClear
          />
          <Select
            className="session-office-provider-select"
            aria-label="筛选会话类型"
            value={providerFilter}
            onChange={setProviderFilter}
            options={providerSelectOptions}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={directoryLoading}
            onClick={() => void refreshAll()}
          >
            刷新
          </Button>
          {hiddenCount > 0 ? (
            <Button icon={<EyeOutlined />} onClick={restoreHiddenSessions}>
              显示已隐藏 ({hiddenCount})
            </Button>
          ) : null}
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => handleOpenNewTerminal(activeRoomCwd)}
          >
            项目终端
          </Button>
        </div>

        {directoryError ? (
          <div className="session-office-inline-errors">
            <InlineNote tone="error">会话目录：{directoryError}</InlineNote>
          </div>
        ) : null}
      </header>

      <div className="session-office-body">
        <aside className="session-office-sidebar hud-panel" aria-label="项目房间与工位选择器">
          <div className="session-office-sidebar-head">
            <span className="session-office-sidebar-title">
              <FolderOutlined />
              <span>项目房间</span>
            </span>
            <span className="session-office-sidebar-count hud-display">
              {filteredRooms.length}{filteredRooms.length !== rooms.length ? `/${rooms.length}` : ''}
            </span>
          </div>

          <div className="session-office-room-list" role="listbox" aria-label="项目房间列表">
            {filteredRooms.length > 0 ? (
              filteredRooms.map((room) => {
                const isActive = activeRoom?.projectKey === room.projectKey;
                const roomTitle = resolveRoomDisplayTitle(room);
                const pathHint = resolveRoomPathHint(room);
                const statusLedClass = room.runningCount > 0 ? 'hud-led hud-led--ok' : 'hud-led';
                return (
                  <Tooltip key={room.projectKey} title={pathHint} placement="right" mouseEnterDelay={0.35}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={`session-office-room-card${isActive ? ' is-active' : ''}`}
                      onClick={() => handleSelectRoom(room)}
                    >
                      <div className="session-office-room-top">
                        <span className="session-office-room-name-wrap">
                          <span className={statusLedClass} aria-hidden="true" />
                          <span className="session-office-room-name">{roomTitle}</span>
                        </span>
                        <span className="session-office-room-ratio hud-display">
                          {room.runningCount}/{room.sessions.length}
                        </span>
                      </div>

                      <div className="session-office-room-path">{pathHint}</div>
                    </button>
                  </Tooltip>
                );
              })
            ) : (
              <div className="session-office-sidebar-empty">
                {rooms.length > 0 && hasFilter ? (
                  <>
                    <span>没有匹配的项目房间</span>
                    <Button
                      size="small"
                      onClick={() => {
                        setQuery('');
                        setProviderFilter('all');
                      }}
                    >
                      清除筛选
                    </Button>
                  </>
                ) : (
                  <span>暂无运行中的项目房间</span>
                )}
              </div>
            )}
          </div>

          {unavailableSessions.length > 0 ? (
            <div className="session-office-sidebar-footer">
              <section className="session-office-unavailable" aria-label="暂不可接入的原会话">
                <button
                  type="button"
                  className="session-office-unavailable-toggle"
                  aria-expanded={unavailableExpanded}
                  onClick={() => setUnavailableExpanded((prev) => !prev)}
                >
                  <span className="session-office-unavailable-label">
                    <span className="hud-led hud-led--warn" aria-hidden="true" />
                    <span>暂不可接入的原会话 ({unavailableSessions.length})</span>
                  </span>
                  {unavailableExpanded ? <DownOutlined /> : <RightOutlined />}
                </button>

                {unavailableExpanded ? (
                  <div className="session-office-unavailable-body">
                    <div className="session-office-unavailable-note">
                      标识已保留 · 不会自动重启或替换
                    </div>
                    <ul className="session-office-unavailable-list">
                      {unavailableSessions.map((session) => (
                        <li key={session.id} className="session-office-unavailable-item">
                          <div className="session-office-unavailable-info">
                            <strong title={session.label}>{session.label}</strong>
                            <span className="session-office-unavailable-cwd" title={session.cwd || '无工作目录'}>
                              {session.cwd || '无工作目录'}
                            </span>
                            <code title={session.sessionKey}>
                              {session.nativeSessionId || session.sessionKey}
                            </code>
                          </div>
                          <Button
                            size="small"
                            type="text"
                            icon={<CopyOutlined />}
                            onClick={() => handleCopyIdentity(session)}
                          >
                            复制原标识
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            </div>
          ) : null}
        </aside>

        <section className="session-office-stage" aria-label="项目三维办公空间">
          {rooms.length === 0 ? (
            <div className="session-office-stage-empty">
              {directoryLoading ? (
                <HudStateView
                  variant="loading"
                  code="SYS // DISCOVERING"
                  title="正在发现项目房间与运行会话"
                  description="正在同步当前 Server 上的活跃终端与原生 CLI 会话"
                />
              ) : (
                <HudStateView
                  code="NO_ROOMS"
                  title="当前服务器没有活跃项目房间"
                  description="打开项目终端，或在账号管理 / AI 会话页启动 CLI 后会自动按项目房间汇聚在此"
                  extra={(
                    <Button
                      type="primary"
                      icon={<PlusOutlined />}
                      onClick={() => handleOpenNewTerminal()}
                    >
                      打开项目终端
                    </Button>
                  )}
                />
              )}
            </div>
          ) : filteredRooms.length === 0 || !activeRoom ? (
            <div className="session-office-stage-empty">
              <HudStateView
                code="NO_MATCH"
                title="没有匹配的项目房间或会话"
                description="请调整搜索关键词或类型筛选，或重置过滤条件查看全部房间"
                extra={(
                  <Button
                    onClick={() => {
                      setQuery('');
                      setProviderFilter('all');
                    }}
                  >
                    重置筛选
                  </Button>
                )}
              />
            </div>
          ) : (
            <OfficeRoom
              serverId={serverId}
              room={activeRoom}
              selectedSessionId={roomSelectedSessionId}
              zoomingSessionId={zoomingSessionId}
              cameraPreset={cameraPreset}
              onCameraPresetChange={setCameraPreset}
              onOpenMonitor={handleOpenMonitor}
              onCopyIdentity={handleCopyIdentity}
              onOpenNewTerminal={handleOpenNewTerminal}
              directoryLoading={directoryLoading}
              onTerminateSession={handleRequestTerminateSession}
              onToggleStationPower={handleToggleStationPower}
              terminatingSessionKey={terminatingSessionKey}
            />
          )}
        </section>
      </div>

      {/* 员工工位桌面浮层：位于 3D 舞台容器之外 */}
      <SessionDesktop
        open={desktopOpen && Boolean(desktopSession)}
        serverId={serverId}
        session={desktopSession}
        room={desktopRoom}
        initialMode={desktopInitialMode}
        originRect={desktopOriginRect}
        terminatingSessionKey={terminatingSessionKey}
        terminateConfirmOpen={Boolean(confirmTarget)}
        onTerminateSession={handleRequestTerminateSession}
        onCloseToRoom={handleCloseToRoom}
        onSelectRoomSession={handleSelectRoomSession}
        onCopyIdentity={handleCopyIdentity}
        onHideSession={handleHideSession}
        onRefreshAll={() => void refreshAll()}
        onOpenNewTerminal={handleOpenNewTerminal}
      />

      {/* Web Shell 真实关闭会话不可逆确认层 */}
      <Modal
        open={Boolean(confirmTarget)}
        zIndex={1300}
        title="确认关闭 Web 终端会话？"
        closable={!confirmBusy}
        maskClosable={!confirmBusy}
        keyboard={!confirmBusy}
        onCancel={handleCancelTerminateModal}
        footer={[
          <Button
            key="cancel"
            disabled={confirmBusy}
            onClick={handleCancelTerminateModal}
          >
            取消
          </Button>,
          <Button
            key="confirm"
            type="primary"
            danger
            icon={<DeleteOutlined />}
            loading={confirmBusy}
            disabled={confirmBusy}
            onClick={() => void handleConfirmTerminate()}
          >
            {confirmBusy ? '正在关闭会话…' : '确认关闭会话'}
          </Button>,
        ]}
      >
        {confirmTarget ? (
          <div className="session-office-terminate-confirm">
            <p className="session-office-terminate-desc">
              此操作将不可逆地停止服务端该 Shell 会话及其内正在运行的进程。关闭后本地工位与已最小化终端视图会同步移除，且不会自动重新打开或连接。若仅需关闭虚拟显示器并保留后台进程运行，请取消并使用“虚拟关机”。
            </p>

            <dl className="session-office-terminate-meta">
              <div>
                <dt>会话名称</dt>
                <dd><strong>{confirmTarget.label}</strong></dd>
              </div>
              <div>
                <dt>工作目录</dt>
                <dd><code>{confirmTarget.cwd || '未指定目录'}</code></dd>
              </div>
              <div>
                <dt>会话标识</dt>
                <dd>
                  <code>{confirmTarget.sessionKey}</code>
                  {confirmTarget.termId ? (
                    <span className="session-office-terminate-termid">
                      termId: {confirmTarget.termId}
                    </span>
                  ) : null}
                </dd>
              </div>
            </dl>

            {confirmError ? (
              <div className="session-office-terminate-error" role="alert">
                <span className="hud-led hud-led--err" aria-hidden="true" />
                <ExclamationCircleOutlined aria-hidden="true" />
                <span>{confirmError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </main>
  );
}
