import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Input, Modal } from 'antd';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CloseCircleOutlined,
  DesktopOutlined,
  FormOutlined,
  GlobalOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import AppButton from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import { resolveActiveTransportTarget, subscribeTransportTargetChange } from '@/services/webui-auth-transport';
import { connectBrowserSurface, readBrowserCapabilities, type BrowserCapabilities, type BrowserSurfaceEvent, type BrowserSurfaceScope } from './browser-view-client';
import BrowserTextComposer from './BrowserTextComposer';
import { useBrowserViewInput } from './browser-view-input';
import { browserViewErrorMessage } from './browser-view-errors';
import styles from './browser-view.module.css';

const defaultUrl = 'https://www.google.com';
const frameExpiry = 2500;
const staleFrameMessage = browserViewErrorMessage('browser_frame_stale');
type Connection = ReturnType<typeof connectBrowserSurface>;
type Target = ReturnType<typeof resolveActiveTransportTarget>;
type Phase = 'disconnected' | 'connecting' | 'starting' | 'ready' | 'failed';
type CapabilitySnapshot = { target: Target; value: BrowserCapabilities };
type PendingFrame = { event: BrowserSurfaceEvent; receivedAt: number };

const PHASE_LABELS: Record<Phase, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  starting: '启动中',
  ready: '已连接',
  failed: '连接失败',
};

const PHASE_TAG_STATUS: Record<Phase, SettingStatusState> = {
  disconnected: 'unset',
  connecting: 'saving',
  starting: 'saving',
  ready: 'applied',
  failed: 'error',
};

export interface BrowserViewProps {
  /** Bind the viewer to its owner; an empty or different Server fails closed. */
  requiredServerId?: string;
  embedded?: boolean;
  /** Hidden desktop windows retain their connection, but cannot send input. */
  active?: boolean;
  /** Optional server-validated account scope; absent keeps the studio task scope. */
  scope?: BrowserSurfaceScope;
  initialUrl?: string;
}

function targetMatches(target: Target, requiredServerId?: string) {
  const current = resolveActiveTransportTarget();
  const serverMatches = requiredServerId === undefined
    || (requiredServerId.length > 0 && requiredServerId === (current.serverId || 'local'));
  return serverMatches && current.scopeKey === target.scopeKey && current.serverId === target.serverId
    && current.isRemote === target.isRemote && current.targetOrigin === target.targetOrigin;
}

function hostLabel(capabilities: BrowserCapabilities | null) {
  if (!capabilities) return '系统待检测';
  const names: Record<string, string> = { darwin: 'macOS', windows: 'Windows', linux: 'Linux' };
  const os = capabilities.hostOS ? names[capabilities.hostOS] || capabilities.hostOS : '未知系统';
  return [os, capabilities.hostArch].filter(Boolean).join(' / ');
}

function scopeSummary(scope?: BrowserSurfaceScope): { label: string; note: string } {
  if (scope?.scope === 'account') {
    const detail = [scope.provider, scope.accountRef].filter(Boolean).join(' · ');
    return {
      label: detail ? `账号资料 · ${detail}` : '账号资料',
      note: '账号资料由执行 Server 持久保存，关闭窗口不会清除登录态。',
    };
  }
  if (scope?.scope === 'job') {
    return {
      label: '授权资料',
      note: '授权资料按本次登录任务隔离，完成后归属新建账号。',
    };
  }
  return {
    label: '任务资料',
    note: '使用独立任务资料，不读取日常浏览器数据，也不会回退到本机。',
  };
}

interface BrowserToolbarProps {
  url: string;
  interactive: boolean;
  textEnabled: boolean;
  idle: boolean;
  canStart: boolean;
  composerOpen: boolean;
  onUrlChange: (next: string) => void;
  onNavigate: () => void;
  onKeyCommand: (key: 'back' | 'forward' | 'reload') => void;
  onToggleComposer: () => void;
  onStart: () => void;
  onStop: () => void;
}

