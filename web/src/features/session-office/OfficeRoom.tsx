import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import {
  ApartmentOutlined,
  AppstoreOutlined,
  CompassOutlined,
  CompressOutlined,
  CopyOutlined,
  DesktopOutlined,
  EyeOutlined,
  InboxOutlined,
  LeftOutlined,
  MailOutlined,
  PlusOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import HudStateView from '@/components/hud/HudStateView';
import type {
  DesktopOriginRect,
  OfficeCameraPreset,
  OfficeProjectRoom,
  OfficeSessionItem,
  SessionAvailability,
} from './session-office-types';
import './OfficeRoom.css';

export interface OfficeRoomProps {
  room: OfficeProjectRoom | null;
  selectedSessionId: string | null;
  zoomingSessionId: string | null;
  cameraPreset: OfficeCameraPreset;
  onCameraPresetChange: (preset: OfficeCameraPreset) => void;
  unassignedCount: number;
  onOpenMonitor: (session: OfficeSessionItem, originRect?: DesktopOriginRect) => void;
  onOpenSessionMail: (session: OfficeSessionItem, originRect?: DesktopOriginRect) => void;
  onOpenRoomMailbox: () => void;
  onOpenUnassignedMailbox: () => void;
  onCopyIdentity: (session: OfficeSessionItem) => void;
  onOpenNewTerminal: (cwd?: string) => void;
  directoryLoading: boolean;
}

const ZONE_PAGE_SIZE = 8;

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

function toOriginRect(element: Element | null | undefined): DesktopOriginRect | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
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

function getActivityTag(session: OfficeSessionItem): string {
  const { activity, inboxCount, sentCount } = session;
  switch (activity.kind) {
    case 'incoming':
      return `↙ 收件 ${inboxCount}`;
    case 'outgoing':
      return `↗ 发件 ${sentCount}`;
    case 'both':
      return `⇄ 收${inboxCount} / 发${sentCount}`;
    case 'idle':
      if (inboxCount > 0 || sentCount > 0) {
        return `MAIL ${inboxCount}/${sentCount}`;
      }
      return session.source === 'native' ? 'NATIVE IDLE' : 'SHELL READY';
  }
}

function formatCompactPath(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed || trimmed === '__no_cwd__') return '';
  if (trimmed.length <= 42) return trimmed;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length <= 3) return trimmed;
  return `…/${parts.slice(-3).join('/')}`;
}

function resolveScreenPreview(session: OfficeSessionItem): {
  kind: 'preview' | 'mail' | 'meta';
  tag: string;
  text: string;
  subline: string;
} {
  const contentPreview = (session.contentPreview || '').trim();
  const latestSnippet = (session.activity.latestSnippet || '').trim();
  const identityLine = session.nativeSessionId || session.sessionKey;
  const compactPath = formatCompactPath(session.cwd);

  if (contentPreview) {
    return {
      kind: 'preview',
      tag: 'LIVE PREVIEW',
      text: contentPreview,
      subline: compactPath || identityLine,
    };
  }
  if (latestSnippet) {
    return {
      kind: 'mail',
      tag: 'PEER MAIL',
      text: latestSnippet,
      subline: compactPath || identityLine,
    };
  }

  return {
    kind: 'meta',
    tag: session.availability === 'unavailable' ? 'PRESERVED ID' : (session.source === 'native' ? 'NATIVE SESSION' : 'WEB SHELL'),
    text: compactPath || '未登记工作目录',
    subline: identityLine,
  };
}

interface EmployeeFigureProps {
  session: OfficeSessionItem;
  availabilityLedClass: string;
}

