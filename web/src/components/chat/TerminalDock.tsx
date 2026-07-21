import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { DownOutlined, RightOutlined, CloseOutlined } from '@ant-design/icons';
import styles from './chat.module.css';

export interface TerminalRunState {
  runId: string;
  command: string;
  active: boolean;
}

// 可拖拽 + 持久化的 dock 高度:全屏 TUI(claude/codex slash)在固定 280px 里会被截断,
// 默认给足高度并允许用户拉伸(往上拖变高),下次记住。
const HEIGHT_STORAGE_KEY = 'aih:webui-terminaldock-height:v1';
const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 380;

function maxDockHeight(): number {
  if (typeof window === 'undefined') return 800;
  return Math.max(240, Math.round(window.innerHeight * 0.72));
}

function readStoredDockHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_HEIGHT;
  const raw = Number(window.localStorage.getItem(HEIGHT_STORAGE_KEY));
  if (!Number.isFinite(raw) || raw < MIN_HEIGHT) return DEFAULT_HEIGHT;
  return Math.min(raw, maxDockHeight());
}

interface TerminalDockProps {
  visible: boolean;
  run: TerminalRunState | null;
  // 注册命令式 write 通道：父组件用它把 terminal-output 直接喂进 xterm，避免走 React state 抖动。
  onRegisterWriter: (runId: string, writer: ((data: string) => void) | null) => void;
  onInput: (runId: string, data: string) => void;
  onResize: (runId: string, cols: number, rows: number) => void;
  onClose: (runId: string) => void;
}

// 内嵌可折叠 xterm 终端面板。靠父组件用 key={runId} 保证「一次 slash 运行 = 一个全新实例」，
// 因此组件内 runId 恒定，无需处理 runId 变更。
function TerminalDock({ visible, run, onRegisterWriter, onInput, onResize, onClose }: TerminalDockProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);
  const heightRef = useRef(height);
  heightRef.current = height;
  // 客户端挂载后读持久化高度(SSR 安全)。
  useEffect(() => {
    setHeight(readStoredDockHeight());
  }, []);

  const runId = run?.runId || '';
  const active = Boolean(run?.active);
  const command = run?.command || '';

  // 把最新回调放进 ref，避免它们变化触发 xterm 重建。
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onRegisterWriterRef = useRef(onRegisterWriter);
  onInputRef.current = onInput;
  onResizeRef.current = onResize;
  onRegisterWriterRef.current = onRegisterWriter;

  // 创建 / 销毁 xterm（runId 恒定，挂载一次）。
  useEffect(() => {
    if (!runId) return;
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      // 手机窄屏下 12px 等宽太挤、slash 命令输出几乎不可读,放大到 13.5;桌面保持 12。
      fontSize: (typeof window !== 'undefined' && window.innerWidth < 768) ? 13.5 : 12,
      scrollback: 5000,
      theme: { background: '#1b1d22' }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      /* 容器尚无尺寸时忽略，ResizeObserver 会补 */
    }

    term.onData((data) => {
      onInputRef.current(runId, data);
    });
    term.onResize(({ cols, rows }) => {
      onResizeRef.current(runId, cols, rows);
    });

    termRef.current = term;
    fitRef.current = fit;
    onRegisterWriterRef.current(runId, (chunk: string) => term.write(chunk));
    term.focus();

    const observer = new ResizeObserver(() => {
      const node = containerRef.current;
      if (!node || node.clientWidth === 0 || node.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      onRegisterWriterRef.current(runId, null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [runId]);

  // 运行结束 → 只读。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !active;
  }, [active]);

  // 展开 / 高度变化后重新 fit（折叠时容器 display:none，尺寸为 0）。height 变化 → 重算 rows/cols
  // 并经 term.onResize 通知后端 child.resize，保证 TUI 铺满新高度、不截断。
  useEffect(() => {
    if (collapsed) return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    const id = window.setTimeout(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      if (active) term.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [collapsed, active, height]);

  // 顶边拖拽调高（往上拖 = 变高），松手持久化。
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const start = { startY: e.clientY, startH: heightRef.current };
    const onMove = (ev: MouseEvent) => {
      const delta = start.startY - ev.clientY;
      const next = Math.max(MIN_HEIGHT, Math.min(maxDockHeight(), start.startH + delta));
      setHeight(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      try {
        window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(Math.round(heightRef.current)));
      } catch {
        /* ignore */
      }
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  if (!visible || !runId) return null;

  return (
    <div className={`${styles.terminalDock} ${styles.composerDockCard}`}>
      {!collapsed && (
        <div
          className={styles.terminalDockResizer}
          onMouseDown={onDragStart}
          title="拖拽调整终端高度"
        />
      )}
      <div className={styles.terminalDockHeader}>
        <button
          type="button"
          className={styles.terminalDockToggle}
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? '展开终端' : '折叠终端'}
        >
          {collapsed ? <RightOutlined /> : <DownOutlined />}
          <span className={styles.terminalDockTitle}>
            {command || 'terminal'}
          </span>
        </button>
        <span className={styles.terminalDockStatus}>
          {active ? '运行中' : '已结束'}
        </span>
        <button
          type="button"
          className={styles.terminalDockClose}
          onClick={() => onClose(runId)}
          aria-label="关闭终端"
        >
          <CloseOutlined />
        </button>
      </div>
      <div
        ref={containerRef}
        className={`${styles.terminalDockBody} ${collapsed ? styles.terminalDockBodyCollapsed : ''}`}
        style={collapsed ? undefined : { height }}
      />
    </div>
  );
}

export default TerminalDock;
