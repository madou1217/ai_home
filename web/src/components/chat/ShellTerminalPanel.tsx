import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { CloseOutlined, ReloadOutlined, CodeOutlined, PlusOutlined, MinusOutlined, ExpandOutlined, MenuFoldOutlined, AppstoreOutlined, LoadingOutlined } from '@ant-design/icons';
import { message } from 'antd';
import { terminalAPI } from '@/services/api';
import { createTerminalRefitter, fitActiveTerminal, TERMINAL_RESIZE_FINISHED } from './terminal-refit';
import { createTerminalResizeSender } from './terminal-resize-sender';
import { avoidDuplicateTerminalStyleWrites } from './terminal-render-styles';
import { useTerminalDockResize } from './use-terminal-dock-resize';
import { discardTerminalProtocolInput, enqueueTerminalInput, flushTerminalInput, isTerminalProtocolReply } from './terminal-input';
import type { TerminalInputState } from './terminal-input';
import { readTerminalTheme, subscribeTerminalTheme, TERMINAL_FONT_FAMILY } from './terminal-theme';
import styles from './composer/composer.module.css';
import TerminalSessionGallery from './TerminalSessionGallery';
import { createTerminalOutput } from './terminal-output';
import { createTerminalFocusSender } from './terminal-focus';
import { releaseOrphanedNativeAttachment } from './terminal-attachments';
import { createTerminalPendingOutput } from './terminal-pending-output';

interface ShellTerminalPanelProps {
  visible: boolean;
  onClose: (closedTargets?: ReadonlyArray<{ id: string; closeToken?: string }>) => void;
  /** Optional title shown in the panel chrome (for example the selected account/harness). */
  title?: string;
  // 当前项目路径：新开/重连终端时作为 shell 的 cwd，直接进入项目目录（而非 home）。
  cwd?: string;
  // 三栏嵌入模式：隐藏自带标题/状态文案与调高把手（栏工具行已表达面板语义，栏内充满即可）。
  compactChrome?: boolean;
  /** Keep the Server PTY alive while the page unmounts; a later mount attaches by key. */
  sessionKey?: string;
  persistent?: boolean;
  /** When true, keyed attach failures return as-is instead of falling back to opening a new plain shell. */
  strictExistingSession?: boolean;
  /** Controlled tabs used by the application-wide Web Terminal host. */
  sessionTabs?: Array<{
    id: string;
    sessionKey?: string;
    label: string;
    cwd?: string;
    persistent?: boolean;
    kind?: 'account-cli' | 'shell';
    closeToken?: string;
    initialCommand?: string;
  }>;
  activeTabId?: string;
  onActiveTabChange?: (id: string) => void;
  onTabClose?: (id: string, closeToken?: string) => void;
  /** Optional synchronous host authority validating whether a captured tab token is still live. */
  isSessionCurrent?: (id: string, closeToken?: string) => boolean;
  allowNewTab?: boolean;
  onNewTab?: () => void;
  creatingTab?: boolean;
  isCreatingTab?: () => boolean;
  layout?: 'tabs' | 'sidebar' | 'gallery';
  onLayoutChange?: (layout: 'tabs' | 'sidebar' | 'gallery') => void;
  minimized?: boolean;
  onMinimizedChange?: (value: boolean) => void;
  onHeaderPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  panelHeight?: number;
  /** When false, only focus xterm on explicit focusRequestSeq changes or tab selection. */
  autoFocus?: boolean;
  /** Monotonic counter incremented by the host on explicit open/restore actions. */
  focusRequestSeq?: number;
}

type TabStatus = 'connecting' | 'ready' | 'closed' | 'error';

interface TabMeta {
  id: string;
  termId: string;
  label: string;
  status: TabStatus;
}

type SessionTabDefinition = NonNullable<ShellTerminalPanelProps['sessionTabs']>[number];

interface TermInstance extends TerminalInputState {
  term: Terminal;
  fit: FitAddon;
  sessionKey: string;
  closeToken?: string;
  durable: boolean;
  exited: boolean;
  exitedTermId: string;
  restarting: boolean;
  opened: boolean;
  attachmentVersion: number;
  resizeSender: ReturnType<typeof createTerminalResizeSender>;
  output: ReturnType<typeof createTerminalOutput>;
  focusSender: ReturnType<typeof createTerminalFocusSender>;
  restoreRenderStyles?: () => void;
}

interface PendingCloseOp {
  opId: number;
  closeToken?: string;
  inst?: TermInstance;
}

const HEIGHT_STORAGE_KEY = 'aih:webui-terminal-height:v1';
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 300;
const CONNECTION_STOP_ERRORS = new Set([
  'terminal_not_found',
  'too_many_terminals',
  'unauthorized',
  'terminal_http_403',
  'native_session_attach_required',
  'terminal_identity_mismatch',
  'terminal_attachment_stale',
]);

function terminalConnectionFailure(error?: string) {
  return error === 'terminal_not_found'
    ? '原终端会话不存在或已结束；请重新启动原任务或终端。'
    : `终端连接失败: ${error || 'unknown'}`;
}

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
    disableStdin: false,
    // Keep long prompts and status lines as xterm soft wraps. The PTY still
    // receives the real column count on every fit, so shell redraws remain in
    // sync with Warp-style visual wrapping.
    reflowCursorLine: true,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 12,
    scrollback: 8000,
    // HUD 配色运行时读 CSS 变量（深色 = Void Black 底 + 青色光标），主题切换见下方订阅。
    theme: readTerminalTheme()
  });
}

