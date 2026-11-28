import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  ArrowLeftOutlined,
  CodeOutlined,
  CompressOutlined,
  ControlOutlined,
  CopyOutlined,
  DeleteOutlined,
  DesktopOutlined,
  EyeInvisibleOutlined,
  FolderOutlined,
  GlobalOutlined,
  LoadingOutlined,
  MinusOutlined,
  PlusOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SettingOutlined,
  SplitCellsOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Tooltip } from 'antd';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import { TERMINAL_RESIZE_FINISHED } from '@/components/chat/terminal-refit';
import OfficeBrowserWindow from './OfficeBrowserWindow';
import OfficeComputerSettings, { type ComputerSettingsTab } from './OfficeComputerSettings';
import {
  OFFICE_DESKTOP_WALLPAPER_MAP,
  useOptionalDesktopWallpaperAsset,
} from './office-computer-config';
import {
  buildStationPowerMap,
  isSessionServerScopeAdmitted,
  isTerminalTabScopeAdmitted,
  useOfficeComputerPowerController,
  useOfficeComputerStoreRevision,
} from './office-computer-power';
import type {
  DesktopOriginRect,
  DesktopWindowLayout,
  OfficeProjectRoom,
  OfficeSessionItem,
  SessionAvailability,
} from './session-office-types';
import './SessionDesktop.css';

export interface SessionDesktopProps {
  open: boolean;
  serverId: string;
  session: OfficeSessionItem | null;
  room: OfficeProjectRoom | null;
  initialMode: DesktopWindowLayout;
  originRect?: DesktopOriginRect | null;
  terminatingSessionKey: string | null;
  terminateConfirmOpen?: boolean;
  onTerminateSession: (session: OfficeSessionItem) => void;
  onCloseToRoom: () => void;
  onSelectRoomSession: (session: OfficeSessionItem) => void;
  onCopyIdentity: (session: OfficeSessionItem) => void;
  onHideSession: (sessionId: string) => void;
  onRefreshAll: () => void;
  onOpenNewTerminal: (cwd?: string) => void;
}

interface AvailabilityMeta {
  label: string;
  ledClass: string;
  tone: 'ok' | 'warn' | 'err' | 'muted';
  title: string;
  description: string;
}

const NATIVE_CLOSE_DISABLED_REASON =
  '原生 CLI 会话由独立进程托管，终端 close 接口仅断开借用连接而不会终止原进程；如需结束请前往原 CLI 会话退出。';

