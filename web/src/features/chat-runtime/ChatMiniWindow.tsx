import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from '@umijs/max';
import {
  CloseOutlined,
  DisconnectOutlined,
  PushpinFilled,
  PushpinOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { ChatAccount, Provider, Session } from '@/types';
import { sessionsAPI } from '@/services/api';
import { readPersistedSelection } from '@/pages/chat-selection-state.js';
import {
  CHAT_MINI_WINDOW_OPEN_EVENT,
  resolveChatGlobalShortcut,
} from '@/components/chat/chat-global-shortcuts';
import { chatAccountIdentity } from '@/components/chat/aih-server-account';
import { useChatAccountCatalog } from '@/features/legacy-chat/use-chat-account-catalog';
import {
  resolveChatAccountChange,
  resolveSessionRuntimeTarget,
  runtimeAccountsForSession,
} from './session-surface-policy';
import { useSessionRuntime } from './use-session-runtime';
import { useCollapsePresence } from '@/hooks/use-collapse-presence';
import SessionWorkspace from './SessionWorkspace';
import { useSessionSelector } from '@/chat-runtime';
import type { SessionProjection } from '@/chat-runtime';
import { SessionRuntimeActions } from './session-runtime-actions';
import styles from './chat-mini-window.module.css';

const MINI_SESSION_TITLE = '快速 Chat';

type Position = { left: number; top: number };

interface ChatMiniWindowProps {
  /** Optional embedding hook for a host that already owns the selected chat session. */
  readonly session?: Session | null;
  readonly account?: ChatAccount | null;
  readonly accounts?: readonly ChatAccount[];
}

/**
 * Cross-route Chat surface. The runtime is opened only after the window is
 * requested, so pages that never use Chat pay no SSE/controller cost.
 */
export default function ChatMiniWindow(props: ChatMiniWindowProps = {}) {
  const location = useLocation();
  const initialSelection = useMemo(() => readPersistedSelection(), []);
  const accountCatalog = useChatAccountCatalog(
    initialSelection.provider as Provider | undefined,
    props.session?.accountRef,
  );
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(props.session || null);
  const [accountOverride, setAccountOverride] = useState<ChatAccount | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [pinned, setPinned] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const persistedSessionRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>();
  const panelRef = useRef<HTMLDivElement>(null);

  const accounts = props.accounts || accountCatalog.accounts;
  const selectedAccount = props.account || accountOverride
    || resolveAccount(session, accounts, accountCatalog.selectedAccount);

  const handleAccountChange = useCallback((account: ChatAccount): void => {
    setAccountOverride(account);
    setSession((current) => {
      if (!current) return current;
      const action = resolveChatAccountChange({
        mode: 'chat',
        provider: current.provider,
        accountRef: current.accountRef,
        draft: current.draft,
        runtimeSessionId: current.runtimeSessionId,
        account,
      });
      if (action === 'ignore') return current;
      if (action === 'retarget') {
        // Keep the canonical chatSessionId so the new controller rehydrates
        // the same timeline under the new execution account.
        return {
          ...current,
          accountRef: chatAccountIdentity(account),
          updatedAt: Date.now(),
        };
      }
      return {
        ...current,
        id: `mini-draft-${Date.now()}`,
        title: MINI_SESSION_TITLE,
        updatedAt: Date.now(),
        provider: account.provider,
        accountRef: chatAccountIdentity(account),
        runtimeSessionId: undefined,
        draft: true,
      };
    });
  }, []);

  const loadSession = useCallback(async (): Promise<void> => {
    if (props.session) {
      setSession(props.session);
      setSessionError('');
      return;
    }
    // Read at open time so a Chat page selection changed after app-shell mount
    // is never mistaken for the current mini-window target.
    const selection = readPersistedSelection();
    if (selection.sessionId && !selection.projectPath && !isChatPagePath(location.pathname)) {
      setLoadingSession(true);
      setSessionError('');
      try {
        const sessions = await sessionsAPI.getChatSessions();
        const match = sessions.find((candidate) => candidate.id === selection.sessionId
          && (!selection.provider || candidate.provider === selection.provider));
        if (match) {
          if (isChatPagePath(typeof window === 'undefined' ? location.pathname : window.location.pathname)) {
            const account = selectedAccount || accounts[0];
            if (account) setSession(createDraftSession(account));
            setSessionError('');
            return;
          }
          persistedSessionRef.current = true;
          setSession({ ...match, mode: 'chat' });
          setSessionError('');
          return;
        }
      } catch (error) {
        setSessionError(error instanceof Error ? error.message : '读取会话失败');
        return;
      } finally {
        setLoadingSession(false);
      }
      setSessionError('');
    }
    const account = selectedAccount || accounts[0];
    if (account) {
      setSession(createDraftSession(account));
      setSessionError('');
    }
  }, [accounts, location.pathname, props.session, selectedAccount]);

  useEffect(() => {
    const openWindow = () => {
      setOpen(true);
      void loadSession();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (resolveChatGlobalShortcut(event) !== 'chat-mini-window') return;
      event.preventDefault();
      openWindow();
    };
    window.addEventListener(CHAT_MINI_WINDOW_OPEN_EVENT, openWindow);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener(CHAT_MINI_WINDOW_OPEN_EVENT, openWindow);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [loadSession]);

  useEffect(() => {
    if (open && !session && !loadingSession && !sessionError && accounts.length > 0) {
      void loadSession();
    }
  }, [accounts.length, loadSession, loadingSession, open, session, sessionError]);

  useEffect(() => {
    // A persisted session may be opened from another route and then carried
    // into /ui/chat. Replace it with a separate draft before the canonical
    // Chat page can attach to the same runtime session.
    if (!open || !isChatPagePath(location.pathname) || !persistedSessionRef.current || !selectedAccount) return;
    persistedSessionRef.current = false;
    setSession(createDraftSession(selectedAccount));
  }, [location.pathname, open, selectedAccount]);

  const close = useCallback(() => {
    setOpen(false);
    dragRef.current = undefined;
  }, []);
  const togglePin = useCallback(() => {
    setPinned((current) => {
      const next = !current;
      if (next) {
        const rect = panelRef.current?.getBoundingClientRect();
        if (rect) setPosition(clampPosition(rect.left, 12, panelRef.current));
      } else {
        setPosition(null);
      }
      return next;
    });
  }, []);
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top,
    };
  }, []);
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition(clampPosition(
      drag.left + event.clientX - drag.x,
      drag.top + event.clientY - drag.y,
      panelRef.current,
    ));
  }, []);
  const endDrag = useCallback(() => { dragRef.current = undefined; }, []);

  // 关闭时留 160ms 播退场再卸载：快速窗口打开从右下角微抬进入，关闭缩回原处，
  // 不再是一下子凭空出现/消失。
  const presence = useCollapsePresence(open, 160);
  if (!presence.present || typeof document === 'undefined') return null;
  const persistedSessionOwnsCanonicalRoute = isChatPagePath(location.pathname)
    && persistedSessionRef.current;
  const style: CSSProperties | undefined = position
    ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto' }
    : undefined;
  return createPortal(
    <section
      ref={panelRef}
      className={`${styles.window} ${pinned ? styles.pinned : ''} ${open ? '' : styles.windowLeaving}`}
      style={style}
      aria-label="AIH Chat 快速窗口"
    >
      <header
        className={styles.header}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div className={styles.titleGroup}>
          <span className={styles.led} aria-hidden="true" />
          <strong>CHAT / QUICK</strong>
          {session ? <span className={styles.sessionTitle}>{session.title || MINI_SESSION_TITLE}</span> : null}
        </div>
        <div className={styles.headerActions} data-panel-actions="true">
          <button type="button" onClick={togglePin} aria-label={pinned ? '取消固定 Chat 窗口' : '固定 Chat 窗口'}>
            {pinned ? <PushpinFilled /> : <PushpinOutlined />}
          </button>
          <button type="button" onClick={close} aria-label="关闭 Chat 窗口"><CloseOutlined /></button>
        </div>
      </header>
      <div className={styles.body}>
        {sessionError ? (
          <div className={styles.inlineError} role="alert">
            <span>{sessionError}</span>
            <button type="button" onClick={() => void loadSession()}><ReloadOutlined /> 重试</button>
          </div>
        ) : null}
        {loadingSession ? <div className={styles.status} role="status">正在读取最近 Chat 会话…</div> : null}
        {!loadingSession && !session ? (
          <div className={styles.status} role="status">
            {accounts.length ? '正在准备 Chat Runtime…' : '暂无可用账号，请先配置 Chat 账号'}
          </div>
        ) : null}
        {persistedSessionOwnsCanonicalRoute ? (
          <div className={styles.status} role="status">正在切换到独立 Chat 窗口…</div>
        ) : null}
        {session && selectedAccount && !persistedSessionOwnsCanonicalRoute ? (
          <MiniRuntime
            key={`${session.id}:${chatAccountIdentity(selectedAccount)}`}
            session={session}
            account={selectedAccount}
            accounts={runtimeAccountsForSession(session, accounts)}
            onAccountChange={handleAccountChange}
            onSessionResolved={(runtimeSession) => {
              setSession((current) => current ? {
                ...current,
                runtimeSessionId: runtimeSession.sessionId,
                accountRef: runtimeSession.executionAccountRef,
                draft: false,
              } : current);
            }}
          />
        ) : null}
      </div>
    </section>,
    document.body,
  );
}