const EmployeeFigure = memo(function EmployeeFigure({
  session,
  availabilityLedClass,
}: EmployeeFigureProps) {
  const { persona, activity, availability } = session;
  const isActive = availability === 'interactive' || availability === 'directory-only';

  return (
    <div
      className="office-emp"
      data-posture={persona.posture}
      data-visor={persona.visorStyle}
      data-active={isActive ? 'true' : 'false'}
      data-pulse={activity.recentPulse ? 'true' : 'false'}
      aria-hidden="true"
    >
      <div className="office-emp-head-wrap">
        <div className="office-emp-head">
          <span className="office-emp-face">
            <span className="office-emp-hair" />
            <span className="office-emp-eyes">
              <span className="office-emp-eye" />
              <span className="office-emp-eye" />
            </span>
            {persona.visorStyle === 'visor' ? <span className="office-emp-visor" /> : null}
            {persona.visorStyle === 'glasses' ? (
              <span className="office-emp-glasses">
                <span className="office-emp-lens" />
                <span className="office-emp-bridge" />
                <span className="office-emp-lens" />
              </span>
            ) : null}
            {persona.visorStyle === 'headset' ? (
              <span className="office-emp-headset">
                <span className="office-emp-headband" />
                <span className="office-emp-earcup office-emp-earcup--l" />
                <span className="office-emp-earcup office-emp-earcup--r" />
                <span className="office-emp-mic" />
              </span>
            ) : null}
          </span>
          <span className="office-emp-head-side" />
          <span className="office-emp-head-top" />
        </div>
      </div>

      <div className="office-emp-neck" />

      <div className="office-emp-torso">
        <span className="office-emp-chest">
          <span className="office-emp-collar" />
          <span className="office-emp-badge">{persona.badgeCode}</span>
          <span className={`office-emp-status-dot ${availabilityLedClass}`} />
        </span>
        <span className="office-emp-torso-side" />
        <span className="office-emp-torso-top" />
      </div>

      <span className="office-emp-arm office-emp-arm--l" />
      <span className="office-emp-arm office-emp-arm--r" />
    </div>
  );
});

interface WorkstationMonitorProps {
  session: OfficeSessionItem;
  isSelected: boolean;
  isZooming: boolean;
  onRegisterMonitorRef: (sessionId: string, node: HTMLButtonElement | null) => void;
  onOpenMonitor: (session: OfficeSessionItem, originRect?: DesktopOriginRect) => void;
}

