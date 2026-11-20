import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, DesktopOutlined, FormOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { resolveActiveTransportTarget, subscribeTransportTargetChange } from '@/services/webui-auth-transport';
import { connectBrowserSurface, readBrowserCapabilities, type BrowserCapabilities, type BrowserSurfaceEvent } from './browser-view-client';
import BrowserTextComposer from './BrowserTextComposer';
import { useBrowserViewInput } from './browser-view-input';
import styles from './browser-view.module.css';

const defaultUrl = 'https://www.google.com';
const frameExpiry = 2500;
const errors: Record<string, string> = {
  browser_system_permission_required: '执行 Server 缺少录屏或事件发送权限；本功能不会自动申请或修改系统权限。',
  browser_native_build_unavailable: '执行 Server 的原生窗口桥不可用，请检查该 Server 的构建环境。',
  browser_surface_already_controlled: '已有窗口正在控制这个浏览器，请先关闭原连接。',
  browser_frame_stale: '画面已过期，输入已暂停。',
  browser_multiple_windows_not_supported: '检测到多个任务窗口，目前仅允许一个窗口。',
  browser_cleanup_required: '执行 Server 的浏览器清理尚未完成，请先检查原生进程。',
  browser_host_platform_unavailable: '执行 Server 的平台尚无可用的浏览器适配器。',
  browser_host_os_version_unavailable: '无法读取执行 Server 的系统版本，浏览器能力不可用。',
  browser_host_requires_macos14: '执行 Server 的浏览器适配器要求 macOS 14 或以上版本。',
  browser_home_requires_absolute_path: '执行 Server 的任务资料目录配置不满足要求。',
  browser_control_backpressure: '控制链路繁忙，已安全断开。请手动重新连接；未确认操作不会自动重试。',
};
type Connection = ReturnType<typeof connectBrowserSurface>;
type Target = ReturnType<typeof resolveActiveTransportTarget>;
type Phase = 'disconnected' | 'connecting' | 'starting' | 'ready' | 'failed';
type CapabilitySnapshot = { target: Target; value: BrowserCapabilities };
type PendingFrame = { event: BrowserSurfaceEvent; receivedAt: number };
const phases: Record<Phase, string> = { disconnected: '未连接', connecting: '连接中', starting: '正在启动', ready: '画面已连接', failed: '未就绪' };

function targetMatches(target: Target) {
  const current = resolveActiveTransportTarget();
  return current.scopeKey === target.scopeKey && current.serverId === target.serverId
    && current.isRemote === target.isRemote && current.targetOrigin === target.targetOrigin;
}

function hostLabel(capabilities: BrowserCapabilities | null) {
  if (!capabilities) return '系统信息待获取';
  const names: Record<string, string> = { darwin: 'macOS', windows: 'Windows', linux: 'Linux' };
  const os = capabilities.hostOS ? names[capabilities.hostOS] || capabilities.hostOS : '系统信息未返回';
  return [os, capabilities.hostArch].filter(Boolean).join(' / ');
}

