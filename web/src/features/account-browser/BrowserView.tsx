import { useEffect, useRef, useState } from 'react';
import { Button, Input, Space, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, DesktopOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { connectBrowserSurface, type BrowserSurfaceEvent } from './browser-view-client';
import styles from './browser-view.module.css';

const knownKeys = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown']);
const errors: Record<string, string> = {
  browser_system_permission_required: '原生进程缺少录屏或事件发送权限；本功能不会自动申请或修改系统权限。',
  browser_native_build_unavailable: '当前 Mac 无法构建原生窗口桥，请确认已安装 Xcode Command Line Tools。',
  browser_surface_already_controlled: '已有窗口正在控制这个浏览器，请先关闭原连接。',
  browser_frame_stale: '画面已过期，输入已暂停。',
  browser_multiple_windows_not_supported: '检测到多个任务窗口，首版仅允许一个窗口。',
};

type Connection = ReturnType<typeof connectBrowserSurface>;

export default function BrowserView() {
  const [state, setState] = useState('disconnected');
  const [error, setError] = useState('');
  const [url, setUrl] = useState('https://www.google.com');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const connectionRef = useRef<Connection | null>(null);
  const lastFrameRef = useRef(0);
  const imageBusyRef = useRef(false);
  const composingRef = useRef(false);
  const generationRef = useRef(0);
  const frameVersionRef = useRef(0);
  const lastRenderedFrameRef = useRef(0);
  const lastCompositionRef = useRef<{ text: string; at: number } | null>(null);
  const active = state === 'ready';

  const send = (command: Record<string, unknown>) => {
    if (Date.now() - lastFrameRef.current > 2500 || state !== 'ready') return;
    connectionRef.current?.send({ ...command, frame: lastRenderedFrameRef.current });
  };

  const stop = () => {
    generationRef.current += 1;
    connectionRef.current?.send({ type: 'close' });
    connectionRef.current?.close();
    connectionRef.current = null;
    setState('disconnected');
    lastFrameRef.current = 0;
  };

  useEffect(() => () => { generationRef.current += 1; connectionRef.current?.close(); }, []);

  const start = () => {
    if (!window.confirm('启动并操作这个独立任务浏览器时，macOS 可能切换到原生 Edge 窗口。仅共享任务窗口，不读取日常浏览器资料。是否继续？')) return;
    stop();
    setError('');
    setState('connecting');
    const generation = generationRef.current;
    try {
      let failureShown = false;
      const receive = (event: BrowserSurfaceEvent) => {
        if (generation !== generationRef.current) return;
        if (event.type === 'waiting-for-start') connectionRef.current?.send({ type: 'start' });
        if (event.type === 'starting') { imageBusyRef.current = false; setState('starting'); }
        if (event.type === 'ready') setState('ready');
        if (event.type === 'error') {
          if (!failureShown) setError(errors[event.error || ''] || event.error || '浏览器连接不可用');
          failureShown = true;
          if (event.error !== 'browser_frame_stale') setState('failed');
        }
        if (event.type !== 'frame' || !event.data || imageBusyRef.current) return;
        imageBusyRef.current = true;
        const frameVersion = ++frameVersionRef.current;
        const image = new Image();
        image.onload = () => {
          imageBusyRef.current = false;
          if (generation !== generationRef.current || frameVersion !== frameVersionRef.current) return;
          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext('2d')?.drawImage(image, 0, 0);
          lastFrameRef.current = Date.now();
          lastRenderedFrameRef.current = event.frame || 0;
        };
        image.onerror = () => { imageBusyRef.current = false; };
        image.src = `data:image/jpeg;base64,${event.data}`;
      };
      connectionRef.current = connectBrowserSurface(receive, () => {
        if (generation !== generationRef.current) return;
        if (!failureShown) setState('disconnected');
        lastFrameRef.current = 0;
      });
    } catch (failure) {
      setState('failed');
      setError(failure instanceof Error ? failure.message : '浏览器连接失败');
    }
  };

  const navigate = () => {
    try {
      const parsed = new URL(url.includes('://') ? url : `https://${url}`);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP / HTTPS 地址');
      setUrl(parsed.href);
      send({ type: 'navigate', url: parsed.href });
    } catch (failure) { setError(failure instanceof Error ? failure.message : '网址无效'); }
  };

  return <section className={styles.root} aria-label="任务浏览器">
    <div className={styles.toolbar}>
      <Button aria-label="后退" icon={<ArrowLeftOutlined />} disabled={!active} onClick={() => send({ type: 'key', key: 'back' })} />
      <Button aria-label="前进" icon={<ArrowRightOutlined />} disabled={!active} onClick={() => send({ type: 'key', key: 'forward' })} />
      <Button aria-label="刷新" icon={<ReloadOutlined />} disabled={!active} onClick={() => send({ type: 'key', key: 'reload' })} />
      <Input className={styles.address} value={url} onChange={(event) => setUrl(event.target.value)} onPressEnter={navigate} placeholder="输入网址" disabled={!active} />
      <Button disabled={!active} onClick={navigate}>前往</Button>
      <Button icon={<StopOutlined />} disabled={state === 'disconnected'} onClick={stop}>停止</Button>
    </div>
    <div className={styles.status}>
      <Space size={8}><Tag>{state === 'ready' ? '画面已连接' : state === 'starting' ? '正在启动' : state === 'connecting' ? '连接中' : state === 'failed' ? '未就绪' : '未连接'}</Tag><span>本机稳定版 Edge · 单任务窗口 · 启动和操作可能切换到原生窗口</span></Space>
      {error ? <Typography.Text type="danger" role="status">{error}</Typography.Text> : null}
    </div>
    <div className={styles.surface}>
      {state === 'disconnected' || state === 'failed' ? <div className={styles.empty}>
        <DesktopOutlined style={{ fontSize: 32 }} />
        <span>使用独立任务资料，不读取日常浏览器资料；首次启动需要编译原生窗口桥。</span>
        <Button type="primary" icon={<DesktopOutlined />} onClick={start}>启动真实浏览器</Button>
        <span>断开连接不代表已确认原生进程退出。此入口尚未关联 OAuth 账号，代理未接入。</span>
      </div> : null}
      <canvas ref={canvasRef} className={styles.canvas} tabIndex={0} aria-label="实时浏览器画面，点击控制网页" style={{ display: active ? 'block' : 'none' }}
        onPointerDown={(event) => {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          send({ type: 'pointer', x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height, button: event.button });
          inputRef.current?.focus({ preventScroll: true });
        }}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={(event) => { event.preventDefault(); send({ type: 'scroll', deltaX: Math.max(-2000, Math.min(2000, event.deltaX)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY)) }); }}
        onFocus={() => inputRef.current?.focus({ preventScroll: true })} />
      <textarea ref={inputRef} className={styles.ime} disabled={!active} aria-label="浏览器文本输入"
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(event) => { composingRef.current = false; if (event.data) { lastCompositionRef.current = { text: event.data, at: Date.now() }; send({ type: 'text', text: event.data }); } event.currentTarget.value = ''; }}
        onInput={(event) => { if (composingRef.current) return; const text = event.currentTarget.value; const composition = lastCompositionRef.current; if (text && !(composition?.text === text && Date.now() - composition.at < 100)) send({ type: 'text', text }); lastCompositionRef.current = null; event.currentTarget.value = ''; }}
        onKeyDown={(event) => { if (!composingRef.current && knownKeys.has(event.key)) { event.preventDefault(); send({ type: 'key', key: event.key }); } }} />
    </div>
  </section>;
}
