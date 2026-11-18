import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftOutlined,
  CodeOutlined,
  CompressOutlined,
  CopyOutlined,
  DesktopOutlined,
  EyeInvisibleOutlined,
  FolderOutlined,
  MailOutlined,
  MinusOutlined,
  PlusOutlined,
  ReloadOutlined,
  SplitCellsOutlined,
  UserOutlined,
} from '@ant-design/icons';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import { TERMINAL_RESIZE_FINISHED } from '@/components/chat/terminal-refit';
import OfficeMailbox from './OfficeMailbox';
import type {
  DesktopOriginRect,
  DesktopWindowLayout,
  EnrichedPeerMessage,
  MailboxScope,
  OfficeProjectRoom,
  OfficeSessionItem,
  PeerCounts,
  SessionAvailability,
} from './session-office-types';
import './SessionDesktop.css';

export interface SessionDesktopProps {
  open: boolean;
  serverId: string;
  session: OfficeSessionItem | null;
  room: OfficeProjectRoom | null;
  allRooms: OfficeProjectRoom[];
  allMessages: EnrichedPeerMessage[];
  unassignedMessages: EnrichedPeerMessage[];
  fullyUnassignedCount: number;
  peerCounts: PeerCounts;
  peerLoading: boolean;
  peerError: string;
  initialMode: DesktopWindowLayout;
  initialMailboxScope?: MailboxScope;
  originRect?: DesktopOriginRect | null;
  onCloseToRoom: () => void;
  onSelectRoomSession: (session: OfficeSessionItem) => void;
  onJumpToAnySession: (sessionKey: string, projectKey?: string | null) => void;
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
    rect &&
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0,
  );
}

function getAvailabilityMeta(availability?: SessionAvailability): AvailabilityMeta {
  switch (availability) {
    case 'interactive':
      return {
        label: '在线可接入',
        ledClass: 'hud-led--ok hud-led--live',
        tone: 'ok',
        title: '持久终端就绪',
        description: '当前终端由持久后端托管，可直接交互输入；最小化或返回办公室均会保持后台运行。',
      };
    case 'directory-only':
      return {
        label: '仅目录记录',
        ledClass: 'hud-led--warn',
        tone: 'warn',
        title: '目录已登记 · 未绑定 Web PTY',
        description: '此工位目前仅同步到目录信息，未确认交互式终端通道；不会自动创建同名终端覆盖原记录。',
      };
    case 'unavailable':
      return {
        label: '原标识已保留',
        ledClass: 'hud-led--warn',
        tone: 'warn',
        title: '原会话暂未确认可接入',
        description: '原会话标识与工作目录已完整保留，刷新后会重新核对；绝不会自动重启或替换为新终端。',
      };
    case 'exited':
      return {
        label: '进程已退出',
        ledClass: 'hud-led--err',
        tone: 'err',
        title: '终端进程已结束',
        description: '该工位关联的终端进程已退出，历史标识仍可复制；如需新会话可手动新建项目终端。',
      };
    default:
      return {
        label: '未选择会话',
        ledClass: '',
        tone: 'muted',
        title: '未选定活动工位',
        description: '请从下方任务栏选择同房间工位，或打开 Peer 邮箱查看协作消息。',
      };
  }
}