const WorkstationMonitor = memo(function WorkstationMonitor({
  session,
  isSelected,
  isZooming,
  onRegisterMonitorRef,
  onOpenMonitor,
}: WorkstationMonitorProps) {
  const availabilityMeta = getAvailabilityMeta(session.availability);
  const preview = resolveScreenPreview(session);
  const activityText = getActivityTag(session);
  const providerLabel = session.provider || (session.kind === 'shell' ? 'shell' : 'cli');
  const modelLabel = session.previewModel || session.model || '';
  const hasUnreadOrPending = session.pendingCount > 0 || session.activity.unreadOrDeliveredCount > 0;

  const setRef = useCallback((node: HTMLButtonElement | null) => {
    onRegisterMonitorRef(session.id, node);
  }, [onRegisterMonitorRef, session.id]);

  const handleClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    onOpenMonitor(session, toOriginRect(event.currentTarget));
  }, [onOpenMonitor, session]);

  return (
    <div
      className="office-monitor"
      data-selected={isSelected ? 'true' : 'false'}
      data-zooming={isZooming ? 'true' : 'false'}
      data-activity={session.activity.kind}
      data-pulse={session.activity.recentPulse ? 'true' : 'false'}
    >
      <div className="office-monitor-stand" aria-hidden="true">
        <span className="office-monitor-neck" />
        <span className="office-monitor-neck-side" />
        <span className="office-monitor-base" />
      </div>

      <button
        ref={setRef}
        type="button"
        className="office-monitor-screen-btn"
        onClick={handleClick}
        aria-label={`打开 ${session.shortLabel} 电脑桌面（${providerLabel}，${availabilityMeta.label}，收件 ${session.inboxCount}${session.pendingCount > 0 ? `，待投递 ${session.pendingCount}` : ''}）`}
        title={`${session.label} · 点击进入会话桌面`}
      >
        {/* 3D Monitor Enclosure Faces */}
        <span className="office-monitor-face office-monitor-back" aria-hidden="true" />
        <span className="office-monitor-face office-monitor-top" aria-hidden="true" />
        <span className="office-monitor-face office-monitor-bottom" aria-hidden="true" />
        <span className="office-monitor-face office-monitor-left" aria-hidden="true" />
        <span className="office-monitor-face office-monitor-right" aria-hidden="true" />

        {/* Front Bezel & Authentic Live Screen Preview */}
        <span className="office-monitor-bezel">
          <span className="office-monitor-cam" aria-hidden="true" />
          <span className="office-monitor-display">
            <span className="office-screen-head">
              <span className="office-screen-title-wrap">
                <span className={availabilityMeta.ledClass} aria-hidden="true" />
                <span className="office-screen-title">{session.shortLabel}</span>
              </span>
              <span
                className={`office-screen-mail${hasUnreadOrPending ? ' is-active' : ''}${session.activity.recentPulse ? ' is-pulse' : ''}`}
              >
                <MailOutlined aria-hidden="true" />
                <span>{session.inboxCount}</span>
                {session.pendingCount > 0 ? <em>+{session.pendingCount}</em> : null}
              </span>
            </span>

            <span className="office-screen-chips">
              <span className="office-screen-chip office-screen-chip--provider">{providerLabel}</span>
              {modelLabel ? (
                <span className="office-screen-chip office-screen-chip--model" title={modelLabel}>
                  {modelLabel}
                </span>
              ) : null}
              <span className={`office-screen-chip ${availabilityMeta.toneClass}`}>
                {availabilityMeta.label}
              </span>
            </span>

            <span className={`office-screen-body office-screen-body--${preview.kind}`}>
              <span className="office-screen-body-tag">{preview.tag}</span>
              <span className="office-screen-body-text">{preview.text}</span>
              <span className="office-screen-body-sub">{preview.subline}</span>
            </span>

            <span className="office-screen-foot">
              <span className="office-screen-activity">{activityText}</span>
              {session.activity.failedCount > 0 ? (
                <span className="office-screen-failed">失败 {session.activity.failedCount}</span>
              ) : session.crossProjectCount > 0 ? (
                <span className="office-screen-xproj">跨室 {session.crossProjectCount}</span>
              ) : null}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
});

interface WorkstationPodProps {
  session: OfficeSessionItem;
  isSelected: boolean;
  isZooming: boolean;
  onRegisterMonitorRef: (sessionId: string, node: HTMLButtonElement | null) => void;
  getMonitorRect: (sessionId: string) => DesktopOriginRect | undefined;
  onOpenMonitor: (session: OfficeSessionItem, originRect?: DesktopOriginRect) => void;
  onOpenSessionMail: (session: OfficeSessionItem, originRect?: DesktopOriginRect) => void;
  onCopyIdentity: (session: OfficeSessionItem) => void;
}