function BrowserToolbar({
  url,
  interactive,
  textEnabled,
  idle,
  canStart,
  composerOpen,
  onUrlChange,
  onNavigate,
  onKeyCommand,
  onToggleComposer,
  onStart,
  onStop,
}: BrowserToolbarProps) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.navigation} role="group" aria-label="页面导航">
        <AppButton
          size="small"
          aria-label="后退"
          title="后退"
          icon={<ArrowLeftOutlined />}
          disabled={!textEnabled}
          disableDebounce
          onClick={() => onKeyCommand('back')}
        />
        <AppButton
          size="small"
          aria-label="前进"
          title="前进"
          icon={<ArrowRightOutlined />}
          disabled={!textEnabled}
          disableDebounce
          onClick={() => onKeyCommand('forward')}
        />
        <AppButton
          size="small"
          aria-label="刷新"
          title="刷新"
          icon={<ReloadOutlined />}
          disabled={!textEnabled}
          disableDebounce
          onClick={() => onKeyCommand('reload')}
        />
      </div>

      <div className={styles.addressGroup}>
        <Input
          size="small"
          prefix={<GlobalOutlined aria-hidden="true" />}
          className={styles.address}
          aria-label="浏览器网址"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          onPressEnter={onNavigate}
          placeholder="输入 HTTP / HTTPS 网址"
          disabled={!interactive}
        />
        <AppButton size="small" disabled={!interactive} disableDebounce onClick={onNavigate}>
          前往
        </AppButton>
      </div>

      <div className={styles.toolbarActions}>
        <AppButton
          size="small"
          type={composerOpen ? 'primary' : 'default'}
          icon={<FormOutlined />}
          disabled={!textEnabled}
          aria-expanded={composerOpen}
          disableDebounce
          onClick={onToggleComposer}
        >
          文字输入
        </AppButton>
        {idle ? (
          <AppButton
            size="small"
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={!canStart}
            onClick={onStart}
          >
            启动
          </AppButton>
        ) : (
          <AppButton
            size="small"
            danger
            icon={<StopOutlined />}
            onClick={onStop}
          >
            停止
          </AppButton>
        )}
      </div>
    </div>
  );
}

interface BrowserStatusBarProps {
  state: Phase;
  serverName: string;
  capabilities: BrowserCapabilities | null;
  capabilityLoading: boolean;
  scopeLabel: string;
  idle: boolean;
  active: boolean;
  frameFresh: boolean;
  onRetryCapabilities: () => void;
}

function BrowserStatusBar({
  state,
  serverName,
  capabilities,
  capabilityLoading,
  scopeLabel,
  idle,
  active,
  frameFresh,
  onRetryCapabilities,
}: BrowserStatusBarProps) {
  const statusTagState: SettingStatusState = capabilityLoading && idle
    ? 'saving'
    : active && !frameFresh
      ? 'dirty'
      : PHASE_TAG_STATUS[state];
  const statusTagLabel = capabilityLoading && idle
    ? '检测能力中'
    : active && !frameFresh
      ? '画面待更新'
      : PHASE_LABELS[state];

  return (
    <div className={styles.statusBar} aria-live="polite">
      <div className={styles.statusMetadata}>
        <SettingStatusTag status={statusTagState} label={statusTagLabel} compact />
        <span className={styles.metaChip}>
          {serverName} · {hostLabel(capabilities)}
        </span>
        {capabilities?.browser ? (
          <span className={`${styles.metaChip} ${styles.metaChipMuted}`}>
            {capabilities.browser.vendor} / {capabilities.browser.channel}
          </span>
        ) : null}
        <span className={`${styles.metaChip} ${styles.metaChipMuted}`}>{scopeLabel}</span>
      </div>

      <div className={styles.statusActions}>
        <AppButton
          size="small"
          type="text"
          icon={<ReloadOutlined />}
          loading={capabilityLoading}
          disabled={!idle || capabilityLoading}
          title="重新检测当前执行 Server 的浏览器能力，不重启运行中的浏览器"
          onClick={onRetryCapabilities}
        >
          检测能力
        </AppButton>
      </div>
    </div>
  );
}