function canTerminateWebShell(session: OfficeSessionItem | null | undefined): boolean {
  return Boolean(session && session.source === 'web' && !session.sessionKey.startsWith('native:'));
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function hasValidOriginRect(rect: DesktopOriginRect | null | undefined): rect is DesktopOriginRect {
  return Boolean(
    rect
    && Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0,
  );
}

function getAvailabilityMeta(availability?: SessionAvailability): AvailabilityMeta {
  switch (availability) {
    case 'interactive':
      return {
        label: '可尝试接入',
        ledClass: 'hud-led--ok hud-led--live',
        tone: 'ok',
        title: '具备原会话附着入口',
        description: '当前工位具备受控终端附着资格（不等同于模型正在推理忙碌）；最小化、返回办公室或虚拟电脑关机均不销毁会话，仅“关闭会话”会终止 Web Shell。',
      };
    case 'directory-only':
      return {
        label: '仅目录记录',
        ledClass: 'hud-led--warn',
        tone: 'warn',
        title: '目录已登记 · 未绑定交互视图',
        description: '此工位目前仅同步到目录信息，未确认交互式终端通道；不会自动创建同名终端覆盖原记录。',
      };
    case 'unavailable':
      return {
        label: '会话在线',
        ledClass: 'hud-led--info',
        tone: 'muted',
        title: '已保存的原会话',
        description: '会话标识与工作目录保留在办公室；终端附着需服务端目录证实对应的 tmux 会话。',
      };
    case 'exited':
      return {
        label: '进程已退出',
        ledClass: 'hud-led--err',
        tone: 'err',
        title: '终端进程已结束',
        description: '该工位关联的终端进程已退出，历史标识仍可复制；若为残留 Web Shell 记录可点击“关闭会话”清理。',
      };
    default:
      return {
        label: '未选择会话',
        ledClass: '',
        tone: 'muted',
        title: '未选定活动工位',
        description: '请从下方任务栏选择同房间工位，或打开协作消息查看消息。',
      };
  }
}

function dispatchTerminalResizeFinished(host: HTMLElement | null): void {
  if (!host) return;
  const panel = host.querySelector('[data-compact="true"]');
  if (panel) {
    panel.dispatchEvent(new Event(TERMINAL_RESIZE_FINISHED));
  }
}

export function SessionDesktop({
  open,
  serverId,
  session,
  room,
  initialMode,
  originRect,
  terminatingSessionKey,
  terminateConfirmOpen = false,
  onTerminateSession,
  onCloseToRoom,
  onSelectRoomSession,
  onCopyIdentity,
  onHideSession,
  onRefreshAll,
  onOpenNewTerminal,
}: SessionDesktopProps) {
  const [layoutMode, setLayoutMode] = useState<DesktopWindowLayout>(initialMode);
  const [terminalMinimized, setTerminalMinimized] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settingsTab, setSettingsTab] = useState<ComputerSettingsTab>('settings');
  const [portalOrigin, setPortalOrigin] = useState<DesktopOriginRect | null>(null);
  const [browserWindow, setBrowserWindow] = useState<{ identity: string; minimized: boolean } | null>(null);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const prevOpenRef = useRef(false);
  const prevDesktopIdentityRef = useRef<string | null>(null);
  const prevInitialModeRef = useRef(initialMode);
  const prevTerminalVisibleRef = useRef(false);
  const lastRefitSignatureRef = useRef('');

  const resolvedServerId = typeof serverId === 'string' ? serverId : '';
  const resolvedSessionKey = typeof session?.sessionKey === 'string' ? session.sessionKey : null;
  const desktopIdentity = JSON.stringify([resolvedServerId, resolvedSessionKey]);

  const sessionScopeAdmitted = isSessionServerScopeAdmitted(serverId, session);
  const tabScopeAdmitted = isTerminalTabScopeAdmitted(serverId, session);
  const tabId = tabScopeAdmitted ? session?.tab?.id : undefined;
  const tabSessionKey = tabScopeAdmitted ? session?.tab?.sessionKey : undefined;
  const tabLabel = tabScopeAdmitted ? session?.tab?.label : undefined;
  const tabCwd = tabScopeAdmitted ? session?.tab?.cwd : undefined;
  const tabKind = tabScopeAdmitted ? session?.tab?.kind : undefined;
  const terminalSessionTabs = useMemo(() => {
    if (!tabId || !tabSessionKey || !tabLabel) return undefined;
    return [
      {
        id: tabId,
        sessionKey: tabSessionKey,
        label: tabLabel,
        cwd: tabCwd,
        kind: tabKind,
        persistent: true,
      },
    ];
  }, [tabCwd, tabId, tabKind, tabLabel, tabSessionKey]);

  const canAttachBase = Boolean(
    sessionScopeAdmitted
    && tabScopeAdmitted
    && session?.canAttachTerminal
    && session.tab
    && terminalSessionTabs,
  );
  const isTerminating = Boolean(session && terminatingSessionKey === session.sessionKey);

  const {
    preferences,
    isPoweredOn,
    terminalReady,
    bootPhase,
    bootReason,
    shouldMountTerminal,
    durabilityNote,
    powerOffComputer,
    bootComputer,
    updateAppearance,
  } = useOfficeComputerPowerController({
    open,
    serverId,
    session,
    canAttachBase,
    isTerminating,
    terminalHostRef,
    onRefreshAll,
  });

  const browserAllowed = Boolean(open && isPoweredOn && sessionScopeAdmitted
    && resolvedServerId.trim() && resolvedSessionKey && !isTerminating);
  const browserWindowOpen = browserAllowed && browserWindow?.identity === desktopIdentity;
  const browserWindowVisible = browserWindowOpen && !browserWindow?.minimized;

  useEffect(() => {
    // Render guards unmount the old viewer immediately; never restore it on another identity or after power-off.
    setBrowserWindow((current) => browserAllowed && current?.identity === desktopIdentity ? current : null);
  }, [browserAllowed, desktopIdentity]);

  // Subscribe coworker pills to power preference updates across the room.
  const storeRevision = useOfficeComputerStoreRevision();
  const loadedWallpaperAssetUrl = useOptionalDesktopWallpaperAsset(preferences.wallpaper);

  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;

    if (!open) {
      setPortalOrigin(null);
      prevTerminalVisibleRef.current = false;
      lastRefitSignatureRef.current = '';
      return;
    }

    const identityChanged = prevDesktopIdentityRef.current !== desktopIdentity;
    prevDesktopIdentityRef.current = desktopIdentity;

    const modeChanged = prevInitialModeRef.current !== initialMode;
    prevInitialModeRef.current = initialMode;

    if (justOpened || identityChanged || modeChanged) {
      setLayoutMode(initialMode);
      setTerminalMinimized(false);
    }

    if (identityChanged) {
      setSettingsOpen(false);
      prevTerminalVisibleRef.current = false;
      lastRefitSignatureRef.current = '';
      if (!justOpened) {
        setPortalOrigin(null);
      }
    }

    if (justOpened) {
      if (hasValidOriginRect(originRect) && !prefersReducedMotion()) {
        setPortalOrigin(originRect);
      } else {
        setPortalOrigin(null);
      }

      if (!session?.canAttachTerminal || !isPoweredOn) {
        requestAnimationFrame(() => {
          shellRef.current?.focus({ preventScroll: true });
        });
      }
    }
  }, [
    desktopIdentity,
    initialMode,
    isPoweredOn,
    open,
    originRect,
    session?.canAttachTerminal,
  ]);

  useEffect(() => {
    if (!open || !portalOrigin) return undefined;
    const timer = window.setTimeout(() => {
      setPortalOrigin(null);
      dispatchTerminalResizeFinished(terminalHostRef.current);
    }, 230);
    return () => window.clearTimeout(timer);
  }, [open, portalOrigin]);

  // Global desktop Escape handling: never intercept Escape while the termination
  // confirmation dialog is open, nor inside xterm or form inputs.
  useEffect(() => {
    if (!open || terminateConfirmOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        onCloseToRoom();
        return;
      }
      if (
        event.target instanceof Element
        && event.target.closest('.xterm, input, textarea, select, .ant-modal, [contenteditable="true"]')
      ) {
        return;
      }
      event.preventDefault();
      if (settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      onCloseToRoom();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCloseToRoom, settingsOpen, terminateConfirmOpen]);

  const terminalWanted = isPoweredOn && !terminalMinimized;

  const terminalLayoutSignature = `${layoutMode}|${settingsOpen ? '1' : '0'}|${tabId ?? ''}`;

  useEffect(() => {
    if (!open) return undefined;
    const wasVisible = prevTerminalVisibleRef.current;
    prevTerminalVisibleRef.current = terminalWanted && shouldMountTerminal;
    const layoutChanged = lastRefitSignatureRef.current !== terminalLayoutSignature;
    lastRefitSignatureRef.current = terminalLayoutSignature;
    if (!terminalWanted || !shouldMountTerminal) return undefined;

    const raf = requestAnimationFrame(() => {
      if (layoutChanged || !wasVisible) {
        dispatchTerminalResizeFinished(terminalHostRef.current);
      }
      if (!wasVisible) {
        const active = document.activeElement;
        const alreadyInXterm = active instanceof Element && Boolean(active.closest('.xterm'));
        if (!alreadyInXterm) {
          const textarea = terminalHostRef.current?.querySelector('.xterm-helper-textarea');
          if (textarea instanceof HTMLElement) {
            textarea.focus({ preventScroll: true });
          }
        }
      }
    });
    const timer = window.setTimeout(() => {
      dispatchTerminalResizeFinished(terminalHostRef.current);
    }, 260);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [open, shouldMountTerminal, terminalLayoutSignature, terminalWanted]);

  const applyLayout = useCallback((nextLayout: DesktopWindowLayout) => {
    if (!isPoweredOn) return;
    setLayoutMode(nextLayout);
    if (nextLayout === 'terminal-focus') {
      setTerminalMinimized(false);
    } else {
      setTerminalMinimized(false);
      setSettingsOpen(false);
    }
  }, [isPoweredOn]);

  const handleRestoreTerminal = useCallback(() => {
    if (!isPoweredOn) {
      setSettingsOpen(false);
      return;
    }
    setTerminalMinimized(false);
  }, [isPoweredOn]);

  const handleMinimizeTerminal = useCallback(() => {
    setTerminalMinimized(true);
  }, []);

  const handleShellMinimizedChange = useCallback((nextMinimized: boolean) => {
    if (nextMinimized) {
      handleMinimizeTerminal();
    } else {
      handleRestoreTerminal();
    }
  }, [handleMinimizeTerminal, handleRestoreTerminal]);

  const handleOpenSettingsTab = useCallback((tab: ComputerSettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const handleToggleSettingsTab = useCallback((tab: ComputerSettingsTab) => {
    if (settingsOpen && settingsTab === tab) {
      setSettingsOpen(false);
    } else {
      setSettingsTab(tab);
      setSettingsOpen(true);
    }
  }, [settingsOpen, settingsTab]);

  const handleToggleTerminalDock = useCallback(() => {
    if (!isPoweredOn) {
      setSettingsOpen(false);
      return;
    }
    if (terminalWanted) {
      handleMinimizeTerminal();
    } else {
      handleRestoreTerminal();
    }
  }, [handleMinimizeTerminal, handleRestoreTerminal, isPoweredOn, terminalWanted]);

  const handleRequestTerminateCurrent = useCallback(() => {
    if (!session) return;
    onTerminateSession(session);
  }, [onTerminateSession, session]);

  const handlePowerOff = useCallback(() => {
    powerOffComputer();
  }, [powerOffComputer]);

  const handleBoot = useCallback(() => {
    setTerminalMinimized(false);
    bootComputer();
  }, [bootComputer]);

  const coworkers = useMemo(() => {
    if (room?.sessions.length) return room.sessions;
    return session ? [session] : [];
  }, [room?.sessions, session]);

  const coworkerPowerMap = useMemo(
    () => buildStationPowerMap(serverId, coworkers, storeRevision),
    [coworkers, serverId, storeRevision],
  );

  if (!open) return null;

  const availability = getAvailabilityMeta(session?.availability);
  const isWebShell = canTerminateWebShell(session);
  const projectName = room?.projectName || session?.projectName || '当前项目';
  const projectPath = room?.projectPath || session?.cwd || '未指定目录';
  const sessionTitle = session?.shortLabel || session?.label || '未选定会话';
  const wallpaperSpec = OFFICE_DESKTOP_WALLPAPER_MAP[preferences.wallpaper];

  const activePaneCount = Number(terminalWanted) + Number(settingsOpen);
  const gridColumns = activePaneCount >= 2 ? 'two' : (activePaneCount === 1 ? 'one' : 'none');
  const allWindowsMinimized = isPoweredOn && gridColumns === 'none';

  const fallbackMeta: AvailabilityMeta = bootPhase === 'exited'
    ? {
        label: '进程已退出',
        ledClass: 'hud-led--err',
        tone: 'err',
        title: '原会话进程已在关机期间结束',
        description: bootReason || availability.description,
      }
    : bootPhase === 'unavailable'
      ? {
          label: '原标识不可接入',
          ledClass: 'hud-led--warn',
          tone: 'warn',
          title: '未能恢复接入原会话 · 未自动新建替代终端',
          description: bootReason || availability.description,
        }
      : availability;

  const portalStyle = portalOrigin
    ? ({
        '--sd-origin-left': `${Math.round(portalOrigin.left)}px`,
        '--sd-origin-top': `${Math.round(portalOrigin.top)}px`,
        '--sd-origin-width': `${Math.round(portalOrigin.width)}px`,
        '--sd-origin-height': `${Math.round(portalOrigin.height)}px`,
      } as CSSProperties)
    : undefined;

  const shellStyle = {
    '--sd-rgb-color': preferences.rgbColor,
  } as CSSProperties;

  const wallpaperImgStyle = loadedWallpaperAssetUrl
    ? ({ backgroundImage: `url("${loadedWallpaperAssetUrl.replace(/"/g, '\\"')}")` } as CSSProperties)
    : undefined;

  return (
    <div
      className="session-desktop-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${projectName} — ${sessionTitle} 电脑桌面`}
    >
      {portalOrigin ? (
        <div
          className="session-desktop-launch-portal"
          style={portalStyle}
          aria-hidden="true"
        />
      ) : null}

      <div
        ref={shellRef}
        className="session-desktop-shell"
        data-rgb={preferences.rgbEnabled ? 'on' : 'off'}
        data-power={preferences.power}
        style={shellStyle}
        tabIndex={-1}
      >
        {/* OS Top Status Bar */}
        <header className="session-desktop-topbar">
          <div className="session-desktop-topbar-left">
            <button
              type="button"
              className="session-desktop-btn session-desktop-btn--back"
              disabled={isTerminating}
              onClick={onCloseToRoom}
              title="返回项目办公室（当前电源状态与后台会话原样保持）"
            >
              <ArrowLeftOutlined />
              <span>返回办公室</span>
            </button>

            <div className="session-desktop-room-chip" title={projectPath}>
              <DesktopOutlined />
              <span className="session-desktop-room-name">{projectName}</span>
              <span className="session-desktop-path-sep" aria-hidden="true">/</span>
              <span className="session-desktop-room-path">
                <FolderOutlined />
                <span>{projectPath}</span>
              </span>
            </div>

            {session ? (
              <div className="session-desktop-persona-chip" title={session.label}>
                <span className="session-desktop-badge-code">{session.persona.badgeCode}</span>
                <span className="session-desktop-session-name">{sessionTitle}</span>
                <span className={`session-desktop-status-pill session-desktop-status-pill--${availability.tone}`}>
                  <span className={`hud-led ${availability.ledClass}`} aria-hidden="true" />
                  <span>{availability.label}</span>
                </span>
                {!isPoweredOn ? (
                  <span className="session-desktop-status-pill session-desktop-status-pill--standby">
                    <PoweroffOutlined />
                    <span>虚拟已关机</span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="session-desktop-topbar-center" role="group" aria-label="桌面窗口与显示编排">
            <button
              type="button"
              className="session-desktop-layout-btn"
              data-active={isPoweredOn && layoutMode === 'terminal-focus' && terminalWanted && !settingsOpen ? 'true' : undefined}
              onClick={() => applyLayout('terminal-focus')}
            >
              <CodeOutlined />
              <span>终端窗口</span>
            </button>
            <button
              type="button"
              className="session-desktop-layout-btn"
              data-active={isPoweredOn && layoutMode === 'split' && terminalWanted ? 'true' : undefined}
              onClick={() => applyLayout('split')}
            >
              <SplitCellsOutlined />
              <span>分屏协同</span>
            </button>
            <span className="session-desktop-topbar-sep" aria-hidden="true" />
            <button
              type="button"
              className="session-desktop-layout-btn"
              data-active={settingsOpen && settingsTab === 'settings' ? 'true' : undefined}
              onClick={() => handleToggleSettingsTab('settings')}
            >
              <SettingOutlined />
              <span>电脑设置</span>
            </button>
            <button
              type="button"
              className="session-desktop-layout-btn"
              data-active={settingsOpen && settingsTab === 'config' ? 'true' : undefined}
              onClick={() => handleToggleSettingsTab('config')}
            >
              <ControlOutlined />
              <span>电脑配置</span>
            </button>
          </div>

          <div className="session-desktop-topbar-right">
            <button
              type="button"
              className="session-desktop-btn"
              disabled={isTerminating}
              onClick={onRefreshAll}
              title="刷新目录与协作消息状态"
            >
              <ReloadOutlined />
              <span>刷新</span>
            </button>
            {session ? (
              <button
                type="button"
                className="session-desktop-btn"
                disabled={isTerminating}
                onClick={() => onCopyIdentity(session)}
                title="复制原会话标识（不会重启或改动进程）"
              >
                <CopyOutlined />
                <span>复制原标识</span>
              </button>
            ) : null}
            {session ? (
              <button
                type="button"
                className="session-desktop-btn session-desktop-btn--subtle"
                disabled={isTerminating}
                onClick={() => onHideSession(session.id)}
                title="仅从当前办公室视图隐藏此工位，后台进程继续运行"
              >
                <EyeInvisibleOutlined />
                <span>隐藏视图</span>
              </button>
            ) : null}

            {session ? (
              isPoweredOn ? (
                <button
                  type="button"
                  className="session-desktop-btn session-desktop-btn--power-off"
                  disabled={isTerminating}
                  onClick={handlePowerOff}
                  title="虚拟电脑关机：仅关闭虚拟显示器并断开前端终端连接，保留后台持久会话与运行中进程"
                >
                  <PoweroffOutlined />
                  <span>虚拟关机</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="session-desktop-btn session-desktop-btn--power-on"
                  disabled={isTerminating}
                  onClick={handleBoot}
                  title="开启虚拟电脑并按原会话标识恢复连接（绝不静默启动新 Shell）"
                >
                  <ThunderboltOutlined />
                  <span>开机恢复</span>
                </button>
              )
            ) : null}

            {session ? (
              <>
                <span className="session-desktop-win-sep" aria-hidden="true" />
                {isWebShell ? (
                  <button
                    type="button"
                    className="session-desktop-btn session-desktop-btn--danger"
                    disabled={isTerminating}
                    onClick={handleRequestTerminateCurrent}
                    title="不可逆终止并销毁此 Web Shell 服务端进程（需弹窗确认）"
                  >
                    {isTerminating ? <LoadingOutlined /> : <DeleteOutlined />}
                    <span>{isTerminating ? '正在关闭…' : '关闭会话'}</span>
                  </button>
                ) : (
                  <Tooltip title={NATIVE_CLOSE_DISABLED_REASON}>
                    <span className="session-desktop-disabled-wrap">
                      <button
                        type="button"
                        className="session-desktop-btn session-desktop-btn--disabled"
                        disabled
                        aria-disabled="true"
                      >
                        <DeleteOutlined />
                        <span>关闭会话</span>
                      </button>
                    </span>
                  </Tooltip>
                )}
              </>
            ) : null}
          </div>
        </header>

        {/* Desktop Stage: Wallpaper Backdrop + Standby or Active OS Windows */}
        <main
          className="session-desktop-stage"
          data-wallpaper={preferences.wallpaper}
          data-power={preferences.power}
        >
          {isPoweredOn && loadedWallpaperAssetUrl ? (
            <div
              className="session-desktop-wallpaper-image"
              style={wallpaperImgStyle}
              aria-hidden="true"
            />
          ) : null}

          {isPoweredOn ? (
            /* Powered-On Desktop Wallpaper Canvas (Desktop Icons + Identity Summary) */
            <section
              className="session-desktop-canvas"
              data-revealed={allWindowsMinimized ? 'true' : undefined}
              aria-label="桌面图标与会话身份面板"
            >
              <div className="session-desktop-icons">
                <button
                  type="button"
                  className="session-desktop-app-icon"
                  data-active={terminalWanted ? 'true' : undefined}
                  onClick={handleRestoreTerminal}
                >
                  <span className="session-desktop-app-glyph">
                    <CodeOutlined />
                    <span className={`hud-led ${availability.ledClass} session-desktop-app-led`} aria-hidden="true" />
                  </span>
                  <span className="session-desktop-app-title">会话终端</span>
                  <span className="session-desktop-app-meta">{sessionTitle}</span>
                </button>

                <button
                  type="button"
                  className="session-desktop-app-icon"
                  data-active={settingsOpen && settingsTab === 'settings' ? 'true' : undefined}
                  onClick={() => handleOpenSettingsTab('settings')}
                >
                  <span className="session-desktop-app-glyph">
                    <SettingOutlined />
                  </span>
                  <span className="session-desktop-app-title">电脑设置</span>
                  <span className="session-desktop-app-meta">
                    {wallpaperSpec.label} · 单屏
                  </span>
                </button>

                <button
                  type="button"
                  className="session-desktop-app-icon"
                  data-active={settingsOpen && settingsTab === 'config' ? 'true' : undefined}
                  onClick={() => handleOpenSettingsTab('config')}
                >
                  <span className="session-desktop-app-glyph">
                    <ControlOutlined />
                  </span>
                  <span className="session-desktop-app-title">电脑配置</span>
                  <span className="session-desktop-app-meta">真实会话事实与建模规格</span>
                </button>
              </div>

              <aside className="session-desktop-identity-widget" aria-label="身份与进程信息">
                <div className="session-desktop-widget-header">
                  <span className="session-desktop-widget-title">
                    <DesktopOutlined />
                    <span>身份与进程信息</span>
                  </span>
                  <span className={`session-desktop-status-pill session-desktop-status-pill--${availability.tone}`}>
                    <span className={`hud-led ${availability.ledClass}`} aria-hidden="true" />
                    <span>{availability.label}</span>
                  </span>
                </div>

                {session ? (
                  <>
                    <dl className="session-desktop-meta-grid">
                      <div className="session-desktop-meta-row">
                        <dt>SESSION KEY</dt>
                        <dd><code>{session.sessionKey}</code></dd>
                      </div>
                      <div className="session-desktop-meta-row">
                        <dt>NATIVE ID</dt>
                        <dd><code>{session.nativeSessionId || '未分配（Web Shell / 无原生 ID）'}</code></dd>
                      </div>
                      <div className="session-desktop-meta-row">
                        <dt>WORKDIR</dt>
                        <dd><code>{session.cwd || '未指定目录'}</code></dd>
                      </div>
                      <div className="session-desktop-meta-row">
                        <dt>PROVIDER</dt>
                        <dd>
                          <span>
                            {session.provider || 'shell'} · {session.source === 'web' ? 'Web 终端' : '原生 CLI'}
                            {session.harness ? ` · ${session.harness}` : ''}
                            {session.model ? ` · ${session.model}` : ''}
                          </span>
                        </dd>
                      </div>
                      <div className="session-desktop-meta-row">
                        <dt>DISPLAY</dt>
                        <dd>
                          <span>
                            {wallpaperSpec.label} · 单屏 · RGB {preferences.rgbEnabled ? preferences.rgbColor.toUpperCase() : '关'}
                          </span>
                        </dd>
                      </div>
                    </dl>

                    {!isWebShell ? (
                      <p className="session-desktop-lifecycle-note">
                        {NATIVE_CLOSE_DISABLED_REASON}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="session-desktop-widget-empty">当前未选定会话，请从底部任务栏切换或返回办公室。</p>
                )}

                <div className="session-desktop-widget-actions">
                  <button
                    type="button"
                    className="session-desktop-btn"
                    onClick={() => handleOpenSettingsTab('config')}
                  >
                    <ControlOutlined />
                    <span>查看电脑配置</span>
                  </button>
                  {session ? (
                    <button
                      type="button"
                      className="session-desktop-btn"
                      disabled={isTerminating}
                      onClick={() => onCopyIdentity(session)}
                    >
                      <CopyOutlined />
                      <span>复制原标识</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="session-desktop-btn"
                    disabled={isTerminating}
                    onClick={() => onOpenNewTerminal(session?.cwd || room?.projectPath)}
                  >
                    <PlusOutlined />
                    <span>新建项目终端</span>
                  </button>
                  {session ? (
                    <button
                      type="button"
                      className="session-desktop-btn session-desktop-btn--power-off"
                      disabled={isTerminating}
                      onClick={handlePowerOff}
                    >
                      <PoweroffOutlined />
                      <span>虚拟电脑关机</span>
                    </button>
                  ) : null}
                  {session ? (
                    isWebShell ? (
                      <button
                        type="button"
                        className="session-desktop-btn session-desktop-btn--danger"
                        disabled={isTerminating}
                        onClick={handleRequestTerminateCurrent}
                      >
                        {isTerminating ? <LoadingOutlined /> : <DeleteOutlined />}
                        <span>{isTerminating ? '正在关闭…' : '关闭会话'}</span>
                      </button>
                    ) : (
                      <Tooltip title={NATIVE_CLOSE_DISABLED_REASON}>
                        <span className="session-desktop-disabled-wrap">
                          <button
                            type="button"
                            className="session-desktop-btn session-desktop-btn--disabled"
                            disabled
                            aria-disabled="true"
                          >
                            <DeleteOutlined />
                            <span>关闭会话</span>
                          </button>
                        </span>
                      </Tooltip>
                    )
                  ) : null}
                </div>
              </aside>
            </section>
          ) : (
            /* Virtual Workstation Powered-Off Standby Screen (Zero ShellTerminalPanel Mount) */
            <section
              className="session-desktop-standby"
              aria-label="虚拟电脑已关机待机屏幕"
            >
              <div className="session-desktop-standby-screen">
                <div className="session-desktop-standby-top">
                  <span className="session-desktop-status-pill session-desktop-status-pill--standby">
                    <PoweroffOutlined />
                    <span>STANDBY · 虚拟电脑已关机</span>
                  </span>
                  <span className="session-desktop-standby-tag">{durabilityNote.badge}</span>
                </div>

                <h2 className="session-desktop-standby-title">
                  {sessionTitle} — 虚拟显示器已断电熄屏
                </h2>

                <p className="session-desktop-standby-desc">
                  当前仅关闭虚拟桌面显示并解除了浏览器终端流附着，未发送任何 close 或进程退出信号。
                  {durabilityNote.summary}
                </p>

                {session ? (
                  <dl className="session-desktop-meta-grid session-desktop-meta-grid--compact">
                    <div className="session-desktop-meta-row">
                      <dt>SESSION KEY</dt>
                      <dd><code>{session.sessionKey}</code></dd>
                    </div>
                    {session.nativeSessionId ? (
                      <div className="session-desktop-meta-row">
                        <dt>NATIVE ID</dt>
                        <dd><code>{session.nativeSessionId}</code></dd>
                      </div>
                    ) : null}
                    <div className="session-desktop-meta-row">
                      <dt>WORKDIR</dt>
                      <dd><code>{session.cwd || '未指定目录'}</code></dd>
                    </div>
                    <div className="session-desktop-meta-row">
                      <dt>PROVIDER</dt>
                      <dd>
                        <span>
                          {session.provider || 'shell'} · {session.source === 'web' ? 'Web 终端' : '原生 CLI'}
                        </span>
                      </dd>
                    </div>
                  </dl>
                ) : null}

                <div className="session-desktop-standby-actions">
                  {session ? (
                    <button
                      type="button"
                      className="session-desktop-btn session-desktop-btn--power-on"
                      disabled={isTerminating}
                      onClick={handleBoot}
                    >
                      <ThunderboltOutlined />
                      <span>开机并恢复原会话</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="session-desktop-btn"
                    onClick={() => handleOpenSettingsTab('settings')}
                  >
                    <SettingOutlined />
                    <span>电脑设置</span>
                  </button>
                  <button
                    type="button"
                    className="session-desktop-btn"
                    onClick={() => handleOpenSettingsTab('config')}
                  >
                    <ControlOutlined />
                    <span>查看电脑配置</span>
                  </button>
                  {session ? (
                    <button
                      type="button"
                      className="session-desktop-btn"
                      disabled={isTerminating}
                      onClick={() => onCopyIdentity(session)}
                    >
                      <CopyOutlined />
                      <span>复制原标识</span>
                    </button>
                  ) : null}
                  {session ? (
                    isWebShell ? (
                      <button
                        type="button"
                        className="session-desktop-btn session-desktop-btn--danger"
                        disabled={isTerminating}
                        onClick={handleRequestTerminateCurrent}
                        title="不可逆销毁并停止服务端此 Web Shell 会话（需确认）"
                      >
                        {isTerminating ? <LoadingOutlined /> : <DeleteOutlined />}
                        <span>{isTerminating ? '正在关闭…' : '关闭会话'}</span>
                      </button>
                    ) : (
                      <Tooltip title={NATIVE_CLOSE_DISABLED_REASON}>
                        <span className="session-desktop-disabled-wrap">
                          <button
                            type="button"
                            className="session-desktop-btn session-desktop-btn--disabled"
                            disabled
                            aria-disabled="true"
                          >
                            <DeleteOutlined />
                            <span>关闭会话</span>
                          </button>
                        </span>
                      </Tooltip>
                    )
                  ) : null}
                </div>
              </div>

                          </section>
          )}

          {/* OS Windows Layer */}
          <div
            className="session-desktop-windows"
            data-cols={gridColumns}
          >
            {/* Terminal OS Window — constant JSX slot so ShellTerminalPanel never remounts on layout toggles */}
            <section
              className={`session-desktop-window session-desktop-window--terminal${terminalWanted ? '' : ' session-desktop-window--docked'}`}
              aria-label={`会话终端 — ${sessionTitle}`}
              aria-hidden={!terminalWanted}
            >
              <div className="session-desktop-window-bar">
                <div className="session-desktop-window-title">
                  <CodeOutlined />
                  <span className={`hud-led ${availability.ledClass}`} aria-hidden="true" />
                  <span className="session-desktop-window-name">会话终端 — {sessionTitle}</span>
                  {session?.cwd ? (
                    <span className="session-desktop-window-sub" title={session.cwd}>{session.cwd}</span>
                  ) : null}
                </div>
                <div className="session-desktop-window-controls">
                  <button
                    type="button"
                    className="session-desktop-win-btn"
                    onClick={() => handleToggleSettingsTab('settings')}
                    title="打开或收起电脑设置窗口"
                    aria-label="切换电脑设置窗口"
                  >
                    <SettingOutlined />
                  </button>
                  <button
                    type="button"
                    className="session-desktop-win-btn"
                    onClick={() => applyLayout(layoutMode === 'split' ? 'terminal-focus' : 'split')}
                    title={layoutMode === 'split' ? '独占终端窗口' : '分屏协同'}
                    aria-label={layoutMode === 'split' ? '独占终端窗口' : '分屏协同'}
                  >
                    {layoutMode === 'split' ? <CompressOutlined /> : <SplitCellsOutlined />}
                  </button>
                  <button
                    type="button"
                    className="session-desktop-win-btn"
                    onClick={handleMinimizeTerminal}
                    aria-label="最小化终端窗口"
                    title="最小化窗口到任务栏（电脑保持开机，终端连接不中断）"
                  >
                    <MinusOutlined />
                  </button>

                  {session ? (
                    <>
                      <span className="session-desktop-win-sep" aria-hidden="true" />
                      <button
                        type="button"
                        className="session-desktop-win-power-btn"
                        disabled={isTerminating}
                        onClick={handlePowerOff}
                        title="虚拟电脑关机：仅熄灭显示器并断开前端终端附着，保留后台持久会话"
                      >
                        <PoweroffOutlined />
                        <span>虚拟关机</span>
                      </button>
                      {isWebShell ? (
                        <button
                          type="button"
                          className="session-desktop-win-terminate-btn"
                          disabled={isTerminating}
                          onClick={handleRequestTerminateCurrent}
                          title="不可逆关闭并终止此 Web Shell 会话进程（需确认）"
                        >
                          {isTerminating ? <LoadingOutlined /> : <DeleteOutlined />}
                          <span>{isTerminating ? '关闭中…' : '关闭会话'}</span>
                        </button>
                      ) : (
                        <Tooltip title={NATIVE_CLOSE_DISABLED_REASON}>
                          <span className="session-desktop-disabled-wrap">
                            <button
                              type="button"
                              className="session-desktop-win-terminate-btn is-disabled"
                              disabled
                              aria-disabled="true"
                            >
                              <DeleteOutlined />
                              <span>关闭会话</span>
                            </button>
                          </span>
                        </Tooltip>
                      )}
                    </>
                  ) : null}
                </div>
              </div>

              <div ref={terminalHostRef} className="session-desktop-terminal-host">
                {shouldMountTerminal && session && session.tab ? (
                  <ShellTerminalPanel
                    key={`${serverId}:${session.tab.id}`}
                    visible={true}
                    persistent={true}
                    strictExistingSession={true}
                    compactChrome={true}
                    allowNewTab={false}
                    layout="tabs"
                    title={sessionTitle}
                    cwd={session.cwd}
                    panelHeight={640}
                    sessionTabs={terminalSessionTabs}
                    activeTabId={session.tab.id}
                    minimized={!terminalWanted}
                    onMinimizedChange={handleShellMinimizedChange}
                    onClose={handleRequestTerminateCurrent}
                  />
                ) : bootPhase === 'checking' ? (
                  <div className="session-desktop-terminal-fallback">
                    <div className="session-desktop-fallback-card">
                      <div className="session-desktop-fallback-head">
                        <span className="session-desktop-status-pill">
                          <LoadingOutlined />
                          <span>正在核对原会话</span>
                        </span>
                        <h3>正在按原标识核对持久会话状态…</h3>
                      </div>
                      <p className="session-desktop-fallback-desc">
                        {bootReason || '正在向当前服务器核对原会话标识，确认存活后将直接恢复附着，绝不静默创建替代终端。'}
                      </p>
                      {session ? (
                        <dl className="session-desktop-meta-grid session-desktop-meta-grid--compact">
                          <div className="session-desktop-meta-row">
                            <dt>SESSION KEY</dt>
                            <dd><code>{session.sessionKey}</code></dd>
                          </div>
                        </dl>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="session-desktop-terminal-fallback">
                    <div className="session-desktop-fallback-card">
                      <div className="session-desktop-fallback-head">
                        <span className={`session-desktop-status-pill session-desktop-status-pill--${fallbackMeta.tone}`}>
                          <span className={`hud-led ${fallbackMeta.ledClass}`} aria-hidden="true" />
                          <span>{fallbackMeta.label}</span>
                        </span>
                        <h3>{fallbackMeta.title}</h3>
                      </div>

                      <p className="session-desktop-fallback-desc">{fallbackMeta.description}</p>

                      {session ? (
                        <dl className="session-desktop-meta-grid session-desktop-meta-grid--compact">
                          <div className="session-desktop-meta-row">
                            <dt>SESSION KEY</dt>
                            <dd><code>{session.sessionKey}</code></dd>
                          </div>
                          {session.nativeSessionId ? (
                            <div className="session-desktop-meta-row">
                              <dt>NATIVE ID</dt>
                              <dd><code>{session.nativeSessionId}</code></dd>
                            </div>
                          ) : null}
                          <div className="session-desktop-meta-row">
                            <dt>WORKDIR</dt>
                            <dd><code>{session.cwd || '未指定目录'}</code></dd>
                          </div>
                          <div className="session-desktop-meta-row">
                            <dt>PROVIDER</dt>
                            <dd>
                              <span>
                                {session.provider || 'shell'} · {session.source === 'web' ? 'Web 终端' : '原生 CLI'}
                              </span>
                            </dd>
                          </div>
                        </dl>
                      ) : null}

                      {session && !isWebShell ? (
                        <p className="session-desktop-lifecycle-note">
                          {NATIVE_CLOSE_DISABLED_REASON}
                        </p>
                      ) : null}

                      {session?.contentPreview ? (
                        <div className="session-desktop-preview-box">
                          <span className="session-desktop-preview-label">最近同步摘要（只读）</span>
                          <pre>{session.contentPreview}</pre>
                        </div>
                      ) : null}

                      <div className="session-desktop-fallback-actions">
                        {session && (bootPhase === 'unavailable' || bootPhase === 'exited') ? (
                          <button
                            type="button"
                            className="session-desktop-btn session-desktop-btn--power-on"
                            disabled={isTerminating}
                            onClick={handleBoot}
                          >
                            <ThunderboltOutlined />
                            <span>重新尝试接入原会话</span>
                          </button>
                        ) : null}
                        {session ? (
                          <button
                            type="button"
                            className="session-desktop-btn"
                            disabled={isTerminating}
                            onClick={() => onCopyIdentity(session)}
                          >
                            <CopyOutlined />
                            <span>复制原标识</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="session-desktop-btn"
                          disabled={isTerminating}
                          onClick={onRefreshAll}
                        >
                          <ReloadOutlined />
                          <span>刷新核对</span>
                        </button>
                        <button
                          type="button"
                          className="session-desktop-btn"
                          onClick={() => handleOpenSettingsTab('config')}
                        >
                          <ControlOutlined />
                          <span>查看电脑配置</span>
                        </button>
                        <button
                          type="button"
                          className="session-desktop-btn session-desktop-btn--primary"
                          disabled={isTerminating}
                          onClick={() => onOpenNewTerminal(session?.cwd || room?.projectPath)}
                        >
                          <PlusOutlined />
                          <span>新建项目终端</span>
                        </button>
                        {session ? (
                          isWebShell ? (
                            <button
                              type="button"
                              className="session-desktop-btn session-desktop-btn--danger"
                              disabled={isTerminating}
                              onClick={handleRequestTerminateCurrent}
                            >
                              {isTerminating ? <LoadingOutlined /> : <DeleteOutlined />}
                              <span>{isTerminating ? '正在关闭…' : '关闭会话'}</span>
                            </button>
                          ) : (
                            <Tooltip title={NATIVE_CLOSE_DISABLED_REASON}>
                              <span className="session-desktop-disabled-wrap">
                                <button
                                  type="button"
                                  className="session-desktop-btn session-desktop-btn--disabled"
                                  disabled
                                  aria-disabled="true"
                                >
                                  <DeleteOutlined />
                                  <span>关闭会话</span>
                                </button>
                              </span>
                            </Tooltip>
                          )
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Focused Computer Settings & Configuration Window */}
            <OfficeComputerSettings
              open={settingsOpen}
              activeTab={settingsTab}
              onTabChange={setSettingsTab}
              onCloseWindow={() => setSettingsOpen(false)}
              onFocusTerminal={isPoweredOn ? () => {
                setSettingsOpen(false);
                handleRestoreTerminal();
              } : undefined}
              serverId={serverId}
              session={session}
              room={room}
              preferences={preferences}
              loadedWallpaperAssetUrl={loadedWallpaperAssetUrl}
              terminalReadyObserved={terminalReady}
              durabilityNote={durabilityNote}
              isTerminating={isTerminating}
              onPowerOffComputer={handlePowerOff}
              onBootComputer={handleBoot}
              onUpdateAppearance={updateAppearance}
              onCopyIdentity={onCopyIdentity}
            />
          </div>
          {browserWindowVisible ? (
            <OfficeBrowserWindow
              key={desktopIdentity}
              requiredServerId={resolvedServerId}
              onMinimize={() => setBrowserWindow((current) => current ? { ...current, minimized: true } : null)}
              onClose={() => setBrowserWindow(null)}
            />
          ) : null}
        </main>

        {/* Bottom Desktop Dock / Taskbar */}
        <footer className="session-desktop-dock" aria-label="桌面任务栏">
          <div className="session-desktop-dock-apps">
            <button
              type="button"
              className="session-desktop-dock-pill"
              data-active={terminalWanted ? 'true' : undefined}
              data-minimized={!terminalWanted ? 'true' : undefined}
              onClick={handleToggleTerminalDock}
              title={
                !isPoweredOn
                  ? '查看虚拟电脑待机屏（点击“开机恢复”可重连终端）'
                  : (terminalWanted ? '最小化终端窗口（保持开机与后台运行）' : '恢复终端窗口')
              }
            >
              <CodeOutlined />
              <span className={`hud-led ${isPoweredOn ? availability.ledClass : ''}`} aria-hidden="true" />
              <span>会话终端</span>
            </button>

            <button
              type="button"
              className="session-desktop-dock-pill"
              disabled={!browserAllowed}
              data-active={browserWindowVisible ? 'true' : undefined}
              data-minimized={browserWindowOpen && !browserWindowVisible ? 'true' : undefined}
              aria-label="在虚拟电脑内部打开或恢复任务浏览器窗口"
              aria-expanded={browserWindowVisible}
              title={!browserAllowed
                ? '任务浏览器需要已开机的虚拟电脑及明确的 Server 和会话身份'
                : browserWindowVisible
                  ? '最小化任务浏览器并释放控制连接（后台会话不变）'
                  : '在虚拟电脑内部打开任务浏览器；需手动启动，尚未绑定账号'}
              onClick={() => setBrowserWindow((current) => current?.identity === desktopIdentity
                ? { ...current, minimized: !current.minimized }
                : { identity: desktopIdentity, minimized: false })}
            >
              <GlobalOutlined />
              <span>任务浏览器</span>
            </button>

            <button
              type="button"
              className="session-desktop-dock-pill"
              data-active={settingsOpen && settingsTab === 'settings' ? 'true' : undefined}
              data-minimized={!(settingsOpen && settingsTab === 'settings') ? 'true' : undefined}
              onClick={() => handleToggleSettingsTab('settings')}
              title="切换电脑显示与电源设置窗口"
            >
              <SettingOutlined />
              <span>电脑设置</span>
            </button>

            <button
              type="button"
              className="session-desktop-dock-pill"
              data-active={settingsOpen && settingsTab === 'config' ? 'true' : undefined}
              data-minimized={!(settingsOpen && settingsTab === 'config') ? 'true' : undefined}
              onClick={() => handleToggleSettingsTab('config')}
              title="切换电脑配置与会话事实窗口"
            >
              <ControlOutlined />
              <span>电脑配置</span>
            </button>
          </div>

          <div className="session-desktop-dock-divider" aria-hidden="true" />

          <nav className="session-desktop-dock-coworkers" aria-label="同房间工位切换">
            {coworkers.map((coworker) => {
              const isCurrent = coworker.id === session?.id;
              const coworkerMeta = getAvailabilityMeta(coworker.availability);
              const coworkerPower = coworkerPowerMap.get(coworker.sessionKey) ?? 'on';
              return (
                <button
                  key={coworker.id}
                  type="button"
                  className="session-desktop-coworker-pill"
                  data-active={isCurrent ? 'true' : undefined}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => onSelectRoomSession(coworker)}
                  title={`${coworker.label} · ${coworkerMeta.label}${coworkerPower === 'off' ? ' · 虚拟已关机' : ''}`}
                >
                  {coworker.canAttachTerminal ? <CodeOutlined /> : <UserOutlined />}
                  <span className={`hud-led ${coworkerPower === 'off' ? '' : coworkerMeta.ledClass}`} aria-hidden="true" />
                  <span className="session-desktop-coworker-code">{coworker.persona.badgeCode}</span>
                  <span className="session-desktop-coworker-name">{coworker.shortLabel || coworker.label}</span>
                  {coworkerPower === 'off' ? (
                    <PoweroffOutlined className="session-desktop-coworker-poweroff" aria-label="虚拟已关机" />
                  ) : null}
                </button>
              );
            })}
          </nav>

          <div className="session-desktop-dock-right">
            {session ? (
              isPoweredOn ? (
                <button
                  type="button"
                  className="session-desktop-btn session-desktop-btn--power-off"
                  disabled={isTerminating}
                  onClick={handlePowerOff}
                  title="虚拟电脑关机：仅熄屏并断开前端附着，保留后台会话"
                >
                  <PoweroffOutlined />
                  <span>虚拟关机</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="session-desktop-btn session-desktop-btn--power-on"
                  disabled={isTerminating}
                  onClick={handleBoot}
                  title="开机恢复原会话连接"
                >
                  <ThunderboltOutlined />
                  <span>开机恢复</span>
                </button>
              )
            ) : null}

            <button
              type="button"
              className="session-desktop-btn session-desktop-dock-return"
              disabled={isTerminating}
              onClick={onCloseToRoom}
              title="返回项目办公室（后台会话继续运行）"
            >
              <ArrowLeftOutlined />
              <span>返回房间</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default SessionDesktop;