const WorkstationPod = memo(function WorkstationPod({
  session,
  isSelected,
  isZooming,
  onRegisterMonitorRef,
  getMonitorRect,
  onOpenMonitor,
  onOpenSessionMail,
  onCopyIdentity,
}: WorkstationPodProps) {
  const availabilityMeta = getAvailabilityMeta(session.availability);
  const hasTrayActivity = session.inboxCount > 0 || session.pendingCount > 0 || session.activity.kind !== 'idle';

  const podStyle = useMemo(() => ({
    '--pod-accent': session.persona.deskAccent || 'var(--color-accent)',
    '--avatar-tone': session.persona.avatarTone || 'var(--color-accent)',
  }) as CSSProperties, [session.persona.avatarTone, session.persona.deskAccent]);

  const handleDesktopAction = useCallback((event: MouseEvent<HTMLElement>) => {
    const monitorRect = getMonitorRect(session.id);
    onOpenMonitor(session, monitorRect ?? toOriginRect(event.currentTarget));
  }, [getMonitorRect, onOpenMonitor, session]);

  const handleMailAction = useCallback((event: MouseEvent<HTMLElement>) => {
    onOpenSessionMail(session, toOriginRect(event.currentTarget));
  }, [onOpenSessionMail, session]);

  const handleCopyAction = useCallback(() => {
    onCopyIdentity(session);
  }, [onCopyIdentity, session]);

  return (
    <article
      className="office-pod"
      style={podStyle}
      data-session-id={session.id}
      data-availability={session.availability}
      data-activity={session.activity.kind}
      data-pulse={session.activity.recentPulse ? 'true' : 'false'}
      data-selected={isSelected ? 'true' : 'false'}
      data-zooming={isZooming ? 'true' : 'false'}
    >
      <div className="office-pod-stage">
        {/* Floor Contact Shadow & Directional Signal Ring */}
        <div className="office-pod-floor-pad" aria-hidden="true" />

        {/* 3D Ergonomic Chair behind Employee */}
        <div className="office-chair" aria-hidden="true">
          <div className="office-chair-back">
            <span className="office-chair-back-face" />
            <span className="office-chair-back-side" />
            <span className="office-chair-headrest" />
          </div>
          <div className="office-chair-seat" />
          <div className="office-chair-stem" />
          <div className="office-chair-base" />
        </div>

        {/* 3D Humanoid Employee */}
        <EmployeeFigure
          session={session}
          availabilityLedClass={availabilityMeta.ledClass}
        />

        {/* 3D Monitor on Stand with Contextual Live Screen */}
        <WorkstationMonitor
          session={session}
          isSelected={isSelected}
          isZooming={isZooming}
          onRegisterMonitorRef={onRegisterMonitorRef}
          onOpenMonitor={onOpenMonitor}
        />

        {/* 3D Desk Slab + Thickness + Apron + 4 Volumetric Legs + Workstation Tower + Mail Tray */}
        <div className="office-desk">
          <div className="office-desk-slab" aria-hidden="true">
            <div className="office-desk-surface">
              <span className="office-desk-mat" />
              <span className="office-desk-keyboard" />
              <span className="office-desk-mouse" />
              <span className="office-desk-trim" />
            </div>
            <div className="office-desk-front-edge" />
            <div className="office-desk-side-edge office-desk-side-edge--l" />
            <div className="office-desk-side-edge office-desk-side-edge--r" />
            <div className="office-desk-apron" />
          </div>

          <div className="office-desk-legs" aria-hidden="true">
            <span className="office-desk-leg office-desk-leg--fl">
              <span className="office-desk-leg-front" />
              <span className="office-desk-leg-side" />
            </span>
            <span className="office-desk-leg office-desk-leg--fr">
              <span className="office-desk-leg-front" />
              <span className="office-desk-leg-side" />
            </span>
            <span className="office-desk-leg office-desk-leg--bl">
              <span className="office-desk-leg-front" />
              <span className="office-desk-leg-side" />
            </span>
            <span className="office-desk-leg office-desk-leg--br">
              <span className="office-desk-leg-front" />
              <span className="office-desk-leg-side" />
            </span>
          </div>

          <div className="office-tower" aria-hidden="true">
            <span className="office-tower-front">
              <span className="office-tower-led" />
              <span className="office-tower-vents" />
            </span>
            <span className="office-tower-side" />
            <span className="office-tower-top" />
          </div>

          <button
            type="button"
            className={`office-mail-tray-btn${hasTrayActivity ? ' is-active' : ''}`}
            onClick={handleMailAction}
            aria-label={`查看 ${session.shortLabel} 的同伴邮件（收件 ${session.inboxCount}，发件 ${session.sentCount}）`}
            title={`会话邮件 · 收 ${session.inboxCount} / 发 ${session.sentCount}${session.pendingCount > 0 ? ` · 待投递 ${session.pendingCount}` : ''}`}
          >
            <span className="office-mail-tray-base" aria-hidden="true" />
            <span className="office-mail-tray-front" aria-hidden="true" />
            <span className="office-mail-tray-side" aria-hidden="true" />
            {hasTrayActivity ? (
              <span className="office-mail-packet" aria-hidden="true">
                <MailOutlined />
                <span>{session.pendingCount > 0 ? session.pendingCount : session.inboxCount}</span>
              </span>
            ) : (
              <span className="office-mail-tray-empty" aria-hidden="true">TRAY</span>
            )}
            {session.activity.recentPulse ? (
              <span className="office-mail-arc" aria-hidden="true">
                <span className="office-mail-arc-dot" />
              </span>
            ) : null}
          </button>
        </div>
      </div>

      {/* Compact Pod Plaque + Semantic Action Bar */}
      <footer className="office-pod-bar">
        <div className="office-pod-identity">
          <span className="office-pod-badge">{session.persona.badgeCode}</span>
          <span className="office-pod-name" title={session.label}>
            {session.label}
          </span>
        </div>

        <div className="office-pod-actions">
          <Tooltip title={session.availability === 'unavailable' ? '查看保留会话电脑' : '打开员工电脑'}>
            <Button
              size="small"
              type={isSelected ? 'primary' : 'default'}
              icon={<DesktopOutlined />}
              onClick={handleDesktopAction}
              aria-label={`打开 ${session.shortLabel} 电脑`}
            />
          </Tooltip>
          <Tooltip title={`会话邮件 (收 ${session.inboxCount} · 发 ${session.sentCount})`}>
            <Button
              size="small"
              icon={<MailOutlined />}
              onClick={handleMailAction}
              aria-label={`打开 ${session.shortLabel} 邮件`}
            >
              {session.inboxCount > 0 || session.pendingCount > 0 ? (
                <span className="office-action-count">
                  {session.inboxCount}
                  {session.pendingCount > 0 ? `+${session.pendingCount}` : ''}
                </span>
              ) : null}
            </Button>
          </Tooltip>
          <Tooltip title="复制会话标识">
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={handleCopyAction}
              aria-label={`复制 ${session.shortLabel} 会话标识`}
            />
          </Tooltip>
        </div>
      </footer>
    </article>
  );
});