function MiniRuntime({
  session,
  account,
  accounts,
  onAccountChange,
  onSessionResolved,
}: {
  session: Session;
  account: ChatAccount;
  accounts: readonly ChatAccount[];
  onAccountChange: (account: ChatAccount) => void;
  onSessionResolved: (session: import('@/chat-runtime').ChatRuntimeSession) => void;
}) {
  const [model, setModel] = useState(session.model || '');
  const [approvalMode, setApprovalMode] = useState<'bypass' | 'confirm' | 'plan'>('confirm');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const resolution = useMemo(() => resolveSessionRuntimeTarget({
    session: { ...session, mode: 'chat' }, account, approvalMode,
  }), [account, approvalMode, session]);
  const connection = useSessionRuntime(
    resolution,
    `${session.id}:${chatAccountIdentity(account)}:${reconnectAttempt}`,
    onSessionResolved,
  );

  if (connection.phase === 'blocked') {
    return <div className={styles.status} role="status">当前 Chat 目标尚未准备好。</div>;
  }
  if (connection.phase === 'error') {
    return (
      <div className={styles.inlineError} role="alert">
        <span>{connection.failure.message || 'Chat Runtime 连接失败'}</span>
        <button type="button" onClick={connection.retry}><ReloadOutlined /> 重连</button>
      </div>
    );
  }
  if (connection.phase !== 'ready') {
    return <div className={styles.status} role="status">正在连接 Chat Runtime…</div>;
  }
  return (
    <MiniRuntimeReady
      controller={connection.controller}
      resolution={resolution}
      session={session}
      account={account}
      accounts={accounts}
      onAccountChange={onAccountChange}
      model={model}
      approvalMode={approvalMode}
      setModel={setModel}
      setApprovalMode={setApprovalMode}
      onReconnect={() => setReconnectAttempt((current) => current + 1)}
    />
  );
}

