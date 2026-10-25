import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
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
  resolveSessionRuntimeTarget,
  runtimeAccountsForSession,
} from './session-surface-policy';
import { useSessionRuntime } from './use-session-runtime';
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
  const initialSelection = useMemo(() => readPersistedSelection(), []);
  const accountCatalog = useChatAccountCatalog(
    initialSelection.provider as Provider | undefined,
    props.session?.accountRef,
  );
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(props.session || null);
  const [position, setPosition] = useState<Position | null>(null);
  const [pinned, setPinned] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>();
  const panelRef = useRef<HTMLDivElement>(null);

  const accounts = props.accounts || accountCatalog.accounts;
  const selectedAccount = props.account || resolveAccount(session, accounts, accountCatalog.selectedAccount);

  const loadSession = useCallback(async (): Promise<void> => {
    if (props.session) {
      setSession(props.session);
      return;
    }
    const selection = initialSelection;
    if (selection.sessionId && !selection.projectPath) {
      setLoadingSession(true);
      setSessionError('');
      try {
        const sessions = await sessionsAPI.getChatSessions();
        const match = sessions.find((candidate) => candidate.id === selection.sessionId
          && (!selection.provider || candidate.provider === selection.provider));
        if (match) {
          setSession({ ...match, mode: 'chat' });
          return;
        }
      } catch (error) {
        setSessionError(error instanceof Error ? error.message : '读取会话失败');
      } finally {
        setLoadingSession(false);
      }
    }
    const account = selectedAccount || accounts[0];
    if (account) {
      setSession(createDraftSession(account));
      setSessionError('');
    }
  }, [accounts, initialSelection, props.session, selectedAccount]);

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
    if (open && !session && !loadingSession) void loadSession();
  }, [loadSession, loadingSession, open, session]);

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

  if (!open || typeof document === 'undefined') return null;
  const style: CSSProperties | undefined = position
    ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto' }
    : undefined;
  return createPortal(
    <section
      ref={panelRef}
      className={`${styles.window} ${pinned ? styles.pinned : ''}`}
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
        {session && selectedAccount ? (
          <MiniRuntime
            key={`${session.id}:${chatAccountIdentity(selectedAccount)}`}
            session={session}
            account={selectedAccount}
            accounts={runtimeAccountsForSession(session, accounts)}
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
  onSessionResolved,
}: {
  session: Session;
  account: ChatAccount;
  accounts: readonly ChatAccount[];
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
        onAccountChange={() => {}}
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

function clampPosition(left: number, top: number, panel: HTMLDivElement | null): Position {
  const rect = panel?.getBoundingClientRect();
  return {
    left: Math.max(8, Math.min(left, window.innerWidth - (rect?.width || 440) - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - (rect?.height || 520) - 8)),
  };
}