export function OfficeRoom({
  room,
  selectedSessionId,
  zoomingSessionId,
  cameraPreset,
  onCameraPresetChange,
  unassignedCount,
  onOpenMonitor,
  onOpenSessionMail,
  onOpenRoomMailbox,
  onOpenUnassignedMailbox,
  onCopyIdentity,
  onOpenNewTerminal,
  directoryLoading,
}: OfficeRoomProps) {
  const monitorRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastFollowedSelectionRef = useRef<string>('');
  const [zoneIndex, setZoneIndex] = useState(0);
  const [showAllPods, setShowAllPods] = useState(false);

  const registerMonitorRef = useCallback((sessionId: string, node: HTMLButtonElement | null) => {
    if (node) {
      monitorRefs.current.set(sessionId, node);
    } else {
      monitorRefs.current.delete(sessionId);
    }
  }, []);

  const getMonitorRect = useCallback((sessionId: string) => (
    toOriginRect(monitorRefs.current.get(sessionId))
  ), []);

  const roomKey = room?.projectKey || '';
  const totalSessions = room?.sessions.length ?? 0;
  const totalZones = Math.max(1, Math.ceil(totalSessions / ZONE_PAGE_SIZE));

  // Reset to zone 0 when switching project rooms
  useEffect(() => {
    setZoneIndex(0);
    lastFollowedSelectionRef.current = '';
  }, [roomKey]);

  // Reset scroll offset cleanly whenever switching project rooms or pagination zones
  useLayoutEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [roomKey, zoneIndex]);

  // Clamp zoneIndex if session count shrinks after filtering
  useEffect(() => {
    if (zoneIndex >= totalZones) {
      setZoneIndex(Math.max(0, totalZones - 1));
    }
  }, [totalZones, zoneIndex]);

  // Follow newly selected session across zones when paginated without snapping back on user paging
  useEffect(() => {
    if (!room || !selectedSessionId || showAllPods) return;
    const signature = `${room.projectKey}::${selectedSessionId}`;
    if (lastFollowedSelectionRef.current === signature) return;
    lastFollowedSelectionRef.current = signature;
    const matchIndex = room.sessions.findIndex((item) => item.id === selectedSessionId);
    if (matchIndex < 0) return;
    const targetZone = Math.floor(matchIndex / ZONE_PAGE_SIZE);
    setZoneIndex((prev) => (prev === targetZone ? prev : targetZone));
  }, [room, selectedSessionId, showAllPods]);

  const visibleSessions = useMemo(() => {
    if (!room) return [];
    if (showAllPods || room.sessions.length <= ZONE_PAGE_SIZE) {
      return room.sessions;
    }
    const start = zoneIndex * ZONE_PAGE_SIZE;
    return room.sessions.slice(start, start + ZONE_PAGE_SIZE);
  }, [room, showAllPods, zoneIndex]);

  const handleOpenRoomTerminal = useCallback(() => {
    if (!room || room.isFallbackRoom || !room.projectPath || room.projectPath === '__no_cwd__') {
      onOpenNewTerminal(undefined);
      return;
    }
    onOpenNewTerminal(room.projectPath);
  }, [onOpenNewTerminal, room]);

  if (directoryLoading && !room) {
    return (
      <section className="office-room-root office-room-root--state" aria-label="项目办公室加载中">
        <HudStateView
          variant="loading"
          code="SYS // BUILDING ROOM"
          title="正在构建 3D 项目办公室"
          description="正在同步当前服务器上的项目目录会话与实时邮件信号"
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
              {unassignedCount > 0 ? (
                <Button icon={<InboxOutlined />} onClick={onOpenUnassignedMailbox}>
                  未归属邮件 ({unassignedCount})
                </Button>
              ) : null}
            </div>
          )}
        />
      </section>
    );
  }

  const startSeat = showAllPods || totalSessions === 0 ? 1 : zoneIndex * ZONE_PAGE_SIZE + 1;
  const endSeat = showAllPods ? totalSessions : Math.min(totalSessions, (zoneIndex + 1) * ZONE_PAGE_SIZE);
  const needsPagination = totalSessions > ZONE_PAGE_SIZE;

  return (
    <section
      className="office-room-root"
      data-camera={cameraPreset}
      data-has-pulse={room.hasRecentPulse ? 'true' : 'false'}
      aria-label={`项目办公室 ${room.projectName}`}
    >
      {/* Compact Top Architectural Room Bar */}
      <header className="office-room-topbar">
        <div className="office-room-meta">
          <span className="office-room-eyebrow">
            <span className={room.runningCount > 0 ? 'hud-led hud-led--ok hud-led--live' : 'hud-led'} aria-hidden="true" />
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
            {room.unavailableCount > 0 ? (
              <span className="office-pill office-pill--warn">保留 {room.unavailableCount}</span>
            ) : null}
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
              {!showAllPods ? (
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
              <Button
                size="small"
                icon={showAllPods ? <CompressOutlined /> : <AppstoreOutlined />}
                onClick={() => setShowAllPods((prev) => !prev)}
              >
                {showAllPods ? '分区视图' : '展开全部'}
              </Button>
            </div>
          ) : null}

          <div className="office-camera-switch" role="group" aria-label="3D 视角预设">
            {CAMERA_OPTIONS.map((opt) => {
              const active = cameraPreset === opt.preset;
              return (
                <button
                  key={opt.preset}
                  type="button"
                  className={`office-camera-btn${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  title={opt.title}
                  onClick={() => onCameraPresetChange(opt.preset)}
                >
                  {renderCameraIcon(opt.preset)}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          <Button
            size="small"
            icon={<MailOutlined />}
            onClick={onOpenRoomMailbox}
          >
            房间邮件 {room.roomMessages.length}
            {room.pendingMailCount > 0 ? (
              <span className="office-btn-badge office-btn-badge--warn">+{room.pendingMailCount}</span>
            ) : null}
          </Button>

          <Button
            size="small"
            icon={<InboxOutlined />}
            onClick={onOpenUnassignedMailbox}
          >
            未归属 {unassignedCount}
          </Button>

          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleOpenRoomTerminal}
          >
            新建终端
          </Button>
        </div>
      </header>

      {/* Scrollable Outer Viewport (never flattens preserve-3d inside stage) */}
      <div ref={scrollContainerRef} className="office-room-scroll">
        <div className="office-room-perspective">
          <div
            key={room.projectKey}
            className="office-room-stage-frame"
          >
            <div className="office-stage" data-camera={cameraPreset}>
              {/* Architectural 3D Ceiling Beams */}
              <div className="office-ceiling" aria-hidden="true">
                <span className="office-ceiling-beam office-ceiling-beam--l" />
                <span className="office-ceiling-beam office-ceiling-beam--c" />
                <span className="office-ceiling-beam office-ceiling-beam--r" />
              </div>

              {/* Architectural 3D Side Walls */}
              <div className="office-wall-side office-wall-side--left" aria-hidden="true">
                <span className="office-wall-rib" />
                <span className="office-wall-rib" />
                <span className="office-wall-trim" />
              </div>
              <div className="office-wall-side office-wall-side--right" aria-hidden="true">
                <span className="office-wall-rib" />
                <span className="office-wall-rib" />
                <span className="office-wall-trim" />
              </div>

              {/* Architectural 3D Back Wall with Project Plaque & Room Mail Counter Terminal */}
              <div className="office-wall-back">
                <div className="office-wall-plaque">
                  <span className="office-wall-plaque-code">SECTOR // {room.projectName.toUpperCase()}</span>
                  <span className="office-wall-plaque-sub">
                    {totalSessions} 工位 · {room.runningCount} 活跃
                    {room.crossProjectMailCount > 0 ? ` · 跨项目联络 ${room.crossProjectMailCount}` : ''}
                  </span>
                </div>

                <button
                  type="button"
                  className="office-wall-mail-terminal"
                  onClick={onOpenRoomMailbox}
                  aria-label={`打开房间邮件终端（共 ${room.roomMessages.length} 封，待投递 ${room.pendingMailCount} 封）`}
                >
                  <span className="office-wall-terminal-head">
                    <MailOutlined aria-hidden="true" />
                    <span>ROOM MAIL TERMINAL</span>
                    <span className={room.hasRecentPulse ? 'hud-led hud-led--ok hud-led--live' : 'hud-led hud-led--info'} aria-hidden="true" />
                  </span>
                  <span className="office-wall-terminal-stats">
                    <span>总计 {room.roomMessages.length}</span>
                    <span>待投递 {room.pendingMailCount}</span>
                    <span>跨室 {room.crossProjectMailCount}</span>
                  </span>
                </button>
              </div>

              {/* Gridded 3D HUD Floor Plane */}
              <div className="office-floor" aria-hidden="true">
                <span className="office-floor-aisle" />
              </div>

              {/* Workstation Bays */}
              {room.sessions.length > 0 ? (
                <div className="office-pods-grid">
                  {visibleSessions.map((session) => (
                    <WorkstationPod
                      key={session.id}
                      session={session}
                      isSelected={selectedSessionId === session.id}
                      isZooming={zoomingSessionId === session.id}
                      onRegisterMonitorRef={registerMonitorRef}
                      getMonitorRect={getMonitorRect}
                      onOpenMonitor={onOpenMonitor}
                      onOpenSessionMail={onOpenSessionMail}
                      onCopyIdentity={onCopyIdentity}
                    />
                  ))}
                </div>
              ) : (
                <div className="office-room-empty-bay">
                  <HudStateView
                    compact
                    code="BAY // EMPTY"
                    title="当前项目房间暂无工位"
                    description="可在当前目录打开新终端，或打开房间邮件终端查看历史跨会话通信"
                    extra={(
                      <div className="office-room-state-actions">
                        <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenRoomTerminal}>
                          新建终端
                        </Button>
                        <Button icon={<MailOutlined />} onClick={onOpenRoomMailbox}>
                          房间邮件 ({room.roomMessages.length})
                        </Button>
                      </div>
                    )}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default OfficeRoom;