function getMailboxScopeTitle(
  scope: MailboxScope,
  room: OfficeProjectRoom | null,
  session: OfficeSessionItem | null,
): string {
  switch (scope) {
    case 'session':
      return session ? `${session.shortLabel || session.label} · 个人收发` : '当前工位';
    case 'room':
      return room ? `${room.projectName} · 房间通信` : '当前项目房间';
    case 'unassigned':
      return '未归属 / 待认领';
    case 'all':
      return '服务器全部消息';
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
  allRooms,
  allMessages,
  unassignedMessages,
  fullyUnassignedCount,
  peerCounts,
  peerLoading,
  peerError,
  initialMode,
  initialMailboxScope,
  originRect,
  onCloseToRoom,
  onSelectRoomSession,
  onJumpToAnySession,
  onCopyIdentity,
  onHideSession,
  onRefreshAll,
  onOpenNewTerminal,
}: SessionDesktopProps) {
  const [layoutMode, setLayoutMode] = useState<DesktopWindowLayout>(initialMode);
  const [terminalMinimized, setTerminalMinimized] = useState<boolean>(initialMode === 'mail-focus');
  const [mailMinimized, setMailMinimized] = useState<boolean>(initialMode === 'terminal-focus');
  const [mailboxScope, setMailboxScope] = useState<MailboxScope>(initialMailboxScope ?? 'session');
  const [portalOrigin, setPortalOrigin] = useState<DesktopOriginRect | null>(null);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const prevOpenRef = useRef(false);
  const prevInitialModeRef = useRef(initialMode);
  const prevInitialScopeRef = useRef(initialMailboxScope);
  const prevTerminalOpenRef = useRef(false);

  // Sync open/mode/scope transitions cleanly without resetting user state on polling ticks.
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;

    if (!open) {
      setPortalOrigin(null);
      prevTerminalOpenRef.current = false;
      return;
    }

    if (justOpened || prevInitialModeRef.current !== initialMode) {
      prevInitialModeRef.current = initialMode;
      setLayoutMode(initialMode);
      setTerminalMinimized(initialMode === 'mail-focus');
      setMailMinimized(initialMode === 'terminal-focus');
    }

    if (justOpened || prevInitialScopeRef.current !== initialMailboxScope) {
      prevInitialScopeRef.current = initialMailboxScope;
      setMailboxScope(initialMailboxScope ?? 'session');
    }

    if (justOpened) {
      if (hasValidOriginRect(originRect) && !prefersReducedMotion()) {
        setPortalOrigin(originRect);
      } else {
        setPortalOrigin(null);
      }

      if (initialMode === 'mail-focus' || !session?.canAttachTerminal) {
        requestAnimationFrame(() => {
          shellRef.current?.focus({ preventScroll: true });
        });
      }
    }
  }, [initialMailboxScope, initialMode, open, originRect, session?.canAttachTerminal]);

  // Clear the non-terminal launch portal after ~220ms and ensure xterm refits cleanly.
  useEffect(() => {
    if (!open || !portalOrigin) return undefined;
    const timer = window.setTimeout(() => {
      setPortalOrigin(null);
      dispatchTerminalResizeFinished(terminalHostRef.current);
    }, 230);
    return () => window.clearTimeout(timer);
  }, [open, portalOrigin]);

  // Global desktop Escape handling: never intercept normal Escape inside xterm or form controls;
  // Alt+Escape always exits back to the 3D room.
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        onCloseToRoom();
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest('.xterm, input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      event.preventDefault();
      onCloseToRoom();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCloseToRoom]);

  const terminalOpen = !terminalMinimized && layoutMode !== 'mail-focus';
  const mailOpen = !mailMinimized && layoutMode !== 'terminal-focus';

  // Refit xterm after restoring from dock or toggling split mode; focus xterm only on restore.
  useEffect(() => {
    if (!open) return undefined;
    const wasTerminalOpen = prevTerminalOpenRef.current;
    prevTerminalOpenRef.current = terminalOpen;
    if (!terminalOpen || !session?.canAttachTerminal) return undefined;

    const raf = requestAnimationFrame(() => {
      dispatchTerminalResizeFinished(terminalHostRef.current);
      if (!wasTerminalOpen) {
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
  }, [layoutMode, open, session?.canAttachTerminal, session?.tab?.id, terminalOpen]);

  const applyLayout = useCallback((nextLayout: DesktopWindowLayout) => {
    setLayoutMode(nextLayout);
    if (nextLayout === 'terminal-focus') {
      setTerminalMinimized(false);
      setMailMinimized(true);
    } else if (nextLayout === 'mail-focus') {
      setTerminalMinimized(true);
      setMailMinimized(false);
    } else {
      setTerminalMinimized(false);
      setMailMinimized(false);
    }
  }, []);

  const handleRestoreTerminal = useCallback(() => {
    setTerminalMinimized(false);
    if (layoutMode === 'mail-focus') {
      setLayoutMode('terminal-focus');
      setMailMinimized(true);
    }
  }, [layoutMode]);

  const handleMinimizeTerminal = useCallback(() => {
    if (layoutMode === 'split' && !mailMinimized) {
      setTerminalMinimized(true);
      setLayoutMode('mail-focus');
      return;
    }
    setTerminalMinimized(true);
  }, [layoutMode, mailMinimized]);

  const handleShellMinimizedChange = useCallback((nextMinimized: boolean) => {
    if (nextMinimized) {
      handleMinimizeTerminal();
    } else {
      handleRestoreTerminal();
    }
  }, [handleMinimizeTerminal, handleRestoreTerminal]);

  const handleRestoreMail = useCallback(() => {
    setMailMinimized(false);
    if (layoutMode === 'terminal-focus') {
      setLayoutMode('mail-focus');
      setTerminalMinimized(true);
    }
  }, [layoutMode]);

  const handleMinimizeMail = useCallback(() => {
    if (layoutMode === 'split' && !terminalMinimized) {
      setMailMinimized(true);
      setLayoutMode('terminal-focus');
      return;
    }
    setMailMinimized(true);
  }, [layoutMode, terminalMinimized]);

  const handleToggleTerminalDock = useCallback(() => {
    if (terminalOpen) {
      handleMinimizeTerminal();
    } else {
      handleRestoreTerminal();
    }
  }, [handleMinimizeTerminal, handleRestoreTerminal, terminalOpen]);

  const handleToggleMailDock = useCallback(() => {
    if (mailOpen) {
      handleMinimizeMail();
    } else {
      handleRestoreMail();
    }
  }, [handleMinimizeMail, handleRestoreMail, mailOpen]);

  const handleJumpToSessionFromMail = useCallback((sessionKey: string, projectKey?: string | null) => {
    setLayoutMode('terminal-focus');
    setTerminalMinimized(false);
    setMailMinimized(true);
    setMailboxScope('session');
    onJumpToAnySession(sessionKey, projectKey);
  }, [onJumpToAnySession]);

  // Memoize the single-tab descriptor so polling updates on unread counts do not churn ShellTerminalPanel.
  const tabId = session?.tab?.id;
  const tabSessionKey = session?.tab?.sessionKey;
  const tabLabel = session?.tab?.label;
  const tabCwd = session?.tab?.cwd;
  const tabKind = session?.tab?.kind;
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

  const coworkers = useMemo(() => {
    if (room?.sessions.length) return room.sessions;
    return session ? [session] : [];
  }, [room?.sessions, session]);

  if (!open) return null;

  const availability = getAvailabilityMeta(session?.availability);
  const canAttach = Boolean(session?.canAttachTerminal && session.tab && terminalSessionTabs);
  const projectName = room?.projectName || session?.projectName || '当前项目';
  const projectPath = room?.projectPath || session?.cwd || '未指定目录';
  const sessionTitle = session?.shortLabel || session?.label || '未选定会话';
  const sessionInbox = session?.inboxCount ?? 0;
  const sessionPending = session?.pendingCount ?? 0;
  const roomPending = room?.pendingMailCount ?? 0;
  const mailBadgeCount = sessionInbox > 0 ? sessionInbox : roomPending;
  const hasMailPulse = Boolean(session?.activity.recentPulse || room?.hasRecentPulse || sessionPending > 0);
  const bothMinimized = !terminalOpen && !mailOpen;

  const portalStyle = portalOrigin
    ? ({
        '--sd-origin-left': `${Math.round(portalOrigin.left)}px`,
        '--sd-origin-top': `${Math.round(portalOrigin.top)}px`,
        '--sd-origin-width': `${Math.round(portalOrigin.width)}px`,
        '--sd-origin-height': `${Math.round(portalOrigin.height)}px`,
      } as React.CSSProperties)
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
        tabIndex={-1}
      >
        {/* OS Top Status Bar */}
        <header className="session-desktop-topbar">
          <div className="session-desktop-topbar-left">
            <button
              type="button"
              className="session-desktop-btn session-desktop-btn--back"
              onClick={onCloseToRoom}
              title="返回 3D 办公室 (Esc / Alt+Esc)"
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
              </div>
            ) : null}
          </div>

          <div className="session-desktop-topbar-center" role="group" aria-label="桌面窗口布局">
            <button
              type="button"
              className="session-desktop-layout-btn"
              data-active={layoutMode === 'terminal-focus' && terminalOpen ? 'true' : undefined}
              onClick={() => applyLayout('terminal-focus')}
            >
              <CodeOutlined />
              <span>终端窗口</span>
            </button>
            <button
              type="button"
              className="session-desktop-layout-btn"
              data-active={layoutMode === 'split' && terminalOpen && mailOpen ? 'true' : undefined}
              onClick={() => applyLayout('split')}
            >
              <SplitCellsOutlined />
              <span>分屏协同</span>
            </button>
            <button
              type="button"
              className="session-desktop-layout-btn"
              data-active={layoutMode === 'mail-focus' && mailOpen ? 'true' : undefined}
              onClick={() => applyLayout('mail-focus')}
            >
              <MailOutlined />
              <span>邮件客户端</span>
              {mailBadgeCount > 0 ? (
                <span className="session-desktop-inline-badge">{mailBadgeCount}</span>
              ) : null}
            </button>
          </div>

          <div className="session-desktop-topbar-right">
            <button
              type="button"
              className="session-desktop-btn"
              onClick={onRefreshAll}
              title="刷新目录与 Peer 邮件状态"
            >
              <ReloadOutlined />
              <span>刷新</span>
            </button>
            {session ? (
              <button
                type="button"
                className="session-desktop-btn"
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
                onClick={() => onHideSession(session.id)}
                title="仅从当前办公室视图隐藏此工位，后台进程继续运行"
              >
                <EyeInvisibleOutlined />
                <span>隐藏视图</span>
              </button>
            ) : null}
          </div>
        </header>

        {/* Desktop Stage: Wallpaper Apps + Active OS Windows */}
        <main className="session-desktop-stage">
          {/* Desktop Wallpaper Layer (always visible behind / when minimized) */}
          <section
            className="session-desktop-canvas"
            data-revealed={bothMinimized ? 'true' : undefined}
            aria-label="桌面图标与会话身份面板"
          >
            <div className="session-desktop-icons">
              <button
                type="button"
                className="session-desktop-app-icon"
                data-active={terminalOpen ? 'true' : undefined}
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
                data-active={mailOpen ? 'true' : undefined}
                data-pulse={hasMailPulse ? 'true' : undefined}
                onClick={handleRestoreMail}
              >
                <span className="session-desktop-app-glyph">
                  <MailOutlined />
                  {mailBadgeCount > 0 ? (
                    <span className="session-desktop-app-badge">{mailBadgeCount}</span>
                  ) : null}
                </span>
                <span className="session-desktop-app-title">Peer 邮箱</span>
                <span className="session-desktop-app-meta">
                  收件 {sessionInbox} · 待投 {sessionPending}
                  {roomPending > sessionPending ? ` · 房间待投 ${roomPending}` : ''}
                </span>
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
                <dl className="session-desktop-meta-grid">
                  <div className="session-desktop-meta-row">
                    <dt>SESSION KEY</dt>
                    <dd><code>{session.sessionKey}</code></dd>
                  </div>
                  <div className="session-desktop-meta-row">
                    <dt>NATIVE ID</dt>
                    <dd><code>{session.nativeSessionId || '未分配（Web / 无原生 ID）'}</code></dd>
                  </div>
                  <div className="session-desktop-meta-row">
                    <dt>WORKDIR</dt>
                    <dd><code>{session.cwd || '未指定目录'}</code></dd>
                  </div>
                  <div className="session-desktop-meta-row">
                    <dt>PROVIDER</dt>
                    <dd>
                      <span>
                        {session.provider || 'shell'} · {session.source}
                        {session.harness ? ` · ${session.harness}` : ''}
                        {session.model ? ` · ${session.model}` : ''}
                      </span>
                    </dd>
                  </div>
                  <div className="session-desktop-meta-row">
                    <dt>MAILBOX</dt>
                    <dd>
                      <span>
                        收件 {session.inboxCount} · 发件 {session.sentCount} · 待投 {session.pendingCount} · 跨项目 {session.crossProjectCount}
                      </span>
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="session-desktop-widget-empty">当前未选定会话，请从底部任务栏切换或返回办公室。</p>
              )}

              <div className="session-desktop-widget-actions">
                {session ? (
                  <button
                    type="button"
                    className="session-desktop-btn"
                    onClick={() => onCopyIdentity(session)}
                  >
                    <CopyOutlined />
                    <span>复制原标识</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="session-desktop-btn"
                  onClick={() => onOpenNewTerminal(session?.cwd || room?.projectPath)}
                >
                  <PlusOutlined />
                  <span>新建项目终端</span>
                </button>
              </div>
            </aside>
          </section>

          {/* OS Windows Layer */}
          <div
            className="session-desktop-windows"
            data-layout={layoutMode}
            data-terminal-open={terminalOpen ? 'true' : 'false'}
            data-mail-open={mailOpen ? 'true' : 'false'}
          >
            {/* Terminal OS Window: kept mounted while Desktop is open so minimizing or switching to Mail never kills PTY */}
            <section
              className={`session-desktop-window session-desktop-window--terminal${terminalOpen ? '' : ' session-desktop-window--docked'}`}
              aria-label={`会话终端 — ${sessionTitle}`}
              aria-hidden={!terminalOpen}
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
                    onClick={() => applyLayout('mail-focus')}
                    title="切换到 Peer 邮箱窗口"
                  >
                    <MailOutlined />
                  </button>
                  <button
                    type="button"
                    className="session-desktop-win-btn"
                    onClick={() => applyLayout(layoutMode === 'split' ? 'terminal-focus' : 'split')}
                    title={layoutMode === 'split' ? '独占终端窗口' : '分屏协同'}
                  >
                    {layoutMode === 'split' ? <CompressOutlined /> : <SplitCellsOutlined />}
                  </button>
                  <button
                    type="button"
                    className="session-desktop-win-btn"
                    onClick={handleMinimizeTerminal}
                    aria-label="最小化终端窗口"
                    title="最小化到任务栏（后台保持运行）"
                  >
                    <MinusOutlined />
                  </button>
                </div>
              </div>

              <div ref={terminalHostRef} className="session-desktop-terminal-host">
                {canAttach && session && session.tab ? (
                  <ShellTerminalPanel
                    key={`${serverId}:${session.tab.id}`}
                    visible={true}
                    persistent={true}
                    compactChrome={true}
                    allowNewTab={false}
                    layout="tabs"
                    title={sessionTitle}
                    cwd={session.cwd}
                    panelHeight={640}
                    sessionTabs={terminalSessionTabs}
                    activeTabId={session.tab.id}
                    minimized={!terminalOpen}
                    onMinimizedChange={handleShellMinimizedChange}
                    onClose={handleMinimizeTerminal}
                  />
                ) : (
                  <div className="session-desktop-terminal-fallback">
                    <div className="session-desktop-fallback-card">
                      <div className="session-desktop-fallback-head">
                        <span className={`session-desktop-status-pill session-desktop-status-pill--${availability.tone}`}>
                          <span className={`hud-led ${availability.ledClass}`} aria-hidden="true" />
                          <span>{availability.label}</span>
                        </span>
                        <h3>{availability.title}</h3>
                      </div>

                      <p className="session-desktop-fallback-desc">{availability.description}</p>

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
                            <dd><span>{session.provider || 'shell'} · {session.source}</span></dd>
                          </div>
                        </dl>
                      ) : null}

                      {session?.contentPreview ? (
                        <div className="session-desktop-preview-box">
                          <span className="session-desktop-preview-label">最近同步摘要（只读）</span>
                          <pre>{session.contentPreview}</pre>
                        </div>
                      ) : null}

                      <div className="session-desktop-fallback-actions">
                        {session ? (
                          <button
                            type="button"
                            className="session-desktop-btn"
                            onClick={() => onCopyIdentity(session)}
                          >
                            <CopyOutlined />
                            <span>复制原标识</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="session-desktop-btn"
                          onClick={onRefreshAll}
                        >
                          <ReloadOutlined />
                          <span>刷新核对</span>
                        </button>
                        <button
                          type="button"
                          className="session-desktop-btn session-desktop-btn--primary"
                          onClick={() => onOpenNewTerminal(session?.cwd || room?.projectPath)}
                        >
                          <PlusOutlined />
                          <span>新建项目终端</span>
                        </button>
                        <button
                          type="button"
                          className="session-desktop-btn"
                          onClick={handleRestoreMail}
                        >
                          <MailOutlined />
                          <span>查看 Peer 邮箱</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Mailbox OS Window: kept mounted while Desktop is open to preserve folder/search/selection */}
            <section
              className={`session-desktop-window session-desktop-window--mail${mailOpen ? '' : ' session-desktop-window--hidden'}`}
              aria-label="Peer 邮箱窗口"
              aria-hidden={!mailOpen}
            >
              <div className="session-desktop-window-bar">
                <div className="session-desktop-window-title">
                  <MailOutlined />
                  <span className="session-desktop-window-name">
                    Peer 邮箱 — {getMailboxScopeTitle(mailboxScope, room, session)}
                  </span>
                  {peerCounts.pending > 0 ? (
                    <span className="session-desktop-inline-badge">待投 {peerCounts.pending}</span>
                  ) : null}
                </div>
                <div className="session-desktop-window-controls">
                  <button
                    type="button"
                    className="session-desktop-win-btn"
                    onClick={() => applyLayout('terminal-focus')}
                    title="切换到会话终端"
                  >
                    <CodeOutlined />
                  </button>
                  <button
                    type="button"
                    className="session-desktop-win-btn"
                    onClick={() => applyLayout(layoutMode === 'split' ? 'mail-focus' : 'split')}
                    title={layoutMode === 'split' ? '独占邮箱窗口' : '分屏协同'}
                  >
                    {layoutMode === 'split' ? <CompressOutlined /> : <SplitCellsOutlined />}
                  </button>
                  <button
                    type="button"
                    className="session-desktop-win-btn"
                    onClick={handleMinimizeMail}
                    aria-label="最小化邮箱窗口"
                    title="最小化到任务栏"
                  >
                    <MinusOutlined />
                  </button>
                </div>
              </div>

              <div className="session-desktop-mail-host">
                <OfficeMailbox
                  scope={mailboxScope}
                  onScopeChange={setMailboxScope}
                  focusedSession={session}
                  activeRoom={room}
                  allRooms={allRooms}
                  allMessages={allMessages}
                  unassignedMessages={unassignedMessages}
                  fullyUnassignedCount={fullyUnassignedCount}
                  counts={peerCounts}
                  loading={peerLoading}
                  error={peerError}
                  onRefresh={onRefreshAll}
                  onJumpToSession={handleJumpToSessionFromMail}
                  compactHeader={true}
                />
              </div>
            </section>
          </div>
        </main>

        {/* Bottom Desktop Dock / Taskbar */}
        <footer className="session-desktop-dock" aria-label="桌面任务栏">
          <div className="session-desktop-dock-apps">
            <button
              type="button"
              className="session-desktop-dock-pill"
              data-active={terminalOpen ? 'true' : undefined}
              data-minimized={!terminalOpen ? 'true' : undefined}
              onClick={handleToggleTerminalDock}
              title={terminalOpen ? '最小化终端窗口（后台保持运行）' : '恢复终端窗口'}
            >
              <CodeOutlined />
              <span className={`hud-led ${availability.ledClass}`} aria-hidden="true" />
              <span>会话终端</span>
            </button>

            <button
              type="button"
              className="session-desktop-dock-pill"
              data-active={mailOpen ? 'true' : undefined}
              data-minimized={!mailOpen ? 'true' : undefined}
              data-pulse={hasMailPulse ? 'true' : undefined}
              onClick={handleToggleMailDock}
              title={mailOpen ? '最小化邮箱窗口' : '打开 Peer 邮箱'}
            >
              <MailOutlined />
              <span>Peer 邮箱</span>
              {mailBadgeCount > 0 ? (
                <span className="session-desktop-inline-badge">{mailBadgeCount}</span>
              ) : null}
            </button>
          </div>

          <div className="session-desktop-dock-divider" aria-hidden="true" />

          <nav className="session-desktop-dock-coworkers" aria-label="同房间工位切换">
            {coworkers.map((coworker) => {
              const isCurrent = coworker.id === session?.id;
              const coworkerMeta = getAvailabilityMeta(coworker.availability);
              const coworkerMailCount = coworker.pendingCount > 0 ? coworker.pendingCount : coworker.inboxCount;
              return (
                <button
                  key={coworker.id}
                  type="button"
                  className="session-desktop-coworker-pill"
                  data-active={isCurrent ? 'true' : undefined}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => onSelectRoomSession(coworker)}
                  title={`${coworker.label} · ${coworkerMeta.label}`}
                >
                  {coworker.canAttachTerminal ? <CodeOutlined /> : <UserOutlined />}
                  <span className={`hud-led ${coworkerMeta.ledClass}`} aria-hidden="true" />
                  <span className="session-desktop-coworker-code">{coworker.persona.badgeCode}</span>
                  <span className="session-desktop-coworker-name">{coworker.shortLabel || coworker.label}</span>
                  {coworkerMailCount > 0 ? (
                    <span className="session-desktop-inline-badge">{coworkerMailCount}</span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          <button
            type="button"
            className="session-desktop-btn session-desktop-dock-return"
            onClick={onCloseToRoom}
            title="返回 3D 项目办公室"
          >
            <ArrowLeftOutlined />
            <span>返回房间</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

export default SessionDesktop;