function MiniRuntimeReady({
  controller,
  resolution,
  session,
  account,
  accounts,
  onAccountChange,
  model,
  approvalMode,
  setModel,
  setApprovalMode,
  onReconnect,
}: {
  controller: import('@/chat-runtime').SessionRuntimeController;
  resolution: ReturnType<typeof resolveSessionRuntimeTarget>;
  session: Session;
  account: ChatAccount;
  accounts: readonly ChatAccount[];
  onAccountChange: (account: ChatAccount) => void;
  model: string;
  approvalMode: 'bypass' | 'confirm' | 'plan';
  setModel: (model: string) => void;
  setApprovalMode: (mode: 'bypass' | 'confirm' | 'plan') => void;
  onReconnect: () => void;
}) {
  const projection = useSessionSelector(controller.store, selectMiniProjection);
  const actions = useMemo(() => new SessionRuntimeActions(controller), [controller]);
  const [actionError, setActionError] = useState('');
  const stop = useCallback(async () => {
    setActionError('');
    try { await actions.interrupt(); }
    catch (error) { setActionError(error instanceof Error ? error.message : '停止失败'); }
  }, [actions]);
  const canStop = projection.state === 'running' || projection.state === 'starting'
    || projection.state === 'waiting_input' || projection.state === 'completing';
  const target = resolution.status === 'ready' ? resolution.target : fallbackTarget(session, account);
  return (
    <>
      <div className={styles.runtimeToolbar}>
        <span className={styles.runtimeState} data-state={projection.state}>
          {projection.connectionState === 'connected' ? '已连接' : '正在重连'} · {projection.state}
        </span>
        <div className={styles.runtimeActions}>
          <button type="button" onClick={onReconnect} aria-label="重连 Chat Runtime"><DisconnectOutlined /> 重连</button>
          <button type="button" onClick={() => void stop()} disabled={!canStop} aria-label="停止 Chat Runtime"><StopOutlined /> 停止</button>
        </div>
      </div>
      {actionError ? <div className={styles.inlineError} role="alert">{actionError}</div> : null}
      <SessionWorkspace
        controller={controller}
        runtimeTarget={target}
        title={session.title || MINI_SESSION_TITLE}
        accounts={accounts}
        accountRef={chatAccountIdentity(account)}
        selectedModel={model}
        approvalMode={approvalMode}
        onAccountChange={onAccountChange}
        onModelChange={setModel}
        onApprovalModeChange={setApprovalMode}
        onFreshNativeSessionBound={() => {}}
        onBranchSession={() => {}}
      />
    </>
  );
}

