import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ConfigProvider, Spin } from 'antd';
import type { ThemeConfig } from 'antd';
import { useLocation } from '@umijs/max';
import {
  CloseOutlined,
  DisconnectOutlined,
  ExclamationCircleOutlined,
  PushpinFilled,
  PushpinOutlined,
  ReloadOutlined,
  StopOutlined,
  UserOutlined,
} from '@ant-design/icons';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import type { ChatAccount, Provider, Session } from '@/types';
import { sessionsAPI } from '@/services/api';
import { readPersistedSelection } from '@/pages/chat-selection-state.js';
import {
  CHAT_MINI_WINDOW_OPEN_EVENT,
  CHAT_MINI_WINDOW_REFERENCE_EVENT,
  resolveChatGlobalShortcut,
} from '@/components/chat/chat-global-shortcuts';
import { chatAccountIdentity } from '@/components/chat/aih-server-account';
import { useChatAccountCatalog } from '@/features/chat-workspace/use-chat-account-catalog';
import {
  resolveChatAccountChange,
  resolveSessionRuntimeTarget,
  runtimeAccountsForSession,
} from './session-surface-policy';
import { useSessionRuntime } from './use-session-runtime';
import Reveal from '@/components/ui/Reveal';
import { useCollapsePresence } from '@/hooks/use-collapse-presence';
import { useSwitchFade } from '@/hooks/use-switch-fade';
import { prefersReducedMotion } from '@/services/view-transition';
import SessionWorkspace from './SessionWorkspace';
import { useSessionSelector } from '@/chat-runtime';
import type { SessionProjection } from '@/chat-runtime';
import { SessionRuntimeActions } from './session-runtime-actions';
import styles from './chat-mini-window.module.css';

const MINI_SESSION_TITLE = '快速对话';
const MINI_WINDOW_EXIT_MS = 160;

/**
 * 窗口本身是 z-index: 1200（chat-mini-window.module.css），而 antd 弹层按
 * zIndexPopupBase=1000 派生（Popover 1030、Modal/Drawer 1000）。两者一比，
 * 从窗口内部打开的账号 / 模型菜单会渲染到窗口底下，看起来就是「账号模型的选择
 * 被 chat 面板挡住」（2026-11-02 真机反馈）。
 *
 * 只把这一子树里的弹层基线上移到窗口之上（1300 → Popover 1330、Modal 1300），
 * 页面其它位置的弹层仍用默认基线：浮动窗口不该被页面弹层盖住，但它自己的弹层
 * 必须永远压在自己上面。
 */
