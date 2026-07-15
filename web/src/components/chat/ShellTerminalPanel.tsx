import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { CloseOutlined, ReloadOutlined, CodeOutlined, PlusOutlined } from '@ant-design/icons';
import { terminalAPI } from '@/services/api';
import styles from './chat.module.css';

interface ShellTerminalPanelProps {
  visible: boolean;
  onClose: () => void;
  // 当前项目路径：新开/重连终端时作为 shell 的 cwd，直接进入项目目录（而非 home）。
  cwd?: string;
}

type TabStatus = 'connecting' | 'ready' | 'closed' | 'error';

interface TabMeta {
  id: string;
  termId: string;
  label: string;
  status: TabStatus;
}

interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  termId: string;
  opened: boolean;
  inputBuf: string;
  sending: boolean;
}

// 逐击键各发一条并发 POST 无法保证到达顺序（快速输入/粘贴会被打乱 → 命令乱码）。
// 这里按 tab 合并缓冲、单条在途、顺序发送，既保序又聚合突发输入。
async function flushInput(inst: TermInstance) {
  if (inst.sending || !inst.termId) return;
  inst.sending = true;
  try {
    while (inst.inputBuf) {
      const chunk = inst.inputBuf;
      inst.inputBuf = '';
      await terminalAPI.input(inst.termId, chunk);
    }
  } catch { /* 忽略：下次击键会重试 */ } finally {
    inst.sending = false;
  }
}

const HEIGHT_STORAGE_KEY = 'aih:webui-terminal-height:v1';
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 300;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function readStoredHeight(): number {
  try {
    const raw = Number(window.localStorage.getItem(HEIGHT_STORAGE_KEY));
    if (Number.isFinite(raw) && raw >= MIN_HEIGHT) return raw;
  } catch (_error) { /* ignore */ }
  return DEFAULT_HEIGHT;
}

function maxHeight(): number {
  if (typeof window === 'undefined') return 600;
  return Math.round(window.innerHeight * 0.7);
}

function newTerm(): Terminal {
  return new Terminal({
    convertEol: false,
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    scrollback: 8000,
    theme: { background: '#1b1d22', foreground: '#d4d4d4', cursor: '#d4d4d4' }
  });
}