interface BrowserSurfacePlaceholderProps {
  state: Phase;
  embedded: boolean;
  capabilityLoading: boolean;
  unavailable: string;
  canStart: boolean;
  scopeNote: string;
  onStart: () => void;
  onRetryCapabilities: () => void;
  onStop: () => void;
}

function BrowserSurfacePlaceholder({
  state,
  embedded,
  capabilityLoading,
  unavailable,
  canStart,
  scopeNote,
  onStart,
  onRetryCapabilities,
  onStop,
}: BrowserSurfacePlaceholderProps) {
  const idle = state === 'disconnected' || state === 'failed';

  if (!idle) {
    return (
      <div className={styles.stateCard} role="status" aria-live="polite">
        <span className={styles.stateIcon} aria-hidden="true">
          <LoadingOutlined spin />
        </span>
        <h3 className={styles.stateTitle}>{PHASE_LABELS[state]}</h3>
        <p className={styles.stateDesc}>正在等待执行 Server 返回实时浏览器画面…</p>
        <div className={styles.stateActions}>
          <AppButton size="small" icon={<StopOutlined />} onClick={onStop}>
            取消连接
          </AppButton>
        </div>
      </div>
    );
  }

  if (capabilityLoading) {
    return (
      <div className={styles.stateCard} role="status" aria-live="polite">
        <span className={styles.stateIcon} aria-hidden="true">
          <LoadingOutlined spin />
        </span>
        <h3 className={styles.stateTitle}>正在检测执行 Server 能力</h3>
        <p className={styles.stateDesc}>检测完成后即可在当前执行 Server 启动远程浏览器。</p>
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className={styles.stateCard} role="alert">
        <span className={`${styles.stateIcon} ${styles.stateIconError}`} aria-hidden="true">
          <CloseCircleOutlined />
        </span>
        <h3 className={styles.stateTitle}>当前 Server 暂不可用</h3>
        <p className={styles.stateDesc}>{unavailable}</p>
        <div className={styles.stateActions}>
          <AppButton size="small" icon={<ReloadOutlined />} onClick={onRetryCapabilities}>
            重新检测能力
          </AppButton>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.stateCard}>
      <span className={styles.stateIcon} aria-hidden="true">
        <DesktopOutlined />
      </span>
      <h3 className={styles.stateTitle}>
        {embedded ? '虚拟电脑浏览器未启动' : '任务浏览器未启动'}
      </h3>
      <p className={styles.stateDesc}>
        {embedded
          ? '网页将在当前虚拟电脑所属 Server 执行，画面与操作保留在本窗口内。'
          : '浏览器运行在所选执行 Server，本端仅查看实时画面并发送交互。'}
      </p>
      <p className={styles.stateDesc}>{scopeNote}</p>
      <div className={styles.stateActions}>
        <AppButton
          type="primary"
          icon={<PlayCircleOutlined />}
          disabled={!canStart}
          onClick={onStart}
        >
          在此 Server 启动浏览器
        </AppButton>
      </div>
    </div>
  );
}