const MINI_WINDOW_THEME: ThemeConfig = { token: { zIndexPopupBase: 1300 } };

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
  const bodyRef = useRef<HTMLDivElement>(null);

  const accounts = props.accounts || accountCatalog.accounts;
  const selectedAccount = props.account || accountOverride
    || resolveAccount(session, accounts, accountCatalog.selectedAccount);

  const handleAccountChange = useCallback((account: ChatAccount): void => {
    setAccountOverride(account);
    setSession((current) => {
      if (!current) return current;
      const action = resolveChatAccountChange({
        projectPath: current.projectPath,
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
          setSession(match);
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
    // 引用即打开：附件由窗口内的 Composer 接收（它挂载后会补收打开前到达的引用）。
    window.addEventListener(CHAT_MINI_WINDOW_REFERENCE_EVENT, openWindow);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener(CHAT_MINI_WINDOW_OPEN_EVENT, openWindow);
      window.removeEventListener(CHAT_MINI_WINDOW_REFERENCE_EVENT, openWindow);
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
    if (typeof document !== 'undefined' && panelRef.current?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
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

  // 关闭时留 160ms 播退场再卸载：快速窗口用连续 CSS transition 驱动开合，
  // 关闭中途重开可直接从当前帧平滑反转，且退场期间 inert 禁焦不遗留离屏可聚焦控件。
  const reducedMotion = prefersReducedMotion();
  const presence = useCollapsePresence(open, reducedMotion ? 0 : MINI_WINDOW_EXIT_MS);
  const windowExpanded = open && (reducedMotion || presence.expanded);
  const persistedSessionOwnsCanonicalRoute = isChatPagePath(location.pathname)
    && persistedSessionRef.current;
  const miniBodyPhaseKey = loadingSession
    ? 'loading'
    : !session
      ? 'empty'
      : persistedSessionOwnsCanonicalRoute
        ? 'handoff'
        : `ready:${session.id}`;
  useSwitchFade(bodyRef, open ? miniBodyPhaseKey : null, { scope: 'chat-mini-window-body', duration: 150, from: 0.45 });
  if (!presence.present || typeof document === 'undefined') return null;
  const style: CSSProperties | undefined = position
    ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto' }
    : undefined;
  return createPortal(
    <ConfigProvider theme={MINI_WINDOW_THEME}>
      <section
        ref={panelRef}
        className={`${styles.window} ${pinned ? styles.pinned : ''} ${windowExpanded ? '' : styles.windowClosed} ${open ? '' : styles.windowClosing}`}
        data-open={open ? 'true' : 'false'}
        style={style}
        aria-label="AIH Chat 快速窗口"
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
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
            <strong>{session?.title || MINI_SESSION_TITLE}</strong>
            {pinned ? <span className={styles.pinHint}>已固定</span> : null}
          </div>
          <div className={styles.headerActions} data-panel-actions="true">
            <button
              type="button"
              onClick={togglePin}
              aria-label={pinned ? '取消固定窗口' : '固定窗口'}
              aria-pressed={pinned}
              title={pinned ? '取消固定' : '固定窗口'}
            >
              {pinned ? <PushpinFilled /> : <PushpinOutlined />}
            </button>
            <button type="button" onClick={close} aria-label="关闭窗口" title="关闭"><CloseOutlined /></button>
          </div>
        </header>
        <div ref={bodyRef} className={styles.body}>
          <Reveal open={Boolean(sessionError)}>
            <div className={styles.inlineError} role="alert">
              <span className={styles.inlineErrorText}>
                <ExclamationCircleOutlined aria-hidden="true" />
                <span>{sessionError}</span>
              </span>
              <button type="button" onClick={() => void loadSession()}><ReloadOutlined /> 重试</button>
            </div>
          </Reveal>
          {loadingSession ? (
            <MiniStatusView kind="loading" title="正在读取最近会话" description="加载完成后即可继续对话。" />
          ) : null}
          {!loadingSession && !session ? (
            <MiniStatusView
              kind={accounts.length ? 'loading' : 'empty'}
              title={accounts.length ? '正在准备对话环境' : '暂无可用账号'}
              description={accounts.length ? '即将就绪，请稍候。' : '请先在账号管理中配置可用凭据后再开始对话。'}
            />
          ) : null}
          {persistedSessionOwnsCanonicalRoute ? (
            <MiniStatusView kind="loading" title="正在切换为独立会话" description="避免与当前会话页冲突。" />
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
      </section>
    </ConfigProvider>,
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
    session, account, approvalMode,
  }), [account, approvalMode, session]);
  const connection = useSessionRuntime(
    resolution,
    `${session.id}:${chatAccountIdentity(account)}:${reconnectAttempt}`,
    onSessionResolved,
  );

  if (connection.phase === 'blocked') {
    return (
      <MiniStatusView
        kind="empty"
        title="当前对话目标未就绪"
        description="请检查所选账号凭据是否有效。"
      />
    );
  }
  if (connection.phase === 'error') {
    return (
      <MiniStatusView
        kind="error"
        title="连接失败"
        description={connection.failure.message || '暂时无法连接到对话运行时。'}
        actionLabel="重试连接"
        onAction={connection.retry}
      />
    );
  }
  if (connection.phase !== 'ready') {
    return <MiniStatusView kind="loading" title="正在连接运行时" description="连接完成后即可输入消息。" />;
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
  const stateText = MINI_STATE_LABELS[projection.state] || projection.state;
  const statusTag = projection.connectionState !== 'connected'
    ? <SettingStatusTag status="saving" label="正在重连" compact />
    : <SettingStatusTag status={canStop ? 'saving' : 'applied'} label={`已连接 · ${stateText}`} compact />;

  return (
    <>
      <div className={styles.runtimeToolbar}>
        <div className={styles.runtimeState} data-state={projection.state}>
          {statusTag}
        </div>
        <div className={styles.runtimeActions}>
          <button type="button" onClick={onReconnect} aria-label="重新连接运行时"><DisconnectOutlined /> 重连</button>
          <button type="button" onClick={() => void stop()} disabled={!canStop} aria-label="停止当前生成"><StopOutlined /> 停止</button>
        </div>
      </div>
      {actionError ? (
        <div className={styles.inlineError} role="alert">
          <span className={styles.inlineErrorText}>
            <ExclamationCircleOutlined aria-hidden="true" />
            <span>{actionError}</span>
          </span>
        </div>
      ) : null}
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
        // The mini window is always a chat-mode session; project refresh only runs in work mode.
        onProjectsRefresh={() => Promise.resolve()}
        acceptsReferences
      />
    </>
  );
}

function MiniStatusView({
  kind,
  title,
  description,
  actionLabel,
  onAction,
}: {
  readonly kind: 'loading' | 'empty' | 'error';
  readonly title: string;
  readonly description: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <div
      className={styles.statusCard}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
    >
      <div className={styles.statusHead}>
        {kind === 'loading' ? <Spin size="small" /> : null}
        {kind === 'empty' ? <UserOutlined aria-hidden="true" /> : null}
        {kind === 'error' ? <ExclamationCircleOutlined aria-hidden="true" className={styles.statusErrorIcon} /> : null}
        <strong>{title}</strong>
      </div>
      <p className={styles.statusDesc}>{description}</p>
      {actionLabel && onAction ? (
        <button type="button" className={styles.statusAction} onClick={onAction}>
          <ReloadOutlined aria-hidden="true" />
          <span>{actionLabel}</span>
        </button>
      ) : null}
    </div>
  );
}

const MINI_STATE_LABELS: Readonly<Record<SessionProjection['state'], string>> = {
  idle: '就绪',
  starting: '启动中',
  running: '生成中',
  waiting_input: '等待确认',
  interrupting: '停止中',
  completing: '收尾中',
  recovering: '恢复中',
  closed: '已关闭',
};

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
    draft: true,
    ...(chatAccountIdentity(account) ? { accountRef: chatAccountIdentity(account) } : {}),
  };
}

function fallbackTarget(session: Session, account: ChatAccount) {
  return {
    provider: session.provider,
    executionAccountRef: chatAccountIdentity(account),
    projectPath: '',
    policy: { approvalMode: 'confirm' as const },
  };
}

function isChatPagePath(pathname: string): boolean {
  // /chat/quick（快捷唤起）本身就是完整会话页：同样视为 Chat 页，不再叠一个浮动小窗。
  return /(?:^|\/)chat(?:\/quick)?\/?$/.test(pathname);
}

function clampPosition(left: number, top: number, panel: HTMLDivElement | null): Position {
  const rect = panel?.getBoundingClientRect();
  return {
    left: Math.max(8, Math.min(left, window.innerWidth - (rect?.width || 440) - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - (rect?.height || 520) - 8)),
  };
}