function selectMiniProjection(projection: SessionProjection) {
  return {
    state: projection.state,
    connectionState: projection.connectionState,
  };
}

function resolveAccount(
  session: Session | null,
  accounts: readonly ChatAccount[],
  fallback: ChatAccount | null,
): ChatAccount | null {
  if (session?.accountRef) {
    const exact = accounts.find((candidate) => chatAccountIdentity(candidate) === session.accountRef);
    if (exact) return exact;
  }
  if (session?.provider) {
    const sameProvider = accounts.find((candidate) => candidate.provider === session.provider);
    if (sameProvider) return sameProvider;
  }
  return fallback || accounts[0] || null;
}

function createDraftSession(account: ChatAccount): Session {
  return {
    id: `mini-draft-${Date.now()}`,
    title: MINI_SESSION_TITLE,
    updatedAt: Date.now(),
    provider: account.provider,
    mode: 'chat',
    draft: true,
    ...(chatAccountIdentity(account) ? { accountRef: chatAccountIdentity(account) } : {}),
  };
}

function fallbackTarget(session: Session, account: ChatAccount) {
  return {
    provider: session.provider,
    executionAccountRef: chatAccountIdentity(account),
    projectPath: '',
    policy: { workspaceMode: 'chat' as const, approvalMode: 'confirm' as const },
  };
}

function isChatPagePath(pathname: string): boolean {
  return /(?:^|\/)chat\/?$/.test(pathname);
}

function clampPosition(left: number, top: number, panel: HTMLDivElement | null): Position {
  const rect = panel?.getBoundingClientRect();
  return {
    left: Math.max(8, Math.min(left, window.innerWidth - (rect?.width || 440) - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - (rect?.height || 520) - 8)),
  };
}