export default function BrowserView({ requiredServerId, embedded = false, active: visible = true, scope, initialUrl }: BrowserViewProps) {
  const boundServerId = requiredServerId?.trim();
  const requestedScopeKey = scope?.scope === 'account'
    ? `account:${scope.provider || ''}:${scope.accountRef || ''}`
    : scope?.scope === 'job'
      ? `job:${scope.authJob || ''}`
      : 'task';
  const ownerRef = useRef({ serverId: boundServerId, active: visible });
  ownerRef.current = { serverId: boundServerId, active: visible };
  const targetIsCurrent = useCallback((selected: Target) => targetMatches(selected, ownerRef.current.serverId), []);
  const [state, setState] = useState<Phase>('disconnected');
  const [error, setError] = useState('');
  const [url, setUrl] = useState(initialUrl || defaultUrl);
  const [target, setTarget] = useState(resolveActiveTransportTarget);
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [capabilityError, setCapabilityError] = useState('');
  const [frameFresh, setFrameFresh] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connectionRef = useRef<Connection | null>(null);
  const phaseRef = useRef<Phase>('disconnected');
  const capabilityRef = useRef<CapabilitySnapshot | null>(null);
  const generationRef = useRef(0);
  const lastFrameRef = useRef(0);
  const lastRenderedFrameRef = useRef(0);
  const imageBusyRef = useRef(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pendingFrameRef = useRef<PendingFrame | null>(null);
  const confirmationRef = useRef<ReturnType<typeof Modal.confirm> | null>(null);
  const retryCapabilitiesRef = useRef<(() => void) | null>(null);

  const send = useCallback((command: Record<string, unknown>) => {
    const snapshot = capabilityRef.current;
    // Obsolete handlers must not put an error into a newly selected Server's UI.
    if (!ownerRef.current.active || !snapshot || !targetIsCurrent(snapshot.target)) return false;
    if (phaseRef.current !== 'ready' || !lastFrameRef.current
      || Date.now() - lastFrameRef.current > frameExpiry || !lastRenderedFrameRef.current) {
      setError('画面尚未就绪或已过期，操作未发送。');
      return false;
    }
    if ((command.type === 'pointer' && snapshot.value.pointer === false)
      || (command.type === 'scroll' && snapshot.value.scroll === false)
      || ((command.type === 'text' || command.type === 'key') && snapshot.value.text === false)) {
      setError('执行 Server 未提供此输入能力，操作未发送。');
      return false;
    }
    const generation = generationRef.current;
    const accepted = connectionRef.current?.send({ ...command, frame: lastRenderedFrameRef.current }) ?? false;
    // A synchronous fail-closed callback already shows its more specific error.
    if (!accepted && generation === generationRef.current) setError('操作未发送（连接未就绪或队列已满），请稍后手动重试。');
    return accepted;
  }, [targetIsCurrent]);

  const input = useBrowserViewInput(canvasRef, send, {
    pointer: visible && capabilities?.pointer !== false,
    scroll: visible && capabilities?.scroll !== false,
    text: visible && capabilities?.text !== false,
  });
  const resetInput = input.reset;

  const resetSession = useCallback((next: Phase = 'disconnected', updateView = true) => {
    // Invalidate callbacks BEFORE closing transport or releasing pointer capture.
    generationRef.current += 1;
    phaseRef.current = next;
    const connection = connectionRef.current;
    connectionRef.current = null;
    connection?.close();
    confirmationRef.current?.destroy();
    confirmationRef.current = null;
    if (imageRef.current) {
      imageRef.current.onload = null;
      imageRef.current.onerror = null;
    }
    imageRef.current = null;
    imageBusyRef.current = false;
    pendingFrameRef.current = null;
    lastFrameRef.current = 0;
    lastRenderedFrameRef.current = 0;
    resetInput();
    const canvas = canvasRef.current;
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    if (updateView) {
      setState(next);
      setFrameFresh(false);
      setComposerOpen(false); // Unmounting also discards the draft and active composition.
      setError('');
      setUrl(initialUrl || defaultUrl);
    }
  }, [initialUrl, resetInput]);

  useLayoutEffect(() => {
    let requestGeneration = 0;
    let controller: AbortController | null = null;
    let pending = false;
    const refresh = (selected: Target, invalidateSession: boolean) => {
      const request = ++requestGeneration;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      if (invalidateSession) resetSession();
      pending = false;
      capabilityRef.current = null;
      setTarget(selected);
      setCapabilities(null);
      setCapabilityError('');
      if (!targetIsCurrent(selected)) {
        retryCapabilitiesRef.current = null;
        setCapabilityLoading(false);
        setCapabilityError('浏览器所属 Server 与当前连接不一致，未连接或启动其他 Server。');
        return;
      }
      pending = true;
      setCapabilityLoading(true);
      const current = () => request === requestGeneration && !signal.aborted && targetIsCurrent(selected);
      retryCapabilitiesRef.current = () => {
        // A retry reads this same target only. Never stop/start a live browser to refresh metadata.
        if (pending || !current() || connectionRef.current || confirmationRef.current
          || (phaseRef.current !== 'disconnected' && phaseRef.current !== 'failed')) return;
        refresh(selected, false);
      };
      void readBrowserCapabilities(signal).then((value) => {
        if (!current()) return;
        capabilityRef.current = { target: selected, value };
        setCapabilities(value);
      }).catch((failure: unknown) => {
        if (!current()) return;
        setCapabilityError(browserViewErrorMessage(failure, 'capability'));
      }).finally(() => {
        if (!current()) return;
        pending = false;
        setCapabilityLoading(false);
      });
    };
    // Profile edits (including a same-ID endpoint/credential change) also invalidate the session.
    const refreshTarget = () => refresh(resolveActiveTransportTarget(), true);
    const unsubscribe = subscribeTransportTargetChange(refreshTarget);
    refreshTarget();
    return () => {
      unsubscribe();
      requestGeneration += 1;
      controller?.abort();
      retryCapabilitiesRef.current = null;
      capabilityRef.current = null;
      resetSession('disconnected', false);
    };
  }, [boundServerId, initialUrl, requestedScopeKey, resetSession, targetIsCurrent]);

  useLayoutEffect(() => {
    if (visible) return;
    confirmationRef.current?.destroy();
    confirmationRef.current = null;
    resetInput();
    lastFrameRef.current = 0;
    setFrameFresh(false);
    setComposerOpen(false);
    canvasRef.current?.blur();
  }, [visible, resetInput]);

  useEffect(() => {
    if (state !== 'ready') return;
    const timer = setInterval(() => {
      const fresh = lastFrameRef.current > 0 && Date.now() - lastFrameRef.current <= frameExpiry;
      setFrameFresh(fresh);
      if (!fresh) resetInput();
    }, 250);
    return () => clearInterval(timer);
  }, [state, resetInput]);

  const startConnection = (snapshot: CapabilitySnapshot) => {
    if (!ownerRef.current.active || capabilityRef.current !== snapshot || !targetIsCurrent(snapshot.target)) return;
    resetSession();
    const generation = generationRef.current;
    let initialNavigationSent = false;
    const current = () => generation === generationRef.current && capabilityRef.current === snapshot && targetIsCurrent(snapshot.target);
    const fail = (message: string) => {
      if (!current()) return;
      resetSession('failed');
      setError(message);
    };
    const changePhase = (next: Phase) => { phaseRef.current = next; setState(next); };
    changePhase('connecting');

    const renderFrame = (frame: PendingFrame) => {
      if (!current() || !ownerRef.current.active || Date.now() - frame.receivedAt > frameExpiry || (frame.event.frame || 0) <= lastRenderedFrameRef.current) return;
      imageBusyRef.current = true;
      const image = new Image();
      imageRef.current = image;
      const finished = () => {
        // An old decoder must never clear the busy flag or pending slot of a new session.
        if (!current() || imageRef.current !== image) return;
        image.onload = null;
        image.onerror = null;
        imageRef.current = null;
        imageBusyRef.current = false;
        const pending = pendingFrameRef.current;
        pendingFrameRef.current = null;
        if (pending) renderFrame(pending);
      };
      image.onload = () => {
        if (!current() || imageRef.current !== image) return;
        try {
          if (!ownerRef.current.active) return;
          const canvas = canvasRef.current;
          if (!canvas || !image.naturalWidth || !image.naturalHeight || Date.now() - frame.receivedAt > frameExpiry) return;
          const context = canvas.getContext('2d');
          if (!context) return;
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          context.drawImage(image, 0, 0);
          lastFrameRef.current = frame.receivedAt;
          lastRenderedFrameRef.current = frame.event.frame || 0;
          setFrameFresh(true);
          setError((previous) => (previous === staleFrameMessage ? '' : previous));
          if (!initialNavigationSent && initialUrl) {
            try {
              const parsed = new URL(initialUrl);
              if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                initialNavigationSent = send({ type: 'navigate', url: parsed.href });
              } else {
                initialNavigationSent = true;
              }
            } catch (_) {
              initialNavigationSent = true;
            }
          }
        } catch (_) {
          setError('浏览器画面无法绘制，正在等待下一帧。');
        } finally { finished(); }
      };
      image.onerror = finished;
      image.src = `data:image/jpeg;base64,${frame.event.data}`;
    };

    let waitingForStart = false;
    let startSent = false;
    const sendStart = () => {
      if (!current() || startSent || !connectionRef.current) return;
      startSent = true;
      if (!connectionRef.current.send({ type: 'start' })) fail('启动命令未发送，请手动重试。');
    };
    const receive = (event: BrowserSurfaceEvent) => {
      if (!current()) return;
      if (event.type === 'waiting-for-start') { waitingForStart = true; sendStart(); }
      if (event.type === 'starting') changePhase('starting');
      if (event.type === 'ready') changePhase('ready');
      if (event.type === 'error') {
        if (event.error !== 'browser_frame_stale') { fail(browserViewErrorMessage(event.error)); return; }
        lastFrameRef.current = 0;
        setFrameFresh(false);
        resetInput();
        setError(staleFrameMessage);
      }
      if (!ownerRef.current.active || event.type !== 'frame' || !event.data || !Number.isSafeInteger(event.frame) || (event.frame || 0) <= lastRenderedFrameRef.current) return;
      const frame = { event, receivedAt: Date.now() };
      if (imageBusyRef.current) {
        if (!pendingFrameRef.current || (event.frame || 0) > (pendingFrameRef.current.event.frame || 0)) pendingFrameRef.current = frame;
      } else renderFrame(frame);
    };
    try {
      const connection = connectBrowserSurface(receive, () => {
        if (!current()) return;
        resetSession();
        setError('与执行 Server 的连接已断开，请手动重新启动。');
      }, scope);
      if (!current()) { connection.close(); return; }
      connectionRef.current = connection;
      if (waitingForStart) sendStart();
    } catch (failure) { fail(browserViewErrorMessage(failure)); }
  };

  const start = () => {
    const snapshot = capabilityRef.current;
    if (!ownerRef.current.active || !snapshot?.value.supported || !snapshot.value.transports?.includes('http-stream-v1') || !targetIsCurrent(snapshot.target) || confirmationRef.current) return;
    confirmationRef.current = Modal.confirm({
      title: embedded ? '在这台虚拟电脑所属 Server 启动浏览器？' : '在当前选中的执行 Server 启动浏览器？',
      content: `执行 Server：${snapshot.target.serverId || '当前 Server'}（${hostLabel(snapshot.value)}）。启动和操作可能激活该 Server 的原生浏览器窗口，使用独立任务资料，不读取日常浏览器数据。`,
      okText: '在此 Server 启动',
      cancelText: '取消',
      onOk: () => startConnection(snapshot),
      onCancel: () => { confirmationRef.current = null; },
    });
  };

  const stop = () => {
    connectionRef.current?.send({ type: 'close' });
    resetSession();
  };

  const navigate = () => {
    try {
      const parsed = new URL(url.includes('://') ? url : `https://${url}`);
      if (!['http:', 'https:'].includes(parsed.protocol)) { setError('仅支持 HTTP / HTTPS 地址。'); return; }
      if (!send({ type: 'navigate', url: parsed.href })) return;
      setUrl(parsed.href);
      setError('');
    } catch (_) {
      setError('网址无效，请输入 HTTP / HTTPS 地址。');
    }
  };

  const active = state === 'ready';
  const interactive = visible && active && frameFresh && targetIsCurrent(target);
  const idle = state === 'disconnected' || state === 'failed';
  const textEnabled = interactive && capabilities?.text !== false;
  const requestedScopeSupported = (scope?.scope !== 'account' && scope?.scope !== 'job')
    || capabilities?.scopes?.includes(scope.scope) === true;
  const canStart = visible && targetIsCurrent(target) && !capabilityLoading
    && capabilities?.supported === true
    && capabilities.transports?.includes('http-stream-v1') === true
    && requestedScopeSupported;
  const unavailable = capabilityError || (capabilities && !capabilities.supported
    ? browserViewErrorMessage(capabilities.reason, 'capability')
    : capabilities && scope?.scope === 'account' && !requestedScopeSupported
      ? '当前 Server 未提供账号级持久浏览器资料，未回退到任务资料。'
      : capabilities && !capabilities.transports?.includes('http-stream-v1')
        ? '执行 Server 未提供 http-stream-v1，无法从此 WebUI 连接。'
        : '');

  const serverName = boundServerId || target.serverId || '当前 Server';
  const scopeInfo = scopeSummary(scope);
  // Avoid duplicating unavailable error when idle surface already displays it prominently.
  const headerFeedback = error || (!idle && unavailable ? unavailable : '');

  return (
    <section
      className={`${styles.root}${embedded ? ` ${styles.embedded}` : ''}`}
      aria-label={embedded ? '虚拟电脑内部浏览器' : '所选 Server 的任务浏览器'}
    >
      <div className={styles.header}>
        <BrowserToolbar
          url={url}
          interactive={interactive}
          textEnabled={textEnabled}
          idle={idle}
          canStart={canStart}
          composerOpen={composerOpen}
          onUrlChange={setUrl}
          onNavigate={navigate}
          onKeyCommand={(key) => { send({ type: 'key', key }); }}
          onToggleComposer={() => setComposerOpen((open) => !open)}
          onStart={start}
          onStop={stop}
        />

        <BrowserStatusBar
          state={state}
          serverName={serverName}
          capabilities={capabilities}
          capabilityLoading={capabilityLoading}
          scopeLabel={scopeInfo.label}
          idle={idle}
          active={active}
          frameFresh={frameFresh}
          onRetryCapabilities={() => retryCapabilitiesRef.current?.()}
        />

        {headerFeedback ? (
          <div className={styles.feedbackRow}>
            <InlineNote
              tone="error"
              action={
                idle && canStart ? (
                  <AppButton size="small" type="link" onClick={start}>
                    重新启动
                  </AppButton>
                ) : null
              }
            >
              {headerFeedback}
            </InlineNote>
          </div>
        ) : null}
      </div>

      <div className={styles.surface} aria-busy={state === 'connecting' || state === 'starting' || (idle && capabilityLoading)}>
        {!active ? (
          <BrowserSurfacePlaceholder
            state={state}
            embedded={embedded}
            capabilityLoading={capabilityLoading}
            unavailable={unavailable}
            canStart={canStart}
            scopeNote={scopeInfo.note}
            onStart={start}
            onRetryCapabilities={() => retryCapabilitiesRef.current?.()}
            onStop={stop}
          />
        ) : null}

        <canvas
          ref={canvasRef}
          className={styles.canvas}
          tabIndex={interactive ? 0 : -1}
          aria-label="实时浏览器画面；单指轻点或滑动滚动，中文和软键盘请使用文字输入"
          style={{ display: active ? 'block' : 'none' }}
          {...input.canvasProps}
        />

        {active && !frameFresh ? (
          <div className={styles.staleBanner} role="status" aria-live="polite">
            <span className={styles.staleBadge}>
              <WarningOutlined aria-hidden="true" />
              <span>等待新画面，输入已暂停</span>
            </span>
          </div>
        ) : null}
      </div>

      {composerOpen ? <BrowserTextComposer disabled={!textEnabled} send={send} /> : null}
    </section>
  );
}