// VSCode 风格底部终端「面板」：多 tab、可拖拽调高、底部停靠。
// 每个 tab = 独立 PTY + 独立 xterm；整个面板复用一条 mux SSE 承载全部 tab 输出（帧带 termId），
// 规避浏览器每域 ~6 连接上限（此前多 tab / 慢开会永远卡「连接中」的根因）。
function ShellTerminalPanel({
  visible,
  onClose,
  title = '终端',
  cwd,
  compactChrome = false,
  sessionKey = '',
  persistent = false,
  strictExistingSession = false,
  sessionTabs,
  activeTabId: controlledActiveTabId,
  onActiveTabChange,
  onTabClose,
  isSessionCurrent,
  allowNewTab = true,
  onNewTab,
  creatingTab = false,
  isCreatingTab,
  layout = 'tabs',
  onLayoutChange,
  minimized: controlledMinimized,
  onMinimizedChange,
  onHeaderPointerDown,
  panelHeight,
  autoFocus = true,
  focusRequestSeq
}: ShellTerminalPanelProps) {
  const muxIdRef = useRef<string>('');
  const connectionEpochRef = useRef(0);
  // 用 ref 持有最新 cwd：切项目后新开/重连的终端应进入新项目目录，避免闭包捕获旧值。
  const cwdRef = useRef<string | undefined>(cwd);
  cwdRef.current = cwd;
  const esRef = useRef<(EventSource & { setReadPaused?: (paused: boolean) => void }) | null>(null);
  const outputBlockedRef = useRef<Set<string>>(new Set());
  const setOutputBlocked = useCallback((id: string, blocked: boolean) => {
    if (blocked) outputBlockedRef.current.add(id); else outputBlockedRef.current.delete(id);
    esRef.current?.setReadPaused?.(outputBlockedRef.current.size > 0);
  }, []);
  const lastFocusedRef = useRef('');
  const lastFocusRequestSeqRef = useRef<number | undefined>(undefined);
  const userTabFocusRef = useRef(0);
  const lastUserTabFocusRef = useRef(0);
  const instancesRef = useRef<Map<string, TermInstance>>(new Map());
  const byTermIdRef = useRef<Map<string, string>>(new Map());
  const bodyNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const bodyRefCallbacksRef = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
  // termId -> 早到但还没建立 termId→tab 映射时缓存的帧（open 的 fetch 与 SSE 输出是两条通道，
  // PTY 的首个 prompt 可能先于 open 响应到达，若不缓存会被丢弃 → 终端空白）。
  const [pendingOutput] = useState(() => createTerminalPendingOutput((blocked) => setOutputBlocked('pending', blocked)));
  const tabSeqRef = useRef(0);
  const panelReadyRef = useRef(false);
  const recoverRef = useRef<(target?: TermInstance) => void>(() => {});
  const closeOpSeqRef = useRef(0);
  const closingOpsRef = useRef<Map<string, PendingCloseOp>>(new Map());
  const sessionTabsRef = useRef<SessionTabDefinition[] | undefined>(sessionTabs);
  sessionTabsRef.current = sessionTabs;
  const onTabCloseRef = useRef(onTabClose);
  onTabCloseRef.current = onTabClose;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const isCreatingTabRef = useRef(isCreatingTab);
  isCreatingTabRef.current = isCreatingTab;
  const isSessionCurrentRef = useRef(isSessionCurrent);
  isSessionCurrentRef.current = isSessionCurrent;

  const isClosingInstance = useCallback((id: string, inst?: TermInstance, closeToken?: string): boolean => {
    const op = closingOpsRef.current.get(id);
    if (!op) return false;
    if (closeToken !== undefined && op.closeToken !== undefined && op.closeToken !== closeToken) {
      return false;
    }
    if (inst !== undefined && op.inst !== undefined && op.inst !== inst) {
      return false;
    }
    return true;
  }, []);

  const releaseOwnCloseOp = useCallback((id: string, opId: number) => {
    if (closingOpsRef.current.get(id)?.opId === opId) {
      closingOpsRef.current.delete(id);
      setClosingCount(closingOpsRef.current.size);
    }
  }, []);

  const releaseLateAttachment = useCallback((result: { ok: boolean; termId?: string }, key: string, id: string, mux: string) => {
    const current = instancesRef.current.get(id);
    // A newer live attach may reuse this same mux/key client before its response
    // updates current.termId. Only protect an instance still authorized by host.
    const currentAuthorized = Boolean(
      current
      && (!isSessionCurrentRef.current || isSessionCurrentRef.current(id, current.closeToken)),
    );
    const reused = currentAuthorized
      && !isClosingInstance(id, current, current?.closeToken)
      && muxIdRef.current === mux
      && current?.sessionKey === key;
    releaseOrphanedNativeAttachment(result, key, reused, terminalAPI.close);
    if (!key && result.ok && result.termId && current?.termId !== result.termId) {
      void terminalAPI.close(result.termId).catch(() => {});
    }
  }, [isClosingInstance]);

  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const [panelStatus, setPanelStatus] = useState<TabStatus>('connecting');
  const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);
  const [internalMinimized, setInternalMinimized] = useState(false);
  const [closingCount, setClosingCount] = useState(0);
  const minimized = controlledMinimized ?? internalMinimized;
  const minimizedRef = useRef(minimized);
  minimizedRef.current = minimized;
  const flushInput = useCallback((inst: TermInstance) => {
    void flushTerminalInput(inst, terminalAPI.input, () => {
      if (Array.from(instancesRef.current.values()).includes(inst)) recoverRef.current(inst);
    }, () => {
      if (Array.from(instancesRef.current.values()).includes(inst)) {
        inst.term.writeln('\r\n\x1b[33m输入发送状态未知，请检查终端后再重试。\x1b[0m');
      }
    });
  }, []);
  // 最小化/恢复的高度过渡：动画期间暂停 ResizeObserver 的逐帧 fit（否则 xterm 会在
  // 每一帧里按新行数重排，画面抖动），结束后补一次 fit。折叠时正文延迟到动画结束再
  // display:none，让内容跟着面板一起被裁掉，而不是瞬间消失。
  const [heightAnimating, setHeightAnimating] = useState(false);
  const [bodiesHidden, setBodiesHidden] = useState(minimized);
  const animatingRef = useRef(false);
  // 关闭页签的退场：先给 chrome 一个 is-leaving 动画，元素从 tabs 里移除后仍渲染 160ms。
  const [leavingTabs, setLeavingTabs] = useState<TabMeta[]>([]);
  const previousTabsRef = useRef<TabMeta[]>([]);
  useEffect(() => {
    const previous = previousTabsRef.current;
    previousTabsRef.current = tabs;
    const current = new Set(tabs.map((tab) => tab.id));
    const removed = previous.filter((tab) => !current.has(tab.id));
    if (!removed.length) return;
    setLeavingTabs((list) => list.concat(removed.filter((tab) => !list.some((item) => item.id === tab.id))));
    const timer = setTimeout(() => {
      setLeavingTabs((list) => list.filter((item) => !removed.some((tab) => tab.id === item.id)));
    }, 170);
    return () => clearTimeout(timer);
  }, [tabs]);
  const minimizedMountedRef = useRef(false);
  useEffect(() => {
    // 首次挂载不做高度过渡：面板应按当前状态直接以目标高度出现。
    if (!minimizedMountedRef.current) {
      minimizedMountedRef.current = true;
      setBodiesHidden(minimized);
      return undefined;
    }
    // 恢复：正文立刻回来，面板高度一升上去内容就在；折叠：正文跟着高度动画一起被裁掉，
    // 动画结束后再 display:none（否则内容会先「啪」消失，只剩空壳在收缩）。
    animatingRef.current = minimized;
    setHeightAnimating(true);
    if (!minimized) setBodiesHidden(false);
    const timer = setTimeout(() => {
      animatingRef.current = false;
      setHeightAnimating(false);
      if (minimized) setBodiesHidden(true);
    }, 230);
    return () => {
      clearTimeout(timer);
      animatingRef.current = false;
      setHeightAnimating(false);
    };
  }, [minimized]);

  // 应用一帧（output/exit）到某个 tab 的 xterm。
  const applyFrame = useCallback((tabId: string, inst: TermInstance, msg: any) => {
    if (msg.type === 'output' && typeof msg.data === 'string') {
      inst.output.write(base64ToBytes(msg.data));
    } else if (msg.type === 'exit') {
      inst.exitedTermId = inst.termId;
      if (inst.restarting || isClosingInstance(tabId, inst, inst.closeToken)) return;
      inst.inputReady = false;
      inst.resizeSender.clear();
      if (inst.durable && inst.sessionKey) {
        // The exit belongs to the borrowed tmux client, not necessarily the
        // underlying task. Reattach the same session before declaring it dead.
        setTabs((prev) => prev.map((tab) => tab.id === tabId ? { ...tab, status: 'connecting' } : tab));
        const exitedClient = inst.termId;
        // A buffered exit can be drained inside an attach response. Wait until
        // that response releases its recovery guard before scheduling another.
        queueMicrotask(() => {
          if (instancesRef.current.get(tabId) === inst && inst.termId === exitedClient && !inst.inputReady) recoverRef.current(inst);
        });
        return;
      }
      inst.exited = true;
      inst.term.options.disableStdin = true;
      inst.output.write(new TextEncoder().encode('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n'));
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, status: 'closed' } : t)));
    }
  }, [isClosingInstance]);

  // 建立 termId→tab 映射，并回放这段时间内早到被缓存的帧（prompt 等）。
  const registerTermId = useCallback((tabId: string, termId: string, inst: TermInstance) => {
    if (inst.termId !== termId) discardTerminalProtocolInput(inst);
    inst.termId = termId;
    inst.exited = false;
    inst.term.options.disableStdin = false;
    inst.inputReady = panelReadyRef.current && inst.exitedTermId !== termId;
    byTermIdRef.current.set(termId, tabId);
    pendingOutput.drain(termId, (frame) => applyFrame(tabId, inst, frame));
    if (inst.exitedTermId === termId) {
      if (inst.durable && inst.sessionKey) {
        queueMicrotask(() => {
          if (instancesRef.current.get(tabId) === inst && inst.termId === termId && !inst.inputReady) recoverRef.current(inst);
        });
      } else {
        inst.exited = true;
        inst.term.options.disableStdin = true;
      }
    }
    if (inst.opened && activeIdRef.current === tabId) inst.resizeSender.enqueue(termId, inst.term.cols, inst.term.rows);
    flushInput(inst);
  }, [applyFrame, flushInput, pendingOutput]);

  const readClipboardImageDataUrl = useCallback((file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('terminal_image_read_failed'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  }), []);

  const pasteImageIntoActiveTerminal = useCallback(async (file: File) => {
    const tabId = activeIdRef.current;
    const inst = instancesRef.current.get(tabId);
    if (!inst) return;
    const definition = sessionTabsRef.current?.find((item) => item.id === tabId);
    const cwd = definition?.cwd ?? cwdRef.current;
    try {
      const dataUrl = await readClipboardImageDataUrl(file);
      if (instancesRef.current.get(tabId) !== inst) return;
      const result = await terminalAPI.pasteImage(
        inst.sessionKey,
        cwd,
        dataUrl
      );
      if (!result.ok || !result.path) {
        message.error(`图片粘贴失败: ${result.error || result.message || 'unknown'}`);
        return;
      }
      if (instancesRef.current.get(tabId) !== inst) {
        message.warning(`图片已保存，但原终端已关闭: ${result.path}`);
        return;
      }
      enqueueTerminalInput(inst, ` ${result.pasteText || result.path} `);
      flushInput(inst);
      if (activeIdRef.current === tabId) inst.term.focus();
    } catch (error) {
      message.error(`图片粘贴失败: ${String((error as Error)?.message || error)}`);
    }
  }, [flushInput, readClipboardImageDataUrl]);

  const handleTerminalPaste = useCallback((event: ClipboardEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('.xterm')) return;
    const files = Array.from(event.clipboardData?.files || []);
    const item = Array.from(event.clipboardData?.items || [])
      .find((candidate) => candidate.kind === 'file' && candidate.type.startsWith('image/'));
    const file = files.find((candidate) => candidate.type.startsWith('image/')) || item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    void pasteImageIntoActiveTerminal(file);
  }, [pasteImageIntoActiveTerminal]);

  // ── 打开一个新 tab（新 PTY + 新 xterm），共用面板的 muxId ──
  const createTab = useCallback(async (definition?: SessionTabDefinition) => {
    const id = String(definition?.id || `t-${(tabSeqRef.current += 1)}`);
    if (instancesRef.current.has(id)) return;
    const definitionCloseToken = definition?.closeToken;
    if (isSessionCurrentRef.current && !isSessionCurrentRef.current(id, definitionCloseToken)) {
      return;
    }
    const label = String(definition?.label || `终端 ${tabSeqRef.current}`);
    const tabSessionKey = String(definition?.sessionKey || sessionKey || '').trim();
    const tabCwd = definition?.cwd ?? cwdRef.current;
    const term = newTerm();
    const fit = new FitAddon();
    term.loadAddon(fit);
    const inst: TermInstance = { term, fit, termId: '', sessionKey: tabSessionKey, closeToken: definitionCloseToken, durable: false, exited: false, exitedTermId: '', restarting: false, opened: false, inputQueue: [], sending: false, inputReady: false, attachmentVersion: 0,
      resizeSender: createTerminalResizeSender(terminalAPI.resize),
      output: createTerminalOutput(term, () => activeIdRef.current === id && !document.hidden, (blocked) => setOutputBlocked(id, blocked)),
      focusSender: createTerminalFocusSender(terminalAPI.focus),
    };
    instancesRef.current.set(id, inst);

    term.attachCustomKeyEventHandler(() => activeIdRef.current === id && inst.inputReady && !document.hidden);

    term.onData((data) => {
      // User input is guarded by the active view. Protocol replies from a
      // preview (device status/capability queries) still reach its tmux client.
      // IME completion can arrive asynchronously after the view lost control.
      const protocol = isTerminalProtocolReply(data);
      if ((activeIdRef.current !== id || document.hidden) && !protocol) return;
      enqueueTerminalInput(inst, data, protocol);
      flushInput(inst);
    });
    term.onResize(({ cols, rows }) => {
      if (inst.termId && activeIdRef.current === id) inst.resizeSender.enqueue(inst.termId, cols, rows);
    });

    setTabs((prev) => [...prev.filter((tab) => tab.id !== id), { id, termId: '', label, status: 'connecting' }]);
    setActiveId((current) => current || id);

    const finishOpening = pendingOutput.begin(id);
    const version = ++inst.attachmentVersion;
    const openingMux = muxIdRef.current;
    const isControlledDefinitionCurrent = () => {
      if (!definition) return true;
      const currentDefinitions = sessionTabsRef.current;
      if (!currentDefinitions) return false;
      const liveDefinition = currentDefinitions.find((item) => item.id === id);
      if (!liveDefinition) return false;
      const liveKey = String(liveDefinition.sessionKey || sessionKey || '').trim();
      if (liveKey !== tabSessionKey) return false;
      if (definitionCloseToken !== undefined && liveDefinition.closeToken !== definitionCloseToken) return false;
      return true;
    };
    const isAuthorityCurrent = () => (
      !isSessionCurrentRef.current || isSessionCurrentRef.current(id, definitionCloseToken)
    );
    const isAttachmentAlive = () => (
      instancesRef.current.get(id) === inst
      && inst.attachmentVersion === version
      && !isClosingInstance(id, inst, definitionCloseToken)
      && Boolean(esRef.current && openingMux && muxIdRef.current === openingMux)
      && isControlledDefinitionCurrent()
      && isAuthorityCurrent()
    );
    try {
      let requestEpoch = connectionEpochRef.current;
      let previousResultId = '';
      const openOrAttach = async () => {
        requestEpoch = connectionEpochRef.current;
        if (!isAttachmentAlive()) return { ok: false, error: 'terminal_attachment_stale' };
        if (previousResultId) return terminalAPI.attach(tabSessionKey || previousResultId, openingMux);
        return (tabSessionKey
        ? (async () => {
          const attached = await terminalAPI.attach(tabSessionKey, openingMux);
          if (attached.ok) return attached;
          if (strictExistingSession) return attached;
          // A saved shell tab can outlive its server-side PTY after a restart.
          // Recreate only a plain shell; account/native sessions must retain
          // their original identity and must never fall back to an empty shell.
          if (definition?.sessionKey && (definition.kind !== 'shell' || tabSessionKey.startsWith('native:'))) return attached;
          if (attached.error !== 'terminal_not_found') return attached;
          // Revalidate exact instance identity, attachment version, controlled
          // definition, mux stream, live host authority, and connection epoch
          // synchronously BEFORE issuing the side-effectful fallback open.
          if (!isAttachmentAlive()) return { ok: false, error: 'terminal_attachment_stale' };
          if (requestEpoch !== connectionEpochRef.current) return { ok: false, error: 'terminal_connection_changed' };
          return terminalAPI.open(term.cols || 80, term.rows || 24, openingMux, tabCwd, tabSessionKey);
        })()
        : terminalAPI.open(term.cols || 80, term.rows || 24, openingMux, tabCwd));
      };
      let res = await openOrAttach();
      let attempts = 0;
      // Retrying an attach/keyed open is idempotent. An unkeyed open with a
      // lost response is ambiguous even if the stream changed in parallel.
      while (!CONNECTION_STOP_ERRORS.has(res.error || '') && Boolean(tabSessionKey || previousResultId || (res.ok && res.termId)) && (requestEpoch !== connectionEpochRef.current || !res.ok) && isAttachmentAlive()) {
        if (res.ok && res.termId) previousResultId = res.termId;
        await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** attempts++)));
        if (!isAttachmentAlive()) {
          releaseLateAttachment(res, tabSessionKey, id, openingMux);
          return;
        }
        res = await openOrAttach();
      }
      if (!isAttachmentAlive()) {
        releaseLateAttachment(res, tabSessionKey, id, openingMux);
        return;
      }
      if (requestEpoch !== connectionEpochRef.current && !CONNECTION_STOP_ERRORS.has(res.error || '')) res = { ok: false, error: 'terminal_connection_changed' };
      if (!res.ok || !res.termId) {
        term.writeln(`\x1b[31m${terminalConnectionFailure(res.error)}\x1b[0m`);
        setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'error' } : t)));
        return;
      }
      if (tabSessionKey && res.durable === false) {
        term.writeln('\x1b[33m当前服务器未提供持久终端后端，服务重启后此会话无法恢复。\x1b[0m');
      }
      inst.durable = res.durable === true;
      if (tabSessionKey.startsWith('native:') && res.cols && res.rows) term.resize(res.cols, res.rows);
      registerTermId(id, res.termId, inst);
      setTabs((prev) => prev.map((t) => (
        t.id === id
          ? { ...t, termId: res.termId!, status: inst.exited ? 'closed' : inst.inputReady ? 'ready' : 'connecting' }
          : t
      )));
      const initialCommand = String(definition?.initialCommand || '').trim();
      if (
        initialCommand
        && !previousResultId
        && !res.reused
        && definition?.kind === 'shell'
      ) {
        void terminalAPI.input(res.termId, `${initialCommand}\r`).catch(() => undefined);
      }
    } catch (error) {
      if (!isAttachmentAlive()) return;
      term.writeln(`\x1b[31m终端连接失败: ${String((error as Error)?.message || error)}\x1b[0m`);
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'error' } : t)));
    } finally { finishOpening(); }
  }, [flushInput, isClosingInstance, pendingOutput, persistent, registerTermId, releaseLateAttachment, sessionKey, setOutputBlocked, strictExistingSession]);

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
    let disposed = false;
    let connectedOnce = false;
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();
    const recoveries = new Map<TermInstance, { epoch: number; version: number }>();
    // EventSource 会自动重连，但服务端会在旧连接关闭时回收 mux。重连后的
    // connected 帧必须把持久 session 重新绑定到新的 mux，否则 shell 仍在运行，
    // 但后续输出会继续广播到已删除的旧 mux，表现为“终端还活着但页面没字”。
    const reattachPersistentTabs = (target?: TermInstance) => {
      if (disposed || !panelReadyRef.current) return;
      const definitions = sessionTabsRef.current;
      for (const [tabId, inst] of instancesRef.current) {
        if (
          (target && target !== inst)
          || !inst.termId
          || inst.exited
          || inst.restarting
          || isClosingInstance(tabId, inst, inst.closeToken)
          || (isSessionCurrentRef.current && !isSessionCurrentRef.current(tabId, inst.closeToken))
        ) {
          continue;
        }
        const epoch = connectionEpochRef.current;
        const pending = recoveries.get(inst);
        if (pending?.epoch === epoch && pending.version === inst.attachmentVersion) continue;
        const previousTermId = inst.termId;
        const definition = definitions?.find((item) => item.id === tabId);
        const key = String(definition?.sessionKey || inst.sessionKey || sessionKey || previousTermId).trim();
        const attachmentMux = muxIdRef.current;
        const version = ++inst.attachmentVersion;
        const recovery = { epoch, version };
        recoveries.set(inst, recovery);
        inst.inputReady = false;
        discardTerminalProtocolInput(inst);
        const finishRecovery = () => { if (recoveries.get(inst) === recovery) recoveries.delete(inst); };
        const isRecoveryCurrent = () => (
          !disposed
          && connectionEpochRef.current === epoch
          && instancesRef.current.get(tabId) === inst
          && inst.attachmentVersion === version
          && !isClosingInstance(tabId, inst, inst.closeToken)
          && (!isSessionCurrentRef.current || isSessionCurrentRef.current(tabId, inst.closeToken))
        );
        const retry = () => {
          if (!isRecoveryCurrent()) {
            finishRecovery();
            return;
          }
          const timer = setTimeout(() => { retryTimers.delete(timer); attach(); }, 3000);
          retryTimers.add(timer);
        };
        const attach = () => {
          if (!panelReadyRef.current || !isRecoveryCurrent()) {
            finishRecovery();
            return;
          }
          const requestEpoch = connectionEpochRef.current;
          const finishAttaching = pendingOutput.begin(tabId);
          void terminalAPI.attach(key, attachmentMux).then((attached) => {
            if (!isRecoveryCurrent() || requestEpoch !== connectionEpochRef.current) {
              releaseLateAttachment(attached, key, tabId, attachmentMux);
              finishRecovery();
              return;
            }
            if (!attached.ok || !attached.termId) {
              if (CONNECTION_STOP_ERRORS.has(attached.error || '')) {
                inst.exited = attached.error === 'terminal_not_found';
                if (inst.exited) inst.inputQueue = [];
                inst.term.options.disableStdin = true;
                inst.term.writeln(`\r\n\x1b[31m${terminalConnectionFailure(attached.error)}\x1b[0m`);
                setTabs((prev) => prev.map((tab) => tab.id === tabId ? { ...tab, status: inst.exited ? 'closed' : 'error' } : tab));
                finishRecovery();
              } else {
                setTabs((prev) => prev.map((tab) => tab.id === tabId ? { ...tab, status: 'connecting' } : tab));
                retry();
              }
              return;
            }
            if (inst.termId !== attached.termId) {
              pendingOutput.retire(inst.termId);
              byTermIdRef.current.delete(inst.termId);
            }
            inst.durable = attached.durable === true;
            registerTermId(tabId, attached.termId, inst);
            setTabs((prev) => prev.map((tab) => tab.id === tabId
              ? { ...tab, termId: attached.termId!, status: inst.exited ? 'closed' : inst.inputReady ? 'ready' : 'connecting' }
              : tab));
            finishRecovery();
          }).catch(retry).finally(finishAttaching);
        };
        attach();
      }
    };
    recoverRef.current = reattachPersistentTabs;
    es.onerror = () => {
      connectionEpochRef.current += 1;
      panelReadyRef.current = false;
      pendingOutput.clearFrames();
      for (const inst of instancesRef.current.values()) inst.inputReady = false;
      setPanelStatus('connecting');
      setTabs((prev) => prev.map((tab) => tab.status === 'ready' ? { ...tab, status: 'connecting' } : tab));
    };
    es.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'connected') {
        if (connectedOnce) connectionEpochRef.current += 1;
        connectedOnce = true;
        panelReadyRef.current = true;
        setPanelStatus('ready');
        reattachPersistentTabs();
        return;
      }
      const termId = msg.termId ? String(msg.termId) : '';
      const tabId = termId ? byTermIdRef.current.get(termId) : '';
      if (!tabId) {
        // 映射还没建立（output 先于 open 响应到达）→ 缓存，registerTermId 时回放。
        if (termId) pendingOutput.push(termId, msg);
        return;
      }
      const inst = instancesRef.current.get(tabId);
      if (!inst) return;
      applyFrame(tabId, inst, msg);
    };

    setHeight(readStoredHeight());
    const definitions = sessionTabsRef.current;
    if (definitions?.length) {
      for (const definition of definitions) void createTab(definition);
    } else {
      void createTab();
    }

    return () => {
      disposed = true;
      connectionEpochRef.current += 1;
      recoverRef.current = () => {};
      for (const timer of retryTimers) clearTimeout(timer);
      try { es.close(); } catch { /* ignore */ }
      esRef.current = null;
      for (const inst of instancesRef.current.values()) {
        inst.inputReady = false;
        inst.inputQueue = [];
        if (inst.termId && !persistent) terminalAPI.close(inst.termId).catch(() => {});
        inst.resizeSender.dispose();
        inst.focusSender.dispose(inst.sessionKey.startsWith('native:') ? inst.termId : '');
        inst.output.dispose();
        inst.restoreRenderStyles?.();
        try { inst.term.dispose(); } catch { /* ignore */ }
      }
      instancesRef.current.clear();
      closingOpsRef.current.clear();
      outputBlockedRef.current.clear();
      byTermIdRef.current.clear();
      bodyNodesRef.current.clear();
      bodyRefCallbacksRef.current.clear();
      pendingOutput.clear();
      muxIdRef.current = '';
      panelReadyRef.current = false;
      setClosingCount(0);
      setTabs([]);
      setActiveId('');
      tabSeqRef.current = 0;
    };
  }, [createTab, flushInput, isClosingInstance, pendingOutput, persistent, releaseLateAttachment, sessionKey, visible]);

  useEffect(() => {
    if (controlledActiveTabId && controlledActiveTabId !== activeId && tabs.some((tab) => tab.id === controlledActiveTabId)) {
      setActiveId(controlledActiveTabId);
    }
  }, [activeId, controlledActiveTabId, tabs]);

  const openOrAttachInstanceDom = useCallback((inst: TermInstance, el: HTMLDivElement) => {
    if (!inst.opened) {
      inst.term.open(el);
      if (inst.term.element) inst.restoreRenderStyles = avoidDuplicateTerminalStyleWrites(inst.term.element);
      inst.opened = true;
    } else if (inst.term.element && inst.term.element.parentElement !== el) {
      el.appendChild(inst.term.element);
    }
  }, []);

  // 挂载 xterm 到激活 tab 的容器（按 tab 缓存稳定 ref 回调，隐藏 tab 延迟到首次激活再 open）。
  const attachBody = useCallback((id: string) => {
    let cb = bodyRefCallbacksRef.current.get(id);
    if (!cb) {
      cb = (el: HTMLDivElement | null) => {
        if (!el) {
          bodyNodesRef.current.delete(id);
          return;
        }
        bodyNodesRef.current.set(id, el);
        const inst = instancesRef.current.get(id);
        if (!inst) return;
        if (activeIdRef.current !== id || minimizedRef.current) return;
        openOrAttachInstanceDom(inst, el);
        if (!document.hidden) {
          requestAnimationFrame(() => {
            if (minimizedRef.current || document.hidden || activeIdRef.current !== id) return;
            fitActiveTerminal(instancesRef.current, id);
          });
        }
      };
      bodyRefCallbacksRef.current.set(id, cb);
    }
    return cb;
  }, [openOrAttachInstanceDom]);

  const attachGalleryBody = useCallback((id: string, el: HTMLDivElement, active: boolean) => {
    const inst = instancesRef.current.get(id);
    if (!inst) return;
    openOrAttachInstanceDom(inst, el);
    inst.term.options.disableStdin = !inst.inputReady;
    inst.term.textarea?.setAttribute('tabindex', active ? '0' : '-1');
    inst.term.options.cursorBlink = active;
    if (active && !minimizedRef.current && !document.hidden) requestAnimationFrame(() => {
      if (minimizedRef.current || document.hidden || activeIdRef.current !== id) return;
      fitActiveTerminal(instancesRef.current, id);
      inst.output.flush();
    });
  }, [openOrAttachInstanceDom]);

  // 主题（深色 HUD / 日光 HUD）切换时，所有已打开 tab 的 xterm 画布同步换色。
  useEffect(() => subscribeTerminalTheme((theme) => {
    for (const inst of instancesRef.current.values()) {
      inst.term.options.theme = theme;
    }
  }), []);

  // 切换 tab 或布局时重新适配并聚焦；尺寸变化交给 ResizeObserver，避免抢走调整手柄或宿主页焦点。
  useEffect(() => {
    for (const [id, instance] of instancesRef.current) {
      const foreground = id === activeId && !minimized && !document.hidden;
      instance.term.options.disableStdin = !instance.inputReady;
      instance.term.textarea?.setAttribute('tabindex', foreground ? '0' : '-1');
      instance.term.options.cursorBlink = foreground;
      if (instance.termId && instance.sessionKey.startsWith('native:')) instance.focusSender.setActive(instance.termId, foreground);
    }
    if (!activeId || minimized) return;
    const inst = instancesRef.current.get(activeId);
    if (!inst) return;
    if (layout !== 'gallery') {
      const mountEl = bodyNodesRef.current.get(activeId);
      if (mountEl) openOrAttachInstanceDom(inst, mountEl);
    }
    if (!inst.opened) return;
    const raf = requestAnimationFrame(() => {
      if (minimizedRef.current || document.hidden || activeIdRef.current !== activeId) return;
      fitActiveTerminal(instancesRef.current, activeId);
      const explicitSeq = Boolean(
        focusRequestSeq !== undefined
        && focusRequestSeq > 0
        && focusRequestSeq !== lastFocusRequestSeqRef.current,
      );
      const explicitTabClick = userTabFocusRef.current !== lastUserTabFocusRef.current;
      const shouldFocus = explicitSeq || explicitTabClick || (autoFocus && lastFocusedRef.current !== activeId);
      if (shouldFocus) {
        lastFocusedRef.current = activeId;
        if (focusRequestSeq !== undefined) lastFocusRequestSeqRef.current = focusRequestSeq;
        lastUserTabFocusRef.current = userTabFocusRef.current;
        inst.term.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [activeId, autoFocus, focusRequestSeq, layout, minimized, openOrAttachInstanceDom, tabs]);

  useEffect(() => {
    const resume = () => {
      for (const [id, inst] of instancesRef.current) {
        const active = id === activeIdRef.current && !minimizedRef.current && !document.hidden;
        if (inst.termId && inst.sessionKey.startsWith('native:')) inst.focusSender.setActive(inst.termId, active);
        inst.term.options.disableStdin = !inst.inputReady;
        if (active) { fitActiveTerminal(instancesRef.current, id); inst.output.flush(); }
      }
    };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, []);

  // 三栏分隔条拖拽/窗口缩放只改容器宽度，上面的 effect 感知不到 → 换行宽度滞后。
  // 用 ResizeObserver 合并容器变化并限制重排频率；拖拽结束立即补齐最终尺寸。
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const gestureHost = el.closest('.global-web-terminal-window');
    const refitter = createTerminalRefitter(() => {
      if (minimizedRef.current || document.hidden) return;
      fitActiveTerminal(instancesRef.current, activeIdRef.current);
    }, undefined, undefined, {
      minInterval: () => 64,
      afterFlush: () => instancesRef.current.get(activeIdRef.current)?.resizeSender.flush(),
    });
    const observer = new ResizeObserver(() => {
      // 高度过渡或隐藏/最小化期间不做逐帧 fit，避免无意义重排。
      if (animatingRef.current || minimizedRef.current || document.hidden) return;
      refitter.notifyResize();
    });
    const finishResize = () => refitter.flush();
    gestureHost?.addEventListener(TERMINAL_RESIZE_FINISHED, finishResize);
    el.addEventListener(TERMINAL_RESIZE_FINISHED, finishResize);
    observer.observe(el);
    return () => {
      observer.disconnect();
      gestureHost?.removeEventListener(TERMINAL_RESIZE_FINISHED, finishResize);
      el.removeEventListener(TERMINAL_RESIZE_FINISHED, finishResize);
      refitter.dispose();
    };
  }, [visible, layout]);

  // xterm owns its hidden textarea and may stop bubbling paste events. Capture
  // at the panel boundary so image clipboard items are intercepted before
  // xterm's text-paste handler; normal text pastes are left untouched.
  useEffect(() => {
    const panel = panelRef.current;
    if (!visible || !panel) return;
    const guard = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-terminal-tab]') : null;
      if (!target || target.getAttribute('data-terminal-tab') === activeIdRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['beforeinput', 'input', 'paste', 'compositionstart', 'compositionupdate', 'compositionend', 'drop'];
    for (const name of events) panel.addEventListener(name, guard, true);
    return () => { for (const name of events) panel.removeEventListener(name, guard, true); };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const panel = panelRef.current;
    if (!panel) return;
    panel.addEventListener('paste', handleTerminalPaste, true);
    return () => panel.removeEventListener('paste', handleTerminalPaste, true);
  }, [handleTerminalPaste, visible]);

  const closeTab = useCallback(async (
    id: string,
    closeLast = true,
    notifyParent = true,
    explicitCloseToken?: string,
  ): Promise<boolean> => {
    if (isCreatingTabRef.current?.()) return false;
    const inst = instancesRef.current.get(id);
    const matchedTab = sessionTabsRef.current?.find((tab) => tab.id === id);
    const capturedCloseToken = explicitCloseToken ?? inst?.closeToken ?? matchedTab?.closeToken;
    if (isClosingInstance(id, inst, capturedCloseToken)) return false;
    // Synchronously verify live host authority before issuing terminalAPI.close
    // or mutating local instance/tab state.
    if (isSessionCurrentRef.current && !isSessionCurrentRef.current(id, capturedCloseToken)) {
      return false;
    }
    const opId = ++closeOpSeqRef.current;
    closingOpsRef.current.set(id, { opId, closeToken: capturedCloseToken, inst });
    setClosingCount(closingOpsRef.current.size);
    if (inst) inst.attachmentVersion += 1;
    const key = inst?.sessionKey || matchedTab?.sessionKey || '';
    const isCloseStillAuthorized = () => (
      instancesRef.current.get(id) === inst
      && (!inst || capturedCloseToken === undefined || inst.closeToken === capturedCloseToken)
      && (!isSessionCurrentRef.current || isSessionCurrentRef.current(id, capturedCloseToken))
    );
    if (inst?.termId || (key && !key.startsWith('native:'))) {
      const result = await terminalAPI.close(inst?.termId || '', key);
      if (!isCloseStillAuthorized()) {
        releaseOwnCloseOp(id, opId);
        return false;
      }
      if (!result.ok) {
        releaseOwnCloseOp(id, opId);
        message.error(`关闭终端失败: ${result.error || 'unknown'}`);
        return false;
      }
    }
    // Pre-dispose synchronous authority gate: never dispose local xterm or
    // remove tabs if the captured close token was invalidated while pending.
    if (!isCloseStillAuthorized()) {
      releaseOwnCloseOp(id, opId);
      return false;
    }
    if (inst) {
      inst.inputReady = false;
      inst.inputQueue = [];
      pendingOutput.cancel(id);
      if (inst.termId) {
        pendingOutput.retire(inst.termId);
        byTermIdRef.current.delete(inst.termId);
      }
      inst.resizeSender.dispose();
      inst.focusSender.dispose(inst.sessionKey.startsWith('native:') ? inst.termId : '');
      inst.output.dispose();
      inst.restoreRenderStyles?.();
      try { inst.term.dispose(); } catch { /* ignore */ }
      instancesRef.current.delete(id);
    }
    bodyNodesRef.current.delete(id);
    bodyRefCallbacksRef.current.delete(id);
    const isLast = instancesRef.current.size === 0;
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) return next;
      const nextActiveId = next.find((tab) => tab.id === activeIdRef.current)?.id || next[next.length - 1].id;
      setActiveId((cur) => (cur === id ? nextActiveId : cur));
      return next;
    });
    if (notifyParent) {
      if (onTabCloseRef.current) onTabCloseRef.current(id, capturedCloseToken);
      else if (isLast && closeLast) onCloseRef.current();
    }
    releaseOwnCloseOp(id, opId);
    return true;
  }, [isClosingInstance, pendingOutput, releaseOwnCloseOp]);

  // Detach a controlled persistent tab locally when the parent removes it from
  // sessionTabs or advances its closeToken (for example virtual power-off,
  // same-tick OFF -> ON handoff, or route filtering) without sending
  // terminalAPI.close or remounting sibling tabs.
  const detachTabLocally = useCallback((
    id: string,
    options?: { expectedInst?: TermInstance; forceIfTokenMismatch?: string },
  ) => {
    const pendingOp = closingOpsRef.current.get(id);
    if (pendingOp) {
      const supersededByNewToken = Boolean(
        options?.forceIfTokenMismatch !== undefined
        && pendingOp.closeToken !== options.forceIfTokenMismatch,
      );
      const invalidatedByAuthority = Boolean(
        isSessionCurrentRef.current
        && !isSessionCurrentRef.current(id, pendingOp.closeToken),
      );
      if (!supersededByNewToken && !invalidatedByAuthority) return;
      closingOpsRef.current.delete(id);
      setClosingCount(closingOpsRef.current.size);
    }
    const inst = instancesRef.current.get(id);
    if (options?.expectedInst && inst !== options.expectedInst) return;
    if (inst) {
      inst.attachmentVersion += 1;
      inst.inputReady = false;
      inst.inputQueue = [];
      pendingOutput.cancel(id);
      if (inst.termId) {
        pendingOutput.retire(inst.termId);
        byTermIdRef.current.delete(inst.termId);
      }
      inst.resizeSender.dispose();
      inst.focusSender.dispose(inst.sessionKey.startsWith('native:') ? inst.termId : '');
      inst.output.dispose();
      inst.restoreRenderStyles?.();
      try { inst.term.dispose(); } catch { /* ignore */ }
      instancesRef.current.delete(id);
    }
    bodyNodesRef.current.delete(id);
    bodyRefCallbacksRef.current.delete(id);
    if (lastFocusedRef.current === id) lastFocusedRef.current = '';
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === prev.length) return prev;
      if (next.length > 0) {
        const nextActiveId = next.find((tab) => tab.id === activeIdRef.current)?.id || next[next.length - 1].id;
        setActiveId((cur) => (cur === id ? nextActiveId : cur));
      } else {
        setActiveId('');
      }
      return next;
    });
  }, [pendingOutput]);

  // The global host is controlled by the application root. New account launches
  // append definitions here without remounting the xterm panel or losing old tabs.
  // When an admitted definition carries a new closeToken/sessionKey for an
  // existing id (e.g. same-tick OFF -> ON while siblings keep the panel mounted),
  // detach only the superseded local instance (NO terminalAPI.close) and attach
  // the new live identity immediately.
  useEffect(() => {
    if (!visible || !sessionTabs?.length || !esRef.current) return;
    const wanted = new Set(sessionTabs.map((definition) => definition.id));
    for (const tab of tabs) {
      // The parent already changed its definitions. Viewer cleanup is not a
      // second user request to delete a saved task, even if it reappeared.
      if (!wanted.has(tab.id)) {
        if (persistent) detachTabLocally(tab.id);
        else void closeTab(tab.id, false, false);
      }
    }
    for (const definition of sessionTabs) {
      const existing = instancesRef.current.get(definition.id);
      const nextKey = String(definition.sessionKey || sessionKey || '').trim();
      const incarnationChanged = Boolean(
        existing
        && (
          (definition.closeToken !== undefined && existing.closeToken !== definition.closeToken)
          || (Boolean(definition.sessionKey) && existing.sessionKey !== nextKey)
        ),
      );
      if (incarnationChanged && existing) {
        detachTabLocally(definition.id, {
          expectedInst: existing,
          forceIfTokenMismatch: definition.closeToken,
        });
      }
      if (
        !instancesRef.current.has(definition.id)
        && !isClosingInstance(definition.id, undefined, definition.closeToken)
      ) {
        void createTab(definition);
      }
    }
  }, [closeTab, closingCount, createTab, creatingTab, detachTabLocally, isClosingInstance, persistent, sessionKey, sessionTabs, tabs, visible]);

  // 关闭面板：先确认所有 PTY 关闭成功，再播一次收起动画（高度归零 + 淡出）并通知父级卸载。
  // 浮窗宿主自己有更完整的 FLIP 收起（GlobalWebTerminalHost），这里只覆盖停靠在输入框上的形态。
  const [closing, setClosing] = useState(false);
  const closePanel = useCallback(async () => {
    if (closing || isCreatingTabRef.current?.()) return;
    const capturedIds = Array.from(new Set([
      ...instancesRef.current.keys(),
      ...(sessionTabsRef.current || []).map((tab) => tab.id),
    ]));
    const capturedTargets = capturedIds.map((id) => ({
      id,
      closeToken: instancesRef.current.get(id)?.closeToken
        ?? sessionTabsRef.current?.find((tab) => tab.id === id)?.closeToken,
    }));
    const results = await Promise.all(
      capturedTargets.map((target) => closeTab(target.id, false, true, target.closeToken)),
    );
    if (!results.every(Boolean)) return;
    if (onTabCloseRef.current) {
      // Each captured target has already been settled via onTabClose with its
      // exact closeToken; forward only those captured targets so any tab added
      // concurrently during async close is never closed.
      onCloseRef.current(capturedTargets);
      return;
    }
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !visible || persistent) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    window.setTimeout(() => { setClosing(false); onCloseRef.current(); }, 180);
  }, [closeTab, closing, persistent, visible]);

  // 重启激活 tab：关掉旧 PTY，清屏，开新 PTY（复用同一 tab 槽 / xterm）。
  const reloadActiveTab = useCallback(async () => {
    const id = activeId;
    const inst = instancesRef.current.get(id);
    if (!inst || inst.restarting) return;
    if (isSessionCurrentRef.current && !isSessionCurrentRef.current(id, inst.closeToken)) return;
    inst.restarting = true;
    inst.exited = false;
    const version = ++inst.attachmentVersion;
    const attachmentMux = muxIdRef.current;
    const requestEpoch = connectionEpochRef.current;
    const isCurrent = () => (
      instancesRef.current.get(id) === inst
      && inst.attachmentVersion === version
      && (!isSessionCurrentRef.current || isSessionCurrentRef.current(id, inst.closeToken))
    );
    const finishReloading = pendingOutput.begin(id);
    try {
      if (inst.sessionKey.startsWith('native:')) {
        inst.inputReady = false;
        setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, status: 'connecting' } : tab));
        const result = await terminalAPI.attach(inst.sessionKey, attachmentMux);
        if (!isCurrent() || requestEpoch !== connectionEpochRef.current) {
          releaseLateAttachment(result, inst.sessionKey, id, attachmentMux);
          inst.restarting = false;
          if (isCurrent() && panelReadyRef.current) recoverRef.current(inst);
          return;
        }
        if (result.ok && result.termId) {
          if (inst.termId !== result.termId) {
            pendingOutput.retire(inst.termId);
            byTermIdRef.current.delete(inst.termId);
          }
          inst.restarting = false;
          inst.durable = result.durable === true;
          registerTermId(id, result.termId, inst);
          setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, termId: result.termId!, status: inst.exited ? 'closed' : inst.inputReady ? 'ready' : 'connecting' } : tab));
        } else {
          setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, status: 'error' } : tab));
          message.error(`重新连接失败: ${result.error || 'unknown'}`);
        }
        return;
      }
      if (inst.termId || inst.sessionKey) {
        const result = await terminalAPI.close(inst.termId, inst.sessionKey);
        if (!isCurrent()) return;
        if (!result.ok) {
          message.error(`重启终端失败: ${result.error || 'unknown'}`);
          return;
        }
        pendingOutput.retire(inst.termId);
        byTermIdRef.current.delete(inst.termId);
        inst.termId = '';
        inst.resizeSender.clear();
      }
      inst.inputReady = false;
      inst.inputQueue = [];
      inst.term.options.disableStdin = false;
      inst.term.reset();
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, termId: '', status: 'connecting' } : t)));
      try {
        const currentDefinition = sessionTabsRef.current?.find((definition) => definition.id === id);
        const currentSessionKey = String(currentDefinition?.sessionKey || sessionKey || '').trim();
        const res = currentSessionKey
          ? await terminalAPI.open(inst.term.cols || 80, inst.term.rows || 24, attachmentMux, currentDefinition?.cwd || cwdRef.current, currentSessionKey)
          : await terminalAPI.open(inst.term.cols || 80, inst.term.rows || 24, attachmentMux, cwdRef.current);
        if (!isCurrent()) {
          releaseLateAttachment(res, currentSessionKey, id, attachmentMux);
          return;
        }
        if (res.ok && res.termId) {
          inst.restarting = false;
          inst.durable = res.durable === true;
          if (requestEpoch !== connectionEpochRef.current) {
            inst.termId = res.termId;
            if (panelReadyRef.current) recoverRef.current(inst);
            return;
          }
          registerTermId(id, res.termId, inst);
          setTabs((prev) => prev.map((t) => (t.id === id
            ? { ...t, termId: res.termId!, status: inst.exited ? 'closed' : inst.inputReady ? 'ready' : 'connecting' }
            : t)));
        } else {
          setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'error' } : t)));
        }
      } catch {
        if (isCurrent()) setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'error' } : t)));
      }
    } finally {
      inst.restarting = false;
      finishReloading();
    }
  }, [activeId, pendingOutput, registerTermId, releaseLateAttachment, sessionKey]);

  const panelStyleHeight = minimized ? '38px' : (panelHeight !== undefined ? '100%' : `${height}px`);
  const commitDockHeight = useCallback((next: number) => {
    setHeight(next);
    try { window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(Math.round(next))); } catch { /* ignore */ }
  }, []);
  const dockResize = useTerminalDockResize(panelRef, height, panelStyleHeight,
    visible && !minimized && !compactChrome && panelHeight === undefined,
    MIN_HEIGHT, maxHeight, commitDockHeight);

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
  const tabList = tabs.map((t) => (
    <div
      key={t.id}
      data-terminal-tab="true"
      role="tab"
      tabIndex={0}
      aria-selected={t.id === activeId}
      className={`${styles.shellTerminalTab} ${t.id === activeId ? styles.shellTerminalTabActive : ''}`}
      onClick={() => {
        userTabFocusRef.current += 1;
        setActiveId(t.id);
        onActiveTabChange?.(t.id);
        if (t.id === activeId && !minimized && !document.hidden) {
          lastUserTabFocusRef.current = userTabFocusRef.current;
          instancesRef.current.get(t.id)?.term.focus();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          userTabFocusRef.current += 1;
          setActiveId(t.id);
          onActiveTabChange?.(t.id);
          if (t.id === activeId && !minimized && !document.hidden) {
            lastUserTabFocusRef.current = userTabFocusRef.current;
            instancesRef.current.get(t.id)?.term.focus();
          }
        }
      }}
      title={t.label}
    >
      <span className={styles.shellTerminalTabDot} data-status={t.status} />
      <span className={styles.shellTerminalTabLabel}>{t.label}</span>
      <button type="button" className={styles.shellTerminalTabClose} aria-label={`关闭 ${t.label}`} title={creatingTab ? '正在新建终端' : '关闭此终端'} disabled={creatingTab || closingOpsRef.current.has(t.id)} onClick={(event) => { event.stopPropagation(); void closeTab(t.id); }}>
        <CloseOutlined />
      </button>
    </div>
  ));

  return (
    <div
      ref={panelRef}
      className={`${styles.shellTerminalPanel}${heightAnimating ? ` ${styles.shellTerminalPanelAnimating}` : ''}${closing ? ` ${styles.shellTerminalPanelClosing}` : ''}`}
      style={{ height: panelStyleHeight }}
      data-compact={compactChrome ? 'true' : undefined}
    >
      {/* 嵌入栏内时高度由栏布局接管（100%），隐藏底部停靠场景的调高把手。 */}
      {compactChrome || panelHeight !== undefined ? null : (
        <div
          className={styles.shellTerminalResizer}
          onPointerDown={dockResize.onPointerDown}
          role="separator"
          tabIndex={0}
          aria-label="调整终端高度（方向键调整，Shift 加速）"
          aria-orientation="horizontal"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={Math.max(MIN_HEIGHT, maxHeight())}
          aria-valuenow={Math.min(height, Math.max(MIN_HEIGHT, maxHeight()))}
          title="拖拽调整高度"
          onKeyDown={(event) => {
            const direction = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
            if (!direction) return;
            event.preventDefault();
            dockResize.resizeWithKeyboard(direction * (event.shiftKey ? 48 : 12));
          }}
        />
      )}
      <div className={styles.shellTerminalHeader} onPointerDown={onHeaderPointerDown} data-draggable={onHeaderPointerDown ? true : undefined}>
        <div className={styles.shellTerminalTabs}>
          {compactChrome ? null : (
            <div className={styles.shellTerminalTitle}>
              <CodeOutlined />
              <span>{title}</span>
              <span className={styles.shellTerminalStatus} data-status={badgeStatus}>{statusLabel(badgeStatus)}</span>
            </div>
          )}
          {layout === 'tabs' ? tabList : null}
          {/* 已关闭的页签在 tabs 里消失后仍渲染 170ms，播放宽度收拢的退场动画。 */}
          {layout === 'tabs' ? leavingTabs.map((t) => (
            <div
              key={`leaving-${t.id}`}
              aria-hidden="true"
              className={`${styles.shellTerminalTab} ${styles.shellTerminalTabLeaving}`}
              title={t.label}
            >
              <span className={styles.shellTerminalTabDot} data-status={t.status} />
              <span className={styles.shellTerminalTabLabel}>{t.label}</span>
            </div>
          )) : null}
          <button
            type="button"
            className={styles.shellTerminalIconBtn}
            title={creatingTab ? '正在新建终端' : '新建终端'}
            aria-label="新建终端"
            aria-busy={creatingTab}
            disabled={creatingTab || closingCount > 0}
            onClick={() => { if (closingOpsRef.current.size) return; if (onNewTab) onNewTab(); else void createTab(); }}
            style={allowNewTab && !sessionKey ? undefined : { display: 'none' }}
          >
            {creatingTab ? <LoadingOutlined /> : <PlusOutlined />}
          </button>
        </div>
        <div className={styles.shellTerminalActions}>
          {onLayoutChange ? (
            <button type="button" className={styles.shellTerminalIconBtn} title="切换终端布局" aria-label="切换终端布局" onClick={() => onLayoutChange(layout === 'gallery' ? 'tabs' : layout === 'tabs' ? 'sidebar' : 'gallery')}>
              {layout === 'tabs' ? <MenuFoldOutlined /> : <AppstoreOutlined />}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.shellTerminalIconBtn}
            title={sessionTabs?.find((definition) => definition.id === activeId)?.sessionKey?.startsWith('native:') ? '重新连接当前会话' : '重启当前终端'}
            disabled={creatingTab || closingCount > 0 || (sessionTabs?.find((definition) => definition.id === activeId)?.kind === 'account-cli' && !sessionTabs?.find((definition) => definition.id === activeId)?.sessionKey?.startsWith('native:'))}
            onClick={() => { void reloadActiveTab(); }}
          >
            <ReloadOutlined />
          </button>
          <button
            type="button"
            className={styles.shellTerminalIconBtn}
            title={minimized ? '恢复终端面板' : '最小化终端面板'}
            style={compactChrome && controlledMinimized !== undefined && !onMinimizedChange ? { display: 'none' } : undefined}
            onClick={() => {
              const next = !minimized;
              if (onMinimizedChange) onMinimizedChange(next);
              else setInternalMinimized(next);
            }}
          >
            {minimized ? <ExpandOutlined /> : <MinusOutlined />}
          </button>
          <button
            type="button"
            className={styles.shellTerminalIconBtn}
            title="关闭终端面板"
            disabled={creatingTab || closingCount > 0}
            onClick={() => { void closePanel(); }}
          >
            <CloseOutlined />
          </button>
        </div>
      </div>
      <div className={styles.shellTerminalContent} style={{ display: bodiesHidden ? 'none' : undefined }}>
        {layout === 'gallery' ? <TerminalSessionGallery tabs={tabs} activeId={activeId} attach={attachGalleryBody} select={(id) => { userTabFocusRef.current += 1; setActiveId(id); onActiveTabChange?.(id); }} close={(id) => { void closeTab(id); }} /> : <>
        {layout === 'sidebar' ? <div className={styles.shellTerminalSidebar} role="tablist" aria-label="终端会话">{tabList}</div> : null}
        <div className={styles.shellTerminalBodies}>
        {tabs.map((t) => (
          <div
            key={t.id}
            data-terminal-tab={t.id}
            className={`${styles.shellTerminalBody}${t.id === activeId ? ` ${styles.shellTerminalBodyActive}` : ''}`}
            style={{ display: t.id === activeId ? 'block' : 'none' }}
          >
            <div ref={attachBody(t.id)} className={styles.shellTerminalMount} />
          </div>
        ))}
        </div>
        </>}
      </div>
    </div>
  );
}

export default ShellTerminalPanel;
