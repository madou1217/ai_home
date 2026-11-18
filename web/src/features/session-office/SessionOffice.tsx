import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CloseOutlined,
  CopyOutlined,
  DesktopOutlined,
  DownOutlined,
  EyeOutlined,
  FolderOutlined,
  InboxOutlined,
  MailOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Button, Input, Select, Tooltip, message } from 'antd';
import HudStateView from '@/components/hud/HudStateView';
import OfficeMailbox from './OfficeMailbox';
import OfficeRoom from './OfficeRoom';
import SessionDesktop from './SessionDesktop';
import type {
  DesktopOriginRect,
  DesktopWindowLayout,
  MailboxScope,
  OfficeCameraPreset,
  OfficeProjectRoom,
  OfficeSessionItem,
} from './session-office-types';
import { useSessionOfficeData } from './use-session-office-data';
import './SessionOffice.css';

export interface SessionOfficeProps {
  defaultOpenMailbox?: boolean;
  defaultMailboxScope?: MailboxScope;
  defaultRoomKey?: string;
  defaultSessionKey?: string;
}

const ZOOM_CUE_MS = 260;

const MAILBOX_SCOPE_TITLES: Record<MailboxScope, string> = {
  session: '当前会话邮箱',
  room: '房间协作邮箱',
  unassigned: '未归属 / 历史邮箱',
  all: '全局协作邮箱',
};

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
  defaultOpenMailbox = false,
  defaultMailboxScope,
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
    peerMessages,
    unassignedMessages,
    fullyUnassignedCount,
    peerCounts,
    peerLoading,
    peerError,
    refreshAll,
    openNewProjectTerminal,
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
  const [desktopMailboxScope, setDesktopMailboxScope] = useState<MailboxScope>('session');
  const [desktopOriginRect, setDesktopOriginRect] = useState<DesktopOriginRect | null>(null);
  const [zoomingSessionId, setZoomingSessionId] = useState<string | null>(null);

  const [mailboxOverlayOpen, setMailboxOverlayOpen] = useState(Boolean(defaultOpenMailbox));
  const [mailboxScope, setMailboxScope] = useState<MailboxScope>(defaultMailboxScope ?? 'room');
  const [unavailableExpanded, setUnavailableExpanded] = useState(true);

  const zoomTimerRef = useRef<number | null>(null);
  const prevDefaultsRef = useRef({ defaultOpenMailbox, defaultMailboxScope });
  const deepLinkSignature = `${defaultOpenMailbox ? '1' : '0'}|${defaultMailboxScope ?? ''}|${defaultRoomKey ?? ''}|${defaultSessionKey ?? ''}`;
  const appliedDeepLinkRef = useRef<string>('');

  const clearZoomTimer = useCallback(() => {
    if (zoomTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearZoomTimer, [clearZoomTimer]);

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

  // 同步路由级入参（例如从 /terminals 跳转到 /peer-inbox 或带查询参数切换）。
  useEffect(() => {
    const prev = prevDefaultsRef.current;
    if (prev.defaultOpenMailbox !== defaultOpenMailbox) {
      if (defaultOpenMailbox) {
        setDesktopOpen(false);
        setMailboxOverlayOpen(true);
      } else {
        setMailboxOverlayOpen(false);
      }
    }
    if (prev.defaultMailboxScope !== defaultMailboxScope && defaultMailboxScope) {
      setMailboxScope(defaultMailboxScope);
    }
    prevDefaultsRef.current = { defaultOpenMailbox, defaultMailboxScope };
  }, [defaultMailboxScope, defaultOpenMailbox]);

  // 深链定位房间或会话（仅在目标就绪后触发一次，避免关闭桌面后被重复拉起）。
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
      if (!defaultOpenMailbox) {
        setDesktopOriginRect(null);
        setDesktopInitialMode('terminal-focus');
        setDesktopMailboxScope('session');
        setDesktopOpen(true);
      }
      appliedDeepLinkRef.current = deepLinkSignature;
      return;
    }
    if (matchedRoom) {
      appliedDeepLinkRef.current = deepLinkSignature;
    }
  }, [
    activateManagerSession,
    allSessions,
    deepLinkSignature,
    defaultOpenMailbox,
    defaultRoomKey,
    defaultSessionKey,
    rooms,
  ]);

  const activeRoom = useMemo<OfficeProjectRoom | null>(() => {
    if (filteredRooms.length === 0) return null;
    if (selectedRoomKey) {
      const matched = filteredRooms.find((room) => room.projectKey === selectedRoomKey);
      if (matched) return matched;
    }
    return filteredRooms[0];
  }, [filteredRooms, selectedRoomKey]);

  // 独立邮箱使用未过滤的完整房间快照，确保房间会话数与 roomMessages 计数一致。
  const unfilteredActiveRoom = useMemo<OfficeProjectRoom | null>(() => {
    if (!activeRoom) return null;
    return rooms.find((room) => room.projectKey === activeRoom.projectKey) ?? activeRoom;
  }, [activeRoom, rooms]);

  const focusedSession = useMemo<OfficeSessionItem | null>(() => {
    if (selectedSessionId) {
      const exact = allSessions.find((session) => session.id === selectedSessionId);
      if (exact) return exact;
    }
    return activeRoom?.sessions[0] ?? null;
  }, [activeRoom, allSessions, selectedSessionId]);

  const desktopRoom = useMemo<OfficeProjectRoom | null>(() => {
    if (focusedSession) {
      const sessionRoom = rooms.find((room) => room.projectKey === focusedSession.projectKey);
      if (sessionRoom) return sessionRoom;
    }
    return activeRoom;
  }, [activeRoom, focusedSession, rooms]);

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

  const providerSelectOptions = useMemo(
    () => [
      { value: 'all', label: '全部类型' },
      ...providerOptions.map((provider) => ({ value: provider, label: provider })),
    ],
    [providerOptions],
  );

  // 独立邮箱浮层支持 Escape 关闭（桌面打开时由 SessionDesktop 自己处理）。
  useEffect(() => {
    if (!mailboxOverlayOpen || desktopOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('.xterm')) return;
      setMailboxOverlayOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [desktopOpen, mailboxOverlayOpen]);

  const openStandaloneMailbox = useCallback((scope: MailboxScope) => {
    setDesktopOpen(false);
    setZoomingSessionId(null);
    setMailboxScope(scope);
    setMailboxOverlayOpen(true);
  }, []);

  const handleOpenMonitor = useCallback((session: OfficeSessionItem, originRect?: DesktopOriginRect) => {
    setMailboxOverlayOpen(false);
    setSelectedRoomKey(session.projectKey);
    setSelectedSessionId(session.id);
    activateManagerSession(session.id);
    setDesktopOriginRect(originRect ?? null);
    setDesktopInitialMode('terminal-focus');
    setDesktopMailboxScope('session');
    triggerZoomCue(session.id);
    setDesktopOpen(true);
  }, [activateManagerSession, triggerZoomCue]);

  const handleOpenSessionMail = useCallback((session: OfficeSessionItem, originRect?: DesktopOriginRect) => {
    setMailboxOverlayOpen(false);
    setSelectedRoomKey(session.projectKey);
    setSelectedSessionId(session.id);
    activateManagerSession(session.id);
    setDesktopOriginRect(originRect ?? null);
    setDesktopInitialMode('mail-focus');
    setDesktopMailboxScope('session');
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

  const handleJumpToSession = useCallback((sessionKey: string, projectKey?: string | null) => {
    const targetSession = allSessions.find((session) => matchesSessionRef(session, sessionKey)) ?? null;
    const targetRoom = (targetSession ? rooms.find((room) => room.projectKey === targetSession.projectKey) : null)
      ?? (projectKey ? rooms.find((room) => room.projectKey === projectKey) : null)
      ?? null;

    if (targetRoom && !filteredRooms.some((room) => room.projectKey === targetRoom.projectKey)) {
      setQuery('');
      setProviderFilter('all');
    }
    if (targetRoom) {
      setSelectedRoomKey(targetRoom.projectKey);
    }

    if (targetSession) {
      setSelectedSessionId(targetSession.id);
      activateManagerSession(targetSession.id);
      setMailboxOverlayOpen(false);
      setDesktopOriginRect(null);
      setDesktopInitialMode('terminal-focus');
      setDesktopMailboxScope('session');
      setDesktopOpen(true);
      return;
    }

    if (targetRoom) {
      setMailboxOverlayOpen(false);
      setDesktopOpen(false);
      message.info(`已切换到项目房间「${resolveRoomDisplayTitle(targetRoom)}」，目标会话当前未在线`);
      return;
    }

    message.info('目标会话当前未在线，可在邮箱中继续查看消息上下文');
  }, [
    activateManagerSession,
    allSessions,
    filteredRooms,
    rooms,
    setProviderFilter,
    setQuery,
  ]);

  const handleSelectRoom = useCallback((room: OfficeProjectRoom) => {
    setSelectedRoomKey(room.projectKey);
    if (!room.sessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(room.sessions[0]?.id ?? null);
    }
  }, [selectedSessionId]);

  const hasFilter = Boolean(query.trim()) || providerFilter !== 'all';
  const unassignedBadgeCount = unassignedMessages.length;

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
            <span className="session-office-metric">
              <span className="hud-label">ROOMS</span>
              <strong className="hud-display">{rooms.length}</strong>
            </span>
            <span className="session-office-metric">
              <span className="hud-label">ONLINE</span>
              <strong className="hud-display">{runningSessionsCount}/{allSessions.length}</strong>
            </span>
            <span className="session-office-metric">
              <span className="hud-label">MAIL</span>
              <strong className="hud-display">{peerCounts.total}</strong>
            </span>
            {peerCounts.pending > 0 ? (
              <span className="session-office-metric session-office-metric--warn">
                <span className="hud-label">PENDING</span>
                <strong className="hud-display">{peerCounts.pending}</strong>
              </span>
            ) : null}
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
            loading={directoryLoading || peerLoading}
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
            icon={<MailOutlined />}
            onClick={() => openStandaloneMailbox('unassigned')}
          >
            未归属邮箱 ({unassignedBadgeCount})
          </Button>
          <Button
            icon={<InboxOutlined />}
            disabled={!activeRoom}
            onClick={() => openStandaloneMailbox('room')}
          >
            打开房间邮箱
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => handleOpenNewTerminal(activeRoomCwd)}
          >
            项目终端
          </Button>
        </div>

        {directoryError || peerError ? (
          <div className="session-office-inline-errors" role="status" aria-live="polite">
            {directoryError ? (
              <span className="session-office-inline-error">
                <span className="hud-led hud-led--err" aria-hidden="true" />
                会话目录：{directoryError}
              </span>
            ) : null}
            {peerError ? (
              <span className="session-office-inline-error">
                <span className="hud-led hud-led--err" aria-hidden="true" />
                协作邮箱：{peerError}
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="session-office-body">
        <aside className="session-office-sidebar hud-panel" aria-label="项目房间选择器">
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
                const hasAlerts = room.pendingMailCount > 0 || room.crossProjectMailCount > 0;
                const statusLedClass = room.hasRecentPulse
                  ? 'hud-led hud-led--info hud-led--live'
                  : (room.runningCount > 0 ? 'hud-led hud-led--ok' : 'hud-led');
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

                      {hasAlerts || room.roomMessages.length > 0 ? (
                        <div className="session-office-room-pills">
                          {room.pendingMailCount > 0 ? (
                            <span className="session-office-pill session-office-pill--warn">
                              待投递 {room.pendingMailCount}
                            </span>
                          ) : null}
                          {room.crossProjectMailCount > 0 ? (
                            <span className="session-office-pill session-office-pill--cross">
                              跨项目 {room.crossProjectMailCount}
                            </span>
                          ) : null}
                          {room.roomMessages.length > 0 ? (
                            <span className="session-office-pill">
                              消息 {room.roomMessages.length}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
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

          <div className="session-office-sidebar-footer">
            <button
              type="button"
              className={`session-office-unassigned-card${mailboxOverlayOpen && mailboxScope === 'unassigned' ? ' is-active' : ''}`}
              onClick={() => openStandaloneMailbox('unassigned')}
            >
              <span className="session-office-unassigned-title">
                <MailOutlined />
                <span>未归属 / 历史邮箱</span>
              </span>
              <span className="session-office-unassigned-meta">
                {fullyUnassignedCount > 0 ? (
                  <span className="session-office-pill session-office-pill--warn">
                    纯未归属 {fullyUnassignedCount}
                  </span>
                ) : null}
                <span className="session-office-unassigned-count hud-display">
                  {unassignedMessages.length}
                </span>
              </span>
            </button>

            {unavailableSessions.length > 0 ? (
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
            ) : null}
          </div>
        </aside>

        <section className="session-office-stage" aria-label="项目三维办公空间">
          {rooms.length === 0 ? (
            <div className="session-office-stage-empty">
              {directoryLoading ? (
                <HudStateView
                  variant="loading"
                  code="SYS // DISCOVERING"
                  title="正在发现项目房间与运行会话"
                  description="正在同步当前 Server 上的活跃终端、原生 CLI 会话与协作邮箱"
                />
              ) : (
                <HudStateView
                  code="NO_ROOMS"
                  title="当前服务器没有活跃项目房间"
                  description={
                    peerMessages.length > 0
                      ? '暂无运行中的终端会话，但仍可查看未归属 / 历史邮箱或打开项目终端'
                      : '打开项目终端，或在账号管理 / AI 会话页启动 CLI 后会自动按项目房间汇聚在此'
                  }
                  extra={(
                    <>
                      <Button
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => handleOpenNewTerminal()}
                      >
                        打开项目终端
                      </Button>
                      {peerMessages.length > 0 || unassignedMessages.length > 0 ? (
                        <Button
                          icon={<MailOutlined />}
                          onClick={() => openStandaloneMailbox('unassigned')}
                        >
                          查看未归属邮箱 ({unassignedMessages.length || peerMessages.length})
                        </Button>
                      ) : null}
                    </>
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
              room={activeRoom}
              selectedSessionId={roomSelectedSessionId}
              zoomingSessionId={zoomingSessionId}
              cameraPreset={cameraPreset}
              onCameraPresetChange={setCameraPreset}
              unassignedCount={unassignedMessages.length}
              onOpenMonitor={handleOpenMonitor}
              onOpenSessionMail={handleOpenSessionMail}
              onOpenRoomMailbox={() => openStandaloneMailbox('room')}
              onOpenUnassignedMailbox={() => openStandaloneMailbox('unassigned')}
              onCopyIdentity={handleCopyIdentity}
              onOpenNewTerminal={handleOpenNewTerminal}
              directoryLoading={directoryLoading}
            />
          )}
        </section>
      </div>

      {/* 独立办公邮箱浮层：挂在任何 3D 透视/transform 容器之外，避免文字模糊与弹层偏移 */}
      {mailboxOverlayOpen && !desktopOpen ? (
        <div
          className="session-office-mailbox-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="项目办公室协作邮箱"
        >
          <div
            className="session-office-mailbox-scrim"
            onClick={() => setMailboxOverlayOpen(false)}
            aria-hidden="true"
          />
          <div className="session-office-mailbox-drawer hud-panel">
            <div className="session-office-mailbox-head">
              <div className="session-office-mailbox-heading">
                <InboxOutlined className="session-office-mailbox-head-icon" />
                <div>
                  <span className="session-office-eyebrow">OFFICE MAILBOX // READ-ONLY QUEUE</span>
                  <h2>
                    {MAILBOX_SCOPE_TITLES[mailboxScope]}
                    {mailboxScope === 'room' && unfilteredActiveRoom ? (
                      <span className="session-office-mailbox-scope-tag">
                        {resolveRoomDisplayTitle(unfilteredActiveRoom)}
                      </span>
                    ) : null}
                  </h2>
                </div>
              </div>
              <Button
                icon={<CloseOutlined />}
                onClick={() => setMailboxOverlayOpen(false)}
              >
                返回房间
              </Button>
            </div>

            <div className="session-office-mailbox-body">
              <OfficeMailbox
                scope={mailboxScope}
                onScopeChange={setMailboxScope}
                focusedSession={focusedSession}
                activeRoom={unfilteredActiveRoom}
                allRooms={rooms}
                allMessages={peerMessages}
                unassignedMessages={unassignedMessages}
                fullyUnassignedCount={fullyUnassignedCount}
                counts={peerCounts}
                loading={peerLoading}
                error={peerError}
                onRefresh={() => void refreshAll()}
                onJumpToSession={handleJumpToSession}
                compactHeader={false}
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* 员工工位桌面浮层：同样完全位于 3D 舞台容器之外，确保 xterm 几何 1:1 稳定 */}
      <SessionDesktop
        open={desktopOpen}
        serverId={serverId}
        session={focusedSession}
        room={desktopRoom}
        allRooms={rooms}
        allMessages={peerMessages}
        unassignedMessages={unassignedMessages}
        fullyUnassignedCount={fullyUnassignedCount}
        peerCounts={peerCounts}
        peerLoading={peerLoading}
        peerError={peerError}
        initialMode={desktopInitialMode}
        initialMailboxScope={desktopMailboxScope}
        originRect={desktopOriginRect}
        onCloseToRoom={handleCloseToRoom}
        onSelectRoomSession={handleSelectRoomSession}
        onJumpToAnySession={handleJumpToSession}
        onCopyIdentity={handleCopyIdentity}
        onHideSession={handleHideSession}
        onRefreshAll={() => void refreshAll()}
        onOpenNewTerminal={handleOpenNewTerminal}
      />
    </main>
  );
}
