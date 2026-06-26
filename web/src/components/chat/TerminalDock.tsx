import { useEffect, useRef, useState } from 'react';
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
      fontSize: 12,
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

  // 展开后重新 fit（折叠时容器 display:none，尺寸为 0）。
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
  }, [collapsed, active]);

  if (!visible || !runId) return null;

  return (
    <div className={`${styles.terminalDock} ${styles.composerDockCard}`}>
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
      />
    </div>
  );
}

export default TerminalDock;