export default function BrowserView() {
  const [state, setState] = useState<Phase>('disconnected');
  const [error, setError] = useState('');
  const [url, setUrl] = useState(defaultUrl);
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

  const send = useCallback((command: Record<string, unknown>) => {
    const snapshot = capabilityRef.current;
    // Obsolete handlers must not put an error into a newly selected Server's UI.
    if (!snapshot || !targetMatches(snapshot.target)) return false;
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
  }, []);

  const input = useBrowserViewInput(canvasRef, send, {
    pointer: capabilities?.pointer !== false,
    scroll: capabilities?.scroll !== false,
    text: capabilities?.text !== false,
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
      setUrl(defaultUrl);
    }
  }, [resetInput]);

  useEffect(() => {
    let requestGeneration = 0;
    let controller: AbortController | null = null;
    const refresh = () => {
      const request = ++requestGeneration;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      resetSession();
      const selected = resolveActiveTransportTarget();
      capabilityRef.current = null;
      setTarget(selected);
      setCapabilities(null);
      setCapabilityError('');
      setCapabilityLoading(true);
      const current = () => request === requestGeneration && !signal.aborted && targetMatches(selected);
      void readBrowserCapabilities(signal).then((value) => {
        if (!current()) return;
        capabilityRef.current = { target: selected, value };
        setCapabilities(value);
      }).catch((failure: unknown) => {
        if (!current()) return;
        setCapabilityError(failure instanceof Error ? failure.message : '无法读取执行 Server 的浏览器能力');
      }).finally(() => { if (current()) setCapabilityLoading(false); });
    };
    // Profile edits (including a same-ID endpoint/credential change) also invalidate the session.
    const unsubscribe = subscribeTransportTargetChange(refresh);
    refresh();
    return () => {
      unsubscribe();
      requestGeneration += 1;
      controller?.abort();
      capabilityRef.current = null;
      resetSession('disconnected', false);
    };
  }, [resetSession]);

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
    if (capabilityRef.current !== snapshot || !targetMatches(snapshot.target)) return;
    resetSession();
    const generation = generationRef.current;
    const current = () => generation === generationRef.current && capabilityRef.current === snapshot && targetMatches(snapshot.target);
    const fail = (message: string) => {
      if (!current()) return;
      resetSession('failed');
      setError(message);
    };
    const changePhase = (next: Phase) => { phaseRef.current = next; setState(next); };
    changePhase('connecting');

    const renderFrame = (frame: PendingFrame) => {
      if (!current() || Date.now() - frame.receivedAt > frameExpiry || (frame.event.frame || 0) <= lastRenderedFrameRef.current) return;
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
          setError((previous) => previous === errors.browser_frame_stale ? '' : previous);
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
        if (event.error !== 'browser_frame_stale') { fail(errors[event.error || ''] || event.error || '浏览器连接不可用'); return; }
        lastFrameRef.current = 0;
        setFrameFresh(false);
        resetInput();
        setError(errors.browser_frame_stale);
      }
      if (event.type !== 'frame' || !event.data || !Number.isSafeInteger(event.frame) || (event.frame || 0) <= lastRenderedFrameRef.current) return;
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
      });
      if (!current()) { connection.close(); return; }
      connectionRef.current = connection;
      if (waitingForStart) sendStart();
    } catch (failure) { fail(failure instanceof Error ? failure.message : '浏览器连接失败'); }
  };

  const start = () => {
    const snapshot = capabilityRef.current;
    if (!snapshot?.value.supported || !snapshot.value.transports?.includes('http-stream-v1') || !targetMatches(snapshot.target) || confirmationRef.current) return;
    confirmationRef.current = Modal.confirm({
      title: '在当前选中的执行 Server 启动浏览器？',
      content: `执行 Server：${snapshot.target.serverId || '当前 Server'}（${hostLabel(snapshot.value)}）。启动和操作可能激活该 Server 的原生浏览器窗口，而不是手机或查看设备上的浏览器。使用独立任务资料，不读取日常浏览器资料。`,
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
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP / HTTPS 地址');
      if (!send({ type: 'navigate', url: parsed.href })) return;
      setUrl(parsed.href);
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '网址无效'); }
  };

  const active = state === 'ready';
  const interactive = active && frameFresh;
  const idle = state === 'disconnected' || state === 'failed';
  const textEnabled = interactive && capabilities?.text !== false;
  const canStart = !capabilityLoading && capabilities?.supported === true && capabilities.transports?.includes('http-stream-v1') === true;
  const unavailable = capabilityError || (capabilities && !capabilities.supported
    ? errors[capabilities.reason || ''] || capabilities.reason || '执行 Server 未提供可用的浏览器适配器。'
    : capabilities && !capabilities.transports?.includes('http-stream-v1') ? '执行 Server 未提供 http-stream-v1，无法从此 WebUI 连接。' : '');

  return <section className={styles.root} aria-label="所选 Server 的任务浏览器">
    <div className={styles.toolbar}>
      <div className={styles.navigation}>
        <Button aria-label="后退" icon={<ArrowLeftOutlined />} disabled={!textEnabled} onClick={() => send({ type: 'key', key: 'back' })} />
        <Button aria-label="前进" icon={<ArrowRightOutlined />} disabled={!textEnabled} onClick={() => send({ type: 'key', key: 'forward' })} />
        <Button aria-label="刷新" icon={<ReloadOutlined />} disabled={!textEnabled} onClick={() => send({ type: 'key', key: 'reload' })} />
      </div>
      <div className={styles.addressGroup}>
        <Input className={styles.address} aria-label="浏览器网址" value={url} onChange={(event) => setUrl(event.target.value)}
          onPressEnter={navigate} placeholder="输入网址" disabled={!interactive} />
        <Button disabled={!interactive} onClick={navigate}>前往</Button>
      </div>
      <Button icon={<FormOutlined />} disabled={!textEnabled} aria-expanded={composerOpen} onClick={() => setComposerOpen((open) => !open)}>文字输入</Button>
      <Button icon={<StopOutlined />} disabled={idle} onClick={stop}>停止</Button>
    </div>
    <div className={styles.status} aria-live="polite">
      <div className={styles.statusMetadata}>
        <Tag>{phases[state]}</Tag>
        <span>执行 Server：{target.serverId || '当前 Server'} · {hostLabel(capabilities)}</span>
        {capabilities?.browser ? <span>{capabilities.browser.vendor} / {capabilities.browser.channel}</span> : null}
        <span>单任务窗口</span>
        {capabilityLoading ? <span>正在读取 Server 能力…</span> : null}
        {active && !frameFresh ? <span>等待新画面，输入已暂停</span> : null}
      </div>
      {unavailable || error ? <Typography.Text type="danger" role="status">{unavailable || error}</Typography.Text> : null}
    </div>
    <div className={styles.surface} aria-busy={state === 'connecting' || state === 'starting'}>
      {idle ? <div className={styles.empty}>
        <DesktopOutlined style={{ fontSize: 30 }} />
        <span>浏览器运行在上方所选执行 Server，手机和桌面浏览器仅查看、发送操作。</span>
        <Button type="primary" icon={<DesktopOutlined />} disabled={!canStart} onClick={start}>在此 Server 启动浏览器</Button>
        <span>不支持的 Server 不会回退到本机；权限在启动时检查，不会自动申请。</span>
        <span>断开不代表原生进程已退出。此入口尚未关联 OAuth 账号，代理未接入。</span>
      </div> : !active ? <span className={styles.hint}>{phases[state]}，正在等待执行 Server 的画面…</span> : null}
      <canvas ref={canvasRef} className={styles.canvas} tabIndex={interactive ? 0 : -1}
        aria-label="实时浏览器画面；单指轻点或滑动滚动，中文和软键盘请使用文字输入"
        style={{ display: active ? 'block' : 'none' }} {...input.canvasProps} />
    </div>
    {composerOpen ? <BrowserTextComposer disabled={!textEnabled} send={send} /> : null}
  </section>;
}