// VSCode 风格底部终端「面板」：多 tab、可拖拽调高、底部停靠。
// 每个 tab = 独立 PTY + 独立 xterm；整个面板复用一条 mux SSE 承载全部 tab 输出（帧带 termId），
// 规避浏览器每域 ~6 连接上限（此前多 tab / 慢开会永远卡「连接中」的根因）。
function ShellTerminalPanel({ visible, onClose, cwd }: ShellTerminalPanelProps) {
  const muxIdRef = useRef<string>('');
  // 用 ref 持有最新 cwd：切项目后新开/重连的终端应进入新项目目录，避免闭包捕获旧值。
  const cwdRef = useRef<string | undefined>(cwd);
  cwdRef.current = cwd;
  const esRef = useRef<EventSource | null>(null);
  const instancesRef = useRef<Map<string, TermInstance>>(new Map());
  const byTermIdRef = useRef<Map<string, string>>(new Map());
  // termId -> 早到但还没建立 termId→tab 映射时缓存的帧（open 的 fetch 与 SSE 输出是两条通道，
  // PTY 的首个 prompt 可能先于 open 响应到达，若不缓存会被丢弃 → 终端空白）。
  const pendingRef = useRef<Map<string, any[]>>(new Map());
  const tabSeqRef = useRef(0);
  const panelReadyRef = useRef(false);

  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [panelStatus, setPanelStatus] = useState<TabStatus>('connecting');
  const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);

  // 应用一帧（output/exit）到某个 tab 的 xterm。
  const applyFrame = useCallback((tabId: string, inst: TermInstance, msg: any) => {
    if (msg.type === 'output' && typeof msg.data === 'string') {
      inst.term.write(base64ToBytes(msg.data));
    } else if (msg.type === 'exit') {
      inst.term.options.disableStdin = true;
      inst.term.writeln('\r\n\x1b[90m[进程已退出]\x1b[0m');
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, status: 'closed' } : t)));
    }
  }, []);

  // 建立 termId→tab 映射，并回放这段时间内早到被缓存的帧（prompt 等）。
  const registerTermId = useCallback((tabId: string, termId: string, inst: TermInstance) => {
    inst.termId = termId;
    byTermIdRef.current.set(termId, tabId);
    const queued = pendingRef.current.get(termId);
    if (queued) {
      pendingRef.current.delete(termId);
      for (const m of queued) applyFrame(tabId, inst, m);
    }
    void flushInput(inst); // 冲掉 termId 就绪前缓冲的击键
  }, [applyFrame]);

  // ── 打开一个新 tab（新 PTY + 新 xterm），共用面板的 muxId ──
  const createTab = useCallback(async () => {
    const id = `t-${(tabSeqRef.current += 1)}`;
    const label = `终端 ${tabSeqRef.current}`;
    const term = newTerm();
    const fit = new FitAddon();
    term.loadAddon(fit);
    const inst: TermInstance = { term, fit, termId: '', opened: false, inputBuf: '', sending: false };
    instancesRef.current.set(id, inst);

    term.onData((data) => {
      inst.inputBuf += data;
      void flushInput(inst);
    });
    term.onResize(({ cols, rows }) => {
      if (inst.termId) terminalAPI.resize(inst.termId, cols, rows).catch(() => {});
    });

    setTabs((prev) => [...prev, { id, termId: '', label, status: 'connecting' }]);
    setActiveId(id);

    try {
      const res = await terminalAPI.open(term.cols || 80, term.rows || 24, muxIdRef.current, cwdRef.current);
      if (!res.ok || !res.termId) {
        term.writeln(`\x1b[31m终端启动失败: ${res.error || 'unknown'}\x1b[0m`);
        setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'error' } : t)));
        return;
      }
      registerTermId(id, res.termId, inst);
      setTabs((prev) => prev.map((t) => (
        t.id === id
          ? { ...t, termId: res.termId!, status: panelReadyRef.current ? 'ready' : 'connecting' }
          : t
      )));
    } catch (error) {
      term.writeln(`\x1b[31m终端连接失败: ${String((error as Error)?.message || error)}\x1b[0m`);
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'error' } : t)));
    }
  }, [registerTermId]);

  // ── 面板生命周期：建立 mux SSE + 首个 tab；卸载/关闭时全部回收 ──
  useEffect(() => {
    if (!visible) return;
    if (esRef.current) return; // 已初始化（防重复/StrictMode 双挂）

    panelReadyRef.current = false;
    setPanelStatus('connecting');
    const muxId = `mux-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    muxIdRef.current = muxId;

    const es = terminalAPI.openMuxStream(muxId);
    esRef.current = es;
    es.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'connected') {
        panelReadyRef.current = true;
        setPanelStatus('ready');
        setTabs((prev) => prev.map((t) => (t.termId && t.status === 'connecting' ? { ...t, status: 'ready' } : t)));
        return;
      }
      const termId = msg.termId ? String(msg.termId) : '';
      const tabId = termId ? byTermIdRef.current.get(termId) : '';
      if (!tabId) {
        // 映射还没建立（output 先于 open 响应到达）→ 缓存，registerTermId 时回放。
        if (termId) {
          const q = pendingRef.current.get(termId) || [];
          q.push(msg);
          pendingRef.current.set(termId, q);
        }
        return;
      }
      const inst = instancesRef.current.get(tabId);
      if (!inst) return;
      applyFrame(tabId, inst, msg);
    };
    es.onerror = () => {
      if (!panelReadyRef.current) setPanelStatus('error');
    };

    setHeight(readStoredHeight());
    void createTab();

    return () => {
      try { es.close(); } catch { /* ignore */ }
      esRef.current = null;
      for (const inst of instancesRef.current.values()) {
        if (inst.termId) terminalAPI.close(inst.termId).catch(() => {});
        try { inst.term.dispose(); } catch { /* ignore */ }
      }
      instancesRef.current.clear();
      byTermIdRef.current.clear();
      pendingRef.current.clear();
      muxIdRef.current = '';
      panelReadyRef.current = false;
      setTabs([]);
      setActiveId('');
      tabSeqRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // 挂载 xterm 到激活 tab 的容器（每个容器只 open 一次）。
  const attachBody = useCallback((id: string) => (el: HTMLDivElement | null) => {
    const inst = instancesRef.current.get(id);
    if (!inst || !el || inst.opened) return;
    inst.term.open(el);
    inst.opened = true;
    requestAnimationFrame(() => {
      try { inst.fit.fit(); } catch { /* 容器暂无尺寸 */ }
      inst.term.focus();
    });
  }, []);

  // 切换 tab / 改高度后，重新 fit + 聚焦当前 tab。
  useEffect(() => {
    if (!activeId) return;
    const inst = instancesRef.current.get(activeId);
    if (!inst || !inst.opened) return;
    const raf = requestAnimationFrame(() => {
      try { inst.fit.fit(); } catch { /* ignore */ }
      inst.term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeId, height, tabs.length]);

  const closeTab = useCallback((id: string) => {
    const inst = instancesRef.current.get(id);
    if (inst) {
      if (inst.termId) {
        terminalAPI.close(inst.termId).catch(() => {});
        byTermIdRef.current.delete(inst.termId);
      }
      try { inst.term.dispose(); } catch { /* ignore */ }
      instancesRef.current.delete(id);
    }
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        onClose();
        return next;
      }
      setActiveId((cur) => (cur === id ? next[next.length - 1].id : cur));
      return next;
    });
  }, [onClose]);

  // 重启激活 tab：关掉旧 PTY，清屏，开新 PTY（复用同一 tab 槽 / xterm）。
  const reloadActiveTab = useCallback(async () => {
    const id = activeId;
    const inst = instancesRef.current.get(id);
    if (!inst) return;
    if (inst.termId) {
      terminalAPI.close(inst.termId).catch(() => {});
      byTermIdRef.current.delete(inst.termId);
      inst.termId = '';
    }
    inst.term.options.disableStdin = false;
    inst.term.reset();
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, termId: '', status: 'connecting' } : t)));
    try {
      const res = await terminalAPI.open(inst.term.cols || 80, inst.term.rows || 24, muxIdRef.current, cwdRef.current);
      if (res.ok && res.termId) {
        registerTermId(id, res.termId, inst);
        setTabs((prev) => prev.map((t) => (t.id === id
          ? { ...t, termId: res.termId!, status: panelReadyRef.current ? 'ready' : 'connecting' }
          : t)));
      } else {
        setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'error' } : t)));
      }
    } catch {
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'error' } : t)));
    }
  }, [activeId, registerTermId]);

  // ── 顶边拖拽调高 ──
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: height };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - ev.clientY; // 往上拖 = 变高
      const next = Math.max(MIN_HEIGHT, Math.min(maxHeight(), dragRef.current.startH + delta));
      setHeight(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      try { window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(Math.round(heightRef.current))); } catch { /* ignore */ }
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [height]);

  // 拖拽结束时用最新 height 持久化。
  const heightRef = useRef(height);
  heightRef.current = height;

  if (!visible) return null;

  const statusLabel = (s: TabStatus) => (
    s === 'ready' ? '已连接'
    : s === 'connecting' ? '连接中…'
    : s === 'closed' ? '已结束'
    : '连接异常'
  );
  const activeTab = tabs.find((t) => t.id === activeId);
  const badgeStatus: TabStatus = activeTab
    ? (activeTab.status === 'ready' && panelStatus !== 'ready' ? 'connecting' : activeTab.status)
    : panelStatus;

  return (
    <div className={styles.shellTerminalPanel} style={{ height }}>
      <div className={styles.shellTerminalResizer} onMouseDown={onDragStart} title="拖拽调整高度" />
      <div className={styles.shellTerminalHeader}>
        <div className={styles.shellTerminalTabs}>
          <div className={styles.shellTerminalTitle}>
            <CodeOutlined />
            <span>终端</span>
            <span className={styles.shellTerminalStatus}>{statusLabel(badgeStatus)}</span>
          </div>
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`${styles.shellTerminalTab} ${t.id === activeId ? styles.shellTerminalTabActive : ''}`}
              onClick={() => setActiveId(t.id)}
              title={t.label}
            >
              <span
                className={styles.shellTerminalTabDot}
                data-status={t.status}
              />
              <span className={styles.shellTerminalTabLabel}>{t.label}</span>
              <span
                className={styles.shellTerminalTabClose}
                title="关闭此终端"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
              >
                <CloseOutlined />
              </span>
            </div>
          ))}
          <button
            type="button"
            className={styles.shellTerminalIconBtn}
            title="新建终端"
            onClick={() => { void createTab(); }}
          >
            <PlusOutlined />
          </button>
        </div>
        <div className={styles.shellTerminalActions}>
          <button
            type="button"
            className={styles.shellTerminalIconBtn}
            title="重启当前终端"
            onClick={() => { void reloadActiveTab(); }}
          >
            <ReloadOutlined />
          </button>
          <button
            type="button"
            className={styles.shellTerminalIconBtn}
            title="关闭终端面板"
            onClick={onClose}
          >
            <CloseOutlined />
          </button>
        </div>
      </div>
      <div className={styles.shellTerminalBodies}>
        {tabs.map((t) => (
          <div
            key={t.id}
            ref={attachBody(t.id)}
            className={styles.shellTerminalBody}
            style={{ display: t.id === activeId ? 'block' : 'none' }}
          />
        ))}
      </div>
    </div>
  );
}

export default ShellTerminalPanel;
