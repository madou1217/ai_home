import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { Select, Empty, Button, Drawer, Tooltip, Dropdown } from 'antd';
import { ArrowDownOutlined, PlusOutlined, CloseOutlined, InfoCircleOutlined, DownOutlined } from '@ant-design/icons';
import type { ChatMessage, Account, Session, NativeSlashCommand, QueuedChatMessage, Provider, InteractivePrompt } from '@/types';
import { chatAPI, modelsAPI } from '@/services/api';
import MessageBubble from './MessageBubble';
import ProviderIcon, { providerNames } from './ProviderIcon';
import { providerAccentStyle } from './provider-registry';
import TaskDock from './TaskDock';
import { findLatestActiveChecklist } from './message-structure';
import PlanChoiceDock from './PlanChoiceDock';
import TerminalDock, { type TerminalRunState } from './TerminalDock';
import { decorateMessagesWithPendingState } from './live-message-state.js';
import { resolvePendingTailState } from './pending-tail-state.js';
import { normalizePendingStatusText } from './provider-pending-policy.js';
import { getAccountDefaultModel, listAccountEnabledModels } from './account-model-selection.js';
import { getAccountIdentityLabel } from '@/utils/account-labels';
import { throttle } from '@/utils/timing';
import {
  getQueueModeDescription,
  getQueueModeLabel,
  getQueuePrimaryActionLabel,
  getQueuePrimaryActionTitle
} from './queue-presentation.js';
import sendIcon from '@/assets/icons/send.svg';
import disabledSendIcon from '@/assets/icons/disabled-send.svg';
import stopIcon from '@/assets/icons/stop.svg';
import styles from './chat.module.css';

const PendingTailStatusLine = ({ text }: { text: string }) => {
  const chars = Array.from(text || '');
  return (
    <div className={styles.pendingTailStatus} aria-live="polite" aria-label={text}>
      {chars.map((char, index) => (
        <span
          key={`${char}-${index}`}
          className={styles.pendingTailChar}
          style={{ animationDelay: `${index * 0.08}s` }}
          aria-hidden="true"
        >
          {char === ' ' ? '\u00A0' : char}
        </span>
      ))}
    </div>
  );
};

const isChatSelectableAccount = (account: Account) => {
  if (!account.configured) return false;
  if (account.status === 'down') return false;
  if (String(account.schedulableStatus || '').trim() && account.schedulableStatus !== 'schedulable') return false;
  const runtimeStatus = String(account.runtimeStatus || '').trim();
  if (runtimeStatus && runtimeStatus !== 'healthy') return false;
  return true;
};

// 账号模型目录缓存（accountRef→启用模型）：切账号时先用缓存立即渲染，后台异步刷新，
// 避免每次点开会话/切账号都清空重拉、闪一下"无可用模型"。
const accountModelCatalogCache = new Map<string, { ids: string[]; defaultModel: string }>();

function findCodexUsageWindow(account: Account, window: '5h' | '7days') {
  if (account.provider !== 'codex' || account.apiKeyMode) return null;
  const snapshot = account.usageSnapshot;
  if (!snapshot || snapshot.kind !== 'codex_oauth_status' || !Array.isArray(snapshot.entries)) return null;
  const entry = snapshot.entries.find((item) => String(item.window || '').trim().toLowerCase() === window);
  if (!entry || entry.remainingPct == null) return null;
  const numeric = Number(entry.remainingPct);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function formatChatAccountLabel(account: Account) {
  const base = getAccountIdentityLabel(account);
  if (!base) return '';
  if (account.apiKeyMode) return base;

  const shortWindowRemaining = findCodexUsageWindow(account, '5h');
  const weeklyRemaining = findCodexUsageWindow(account, '7days');
  if (shortWindowRemaining != null || weeklyRemaining != null) {
    const usageParts = [
      shortWindowRemaining != null ? `d:${shortWindowRemaining}%` : '',
      weeklyRemaining != null ? `w:${weeklyRemaining}%` : ''
    ].filter(Boolean);
    return `${base} · ${usageParts.join(',')}`;
  }

  if (account.remainingPct != null) {
    return `${base} · ${Math.round(account.remainingPct)}%`;
  }
  return base;
}

interface Props {
  mobile?: boolean;
  session: Session | null;
  isTerminated?: boolean;
  messages: ChatMessage[];
  accounts: Account[];
  selectedAccount: Account | null;
  selectedModel: string;
  input: string;
  loading: boolean;
  loadingStatusText?: string;
  queuedMessages?: QueuedChatMessage[];
  externalPending?: boolean;
  externalPendingStatusText?: string;
  interactivePrompt?: InteractivePrompt | null;
  hasMoreHistory?: boolean;
  images?: string[]; // base64 图片列表
  onLoadMore?: () => void;
  onInputChange: (val: string) => void;
  onSend: () => void;
  onStop: () => void;
  onEditQueuedMessage?: (id: string) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onSendQueuedMessageNow?: (id: string) => void;
  onSelectPlanChoice?: (value: string, prompt: InteractivePrompt) => void;
  terminalRun?: TerminalRunState | null;
  onRegisterTerminalWriter?: (runId: string, writer: ((data: string) => void) | null) => void;
  onTerminalInput?: (runId: string, data: string) => void;
  onTerminalResize?: (runId: string, cols: number, rows: number) => void;
  onCloseTerminal?: (runId: string) => void;
  onAccountChange: (account: Account) => void;
  onModelChange: (model: string) => void;
  onImagesChange?: (images: string[]) => void;
}

const MessageArea = ({
  mobile = false,
  session, isTerminated: isTerminatedProp, messages, accounts, selectedAccount, selectedModel,
  input, loading, loadingStatusText, queuedMessages = [], externalPending = false, externalPendingStatusText, interactivePrompt = null, hasMoreHistory, images = [], onLoadMore, onInputChange,
  onSend, onStop, onEditQueuedMessage, onRemoveQueuedMessage, onSendQueuedMessageNow, onSelectPlanChoice,
  terminalRun = null, onRegisterTerminalWriter, onTerminalInput, onTerminalResize, onCloseTerminal,
  onAccountChange, onModelChange, onImagesChange
}: Props) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingVisualTsRef = useRef<number>(Date.now());
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [accountModelState, setAccountModelState] = useState<{ accountRef: string; ids: string[]; defaultModel: string; loading: boolean }>(() => {
    return { accountRef: '', ids: [], defaultModel: '', loading: false };
  });
  const [slashCommands, setSlashCommands] = useState<NativeSlashCommand[]>([]);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const activeProvider = session
    ? (session.draft ? (selectedAccount?.provider || session.provider) : session.provider)
    : '';

  // 处理粘贴图片
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result as string;
          onImagesChange?.([...images, base64]);
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }, [images, onImagesChange]);

  // 处理文件选择
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result as string;
          onImagesChange?.([...images, base64]);
        };
        reader.readAsDataURL(file);
      }
    }
    e.target.value = ''; // reset
  };

  const removeImage = (idx: number) => {
    onImagesChange?.(images.filter((_, i) => i !== idx));
  };

  const selectedAccountRef = String(selectedAccount?.accountRef || '').trim();
  const accountModelIds = accountModelState.accountRef === selectedAccountRef ? accountModelState.ids : [];

  // 加载当前账号启用模型：会话框只能使用账号投影，不能回退到 provider 聚合列表。
  // 缓存优先 + 后台异步刷新：切账号时若有缓存立即显示（不清空、不闪"无可用模型"），
  // 同时后台拉最新，回来再更新缓存与显示。
  useEffect(() => {
    if (!selectedAccountRef) {
      setAccountModelState({ accountRef: '', ids: [], defaultModel: '', loading: false });
      return;
    }

    let cancelled = false;
    const cached = accountModelCatalogCache.get(selectedAccountRef);
    // 先渲染缓存（若有），并标记后台刷新中；无缓存则空列表 + loading（显示"加载中…"而非"无可用模型"）。
    setAccountModelState({
      accountRef: selectedAccountRef,
      ids: cached ? cached.ids : [],
      defaultModel: cached ? cached.defaultModel : '',
      loading: true
    });
    modelsAPI.listCatalog({ accountRef: selectedAccountRef })
      .then((catalog) => {
        const next = {
          ids: listAccountEnabledModels(catalog, selectedAccountRef),
          defaultModel: getAccountDefaultModel(catalog, selectedAccountRef)
        };
        accountModelCatalogCache.set(selectedAccountRef, next);
        if (!cancelled) {
          setAccountModelState({ accountRef: selectedAccountRef, ...next, loading: false });
        }
      })
      .catch(() => {
        // 刷新失败：保留缓存内容，仅结束 loading，不清空成"无可用模型"。
        if (!cancelled) {
          setAccountModelState((prev) => (
            prev.accountRef === selectedAccountRef ? { ...prev, loading: false } : prev
          ));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAccountRef]);

  const hasSession = Boolean(session);
  useEffect(() => {
    if (!hasSession) {
      setSlashCommands([]);
      return;
    }
    const provider = activeProvider;
    let cancelled = false;
    chatAPI.getSlashCommands(provider)
      .then((commands) => {
        if (!cancelled) setSlashCommands(commands);
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      });
    return () => {
      cancelled = true;
    };
    // 依赖稳定原语而非整个 session 对象：否则 session 引用每次变都会重新拉取 slash-commands。
  }, [activeProvider, selectedAccount?.provider, hasSession]);

  // 滚动锚定系统（聊天标准）：
  //  - isInitialLoad：会话刚打开，未完成首屏定位（要把最新消息无感钉到底部）。
  //  - stickToBottom：当前处于"贴底"状态（新内容/图片加载时持续跟随底部）。
  //  - 向上加载老消息：锁定视觉位置，老消息从顶部静默插入，用户无感。
  const isInitialLoad = useRef(true);
  const stickToBottom = useRef(true);
  const prevScrollInfo = useRef({ height: 0, firstMsgId: '', scrollTop: 0 });
  const prevMsgCount = useRef(0);

  const STICK_THRESHOLD = 80;

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const firstMsgId = String(messages[0]?.timestamp || '');
    const grew = messages.length > prevMsgCount.current;
    // 顶部插入老消息：列表变长且第一条 id 变了（且非初始态）。
    const prependedOlder = !isInitialLoad.current
      && grew
      && firstMsgId !== prevScrollInfo.current.firstMsgId
      && prevScrollInfo.current.firstMsgId !== '';

    if (prependedOlder) {
      // 锚定：保持原可视位置 = 旧 scrollTop + 顶部新增高度。用户完全无感。
      const heightDiff = el.scrollHeight - prevScrollInfo.current.height;
      el.scrollTop = prevScrollInfo.current.scrollTop + Math.max(0, heightDiff);
    } else if (isInitialLoad.current || stickToBottom.current) {
      // 初始首屏 / 贴底状态：即时钉到底部（无动画、无可见滚动）。
      // 流式期间也走这里——即时 scrollTop，绝不用 smooth（会持续抖动/闪屏）。
      el.scrollTop = el.scrollHeight;
      // 只有真正渲染了内容才退出初始态，避免"清空→缓存→完整"的空中间态提前消耗。
      if (messages.length > 0) isInitialLoad.current = false;
    }

    prevScrollInfo.current = { height: el.scrollHeight, firstMsgId, scrollTop: el.scrollTop };
    prevMsgCount.current = messages.length;
  }, [messages]);

  // 内容异步变高（图片/代码高亮加载完）时，若仍贴底则持续钉底——
  // 这样"滚动条慢慢变小"的同时，最新消息始终固定在首屏，用户无感。
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const content = el.querySelector(`.${styles.messageThread}`) || el.firstElementChild;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (isInitialLoad.current || stickToBottom.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // 切换会话时重置为"初始贴底"
  useEffect(() => {
    isInitialLoad.current = true;
    stickToBottom.current = true;
    prevMsgCount.current = 0;
    prevScrollInfo.current = { height: 0, firstMsgId: '', scrollTop: 0 };
  }, [session?.id]);

  // 滚动是高频事件，节流到约 120ms 一次。同时更新"是否贴底"状态。
  const handleScroll = useMemo(() => throttle(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceToBottom < STICK_THRESHOLD;
    setShowScrollBottom(distanceToBottom > 200);
  }, 120), []);

  const scrollToBottom = () => {
    stickToBottom.current = true;
    const el = scrollContainerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // 自动调整 textarea 高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  const filteredAccounts = (session && !session.draft
    ? accounts.filter((account) => account.provider === session.provider)
    : accounts
  ).filter(isChatSelectableAccount);

  const mobileAccountSummary = selectedAccount
    ? `${selectedAccount.provider.toUpperCase()} · ${formatChatAccountLabel(selectedAccount)}`
    : '未选择账号';
  const sessionProvider = session?.provider || activeProvider || 'codex';

  const trimmedInput = input.trim();
  const slashToken = trimmedInput.startsWith('/')
    ? trimmedInput.split(/\s+/, 1)[0]
    : '';
  const matchedSlashCommand = slashToken
    ? slashCommands.find((item) => item.command === slashToken || item.aliases.some((alias) => alias === slashToken)) || null
    : null;
  const slashMatches = slashToken
    ? slashCommands.filter((item) =>
      slashToken === '/'
      || item.command.startsWith(slashToken)
      || item.aliases.some((alias) => alias.startsWith(slashToken))
    )
    : [];
  const hasUnsupportedSlashCommand = Boolean(slashToken) && !matchedSlashCommand && slashMatches.length === 0;
  const embeddedSlashMatch = !trimmedInput.startsWith('/')
    ? slashCommands.find((item) => {
        const tokens = trimmedInput.split(/\s+/).filter(Boolean);
        return tokens.includes(item.command) || item.aliases.some((alias) => tokens.includes(alias));
      }) || null
    : null;
  const isTerminated = isTerminatedProp || session?.status === 'stopped' || session?.status === 'archived';
  const accountDefaultModel = accountModelState.accountRef === selectedAccountRef ? accountModelState.defaultModel : '';
  const models = accountModelIds.map(m => ({ label: m, value: m }));
  const modelsLoading = accountModelState.accountRef === selectedAccountRef && accountModelState.loading;
  // 加载中且暂无模型 → "加载中…"；确实空 → "无可用模型"。避免刷新窗口误显示"无可用模型"。
  const emptyModelHint = modelsLoading && models.length === 0 ? '加载中…' : '无可用模型';
  const effectiveSelectedModel = selectedModel || models[0]?.value || '';
  const hasAccountModel = Boolean(effectiveSelectedModel);
  const canSend = !isTerminated && hasAccountModel && trimmedInput.length > 0
    && !embeddedSlashMatch;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend && !loading) onSend();
    }
  }, [canSend, loading, onSend]);

  const displayMessages = useMemo(() => {
    const pendingState = decorateMessagesWithPendingState({
      messages,
      loading,
      externalPending,
      loadingStatusText,
      externalPendingStatusText,
      activeProvider,
      pendingTimestamp: pendingVisualTsRef.current
    });
    if (pendingState.usedSyntheticPending) {
      pendingVisualTsRef.current = Date.now();
    }
    return pendingState.messages;
  }, [activeProvider, externalPending, externalPendingStatusText, loading, loadingStatusText, messages]);

  const renderedMessageNodes = useMemo(() => (
    displayMessages.map((msg, i) => (
      <MessageBubble
        // key 必须稳定：不能把 pending 编进去，否则流式回复从 pending→done 时
        // key 变化会强制卸载重挂整个气泡，造成"闪屏"。消息位置(i)在流式期间不变，
        // 内容变化由 message prop 触发正常 re-render，无需用 key 强制刷新。
        key={`${msg.role}-${i}`}
        message={msg}
        provider={sessionProvider}
        session={session}
        mobile={mobile}
      />
    ))
  ), [displayMessages, mobile, sessionProvider]);

  const activeChecklist = useMemo(
    () => findLatestActiveChecklist(displayMessages),
    [displayMessages]
  );
  const pendingTail = useMemo(() => {
    const state = resolvePendingTailState({
      messages: displayMessages,
      loading,
      externalPending,
      loadingStatusText,
      externalPendingStatusText,
      activeProvider
    });
    return {
      visible: state.visible,
      statusText: normalizePendingStatusText(state.statusText, sessionProvider)
    };
  }, [
    activeProvider,
    displayMessages,
    externalPending,
    externalPendingStatusText,
    loading,
    loadingStatusText,
    sessionProvider
  ]);
  const showPlanChoiceDock = Boolean(interactivePrompt && onSelectPlanChoice && !isTerminated);
  const showTerminalDock = Boolean(terminalRun && terminalRun.runId);
  const hasComposerDock = Boolean(activeChecklist) || showPlanChoiceDock || showTerminalDock || queuedMessages.length > 0;
  const helperFontSize = mobile ? 13 : 12;
  const helperMutedFontSize = mobile ? 12 : 11;

  useEffect(() => {
    if (!session) return;
    if (accountModelIds.includes(selectedModel)) return;
    // 当前选中模型不在可用列表中时，优先从 localStorage 恢复该 provider 的上次选择
    const provider = activeProvider;
    let nextModel = '';
    if (provider) {
      try {
        const saved = localStorage.getItem(`chat-selected-model:${provider}`) || '';
        if (saved && accountModelIds.includes(saved)) {
          nextModel = saved;
        }
      } catch {}
    }
    if (!nextModel) {
      if (accountDefaultModel && accountModelIds.includes(accountDefaultModel)) {
        nextModel = accountDefaultModel;
      }
    }
    if (!nextModel) {
      nextModel = accountModelIds[0] || '';
    }
    if (selectedModel !== nextModel) onModelChange(nextModel);
  }, [accountDefaultModel, accountModelIds, activeProvider, onModelChange, selectedModel, session]);

  const applySlashCommand = useCallback((command: NativeSlashCommand | null) => {
    if (!command) return;
    const suffix = command.argumentHint ? ' ' : '';
    onInputChange(`${command.command}${suffix}`);
  }, [onInputChange]);

  useEffect(() => {
    if (slashMatches.length === 0) {
      setSelectedSlashIndex(0);
      return;
    }
    setSelectedSlashIndex((current) => Math.min(current, slashMatches.length - 1));
  }, [slashMatches.length]);

  const handleComposerKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashToken) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onInputChange('');
        return;
      }

      if (slashMatches.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setSelectedSlashIndex((current) => {
          if (slashMatches.length === 0) return 0;
          if (e.key === 'ArrowDown') return (current + 1) % slashMatches.length;
          return (current - 1 + slashMatches.length) % slashMatches.length;
        });
        return;
      }

      if (slashMatches.length > 0 && e.key === 'Tab') {
        e.preventDefault();
        applySlashCommand(slashMatches[selectedSlashIndex] || slashMatches[0] || null);
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        if (embeddedSlashMatch) {
          e.preventDefault();
          return;
        }
        if (!matchedSlashCommand && slashMatches.length > 0) {
          e.preventDefault();
          applySlashCommand(slashMatches[selectedSlashIndex] || slashMatches[0] || null);
          return;
        }
      }
    }

    if (embeddedSlashMatch && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      return;
    }

    handleKeyDown(e);
  }, [
    applySlashCommand,
    embeddedSlashMatch,
    handleKeyDown,
    hasUnsupportedSlashCommand,
    matchedSlashCommand,
    onInputChange,
    selectedSlashIndex,
    slashMatches,
    slashToken
  ]);

  if (!session) {
    return (
      <div className={styles.emptyCenter}>
        <Empty description="选择一个会话开始对话" />
      </div>
    );
  }

  return (
    <>
      {/* 消息列表 */}
      <div
        className={`${styles.messageArea} ${mobile ? styles.messageAreaMobile : ''}`}
        ref={scrollContainerRef}
        onScroll={handleScroll}
        data-provider={sessionProvider}
        style={providerAccentStyle(sessionProvider)}
      >
        <div className={styles.messageThread}>
          {displayMessages.length === 0 ? (
            <div className={styles.welcomeState}>
              <div className={styles.welcomeTitle}>你今天想聊些什么？</div>
              <div className={styles.welcomeHint}>
                选择项目后直接开始对话，图片和系统输入法语音输入都可以使用。
              </div>
            </div>
          ) : (
            <div style={{ paddingBottom: 24 }}>
            {/* 加载更多历史 */}
            {hasMoreHistory && (
              <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
                <button
                  onClick={onLoadMore}
                  style={{
                    background: '#fff', border: '1px solid #d9d9d9', borderRadius: 16,
                    padding: mobile ? '6px 16px' : '4px 16px', cursor: 'pointer', fontSize: mobile ? 13 : 12, color: '#666'
                  }}
                >
                  加载更早的消息
                </button>
              </div>
            )}
            {renderedMessageNodes}
            {pendingTail.visible ? (
              <div className={styles.pendingTailRow}>
                <PendingTailStatusLine text={pendingTail.statusText || '正在思考中'} />
              </div>
            ) : null}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {showScrollBottom && (
          <button onClick={scrollToBottom} className={styles.scrollBottomBtn}>
            <ArrowDownOutlined />
          </button>
        )}
      </div>

      {/* ChatGPT 风格输入区域 */}
      <div className={`${styles.inputArea} ${mobile ? styles.inputAreaMobile : ''}`}>
        <div className={styles.composerShell}>
          {hasComposerDock ? (
            <div className={styles.composerDockStack}>
            {activeChecklist ? <TaskDock checklist={activeChecklist} className={styles.composerDockCard} /> : null}
            <PlanChoiceDock
              visible={showPlanChoiceDock}
              prompt={interactivePrompt}
              onSelect={(value, prompt) => onSelectPlanChoice?.(value, prompt)}
            />
            {showTerminalDock && terminalRun ? (
              <TerminalDock
                key={terminalRun.runId}
                visible={showTerminalDock}
                run={terminalRun}
                onRegisterWriter={(runId, writer) => onRegisterTerminalWriter?.(runId, writer)}
                onInput={(runId, data) => onTerminalInput?.(runId, data)}
                onResize={(runId, cols, rows) => onTerminalResize?.(runId, cols, rows)}
                onClose={(runId) => onCloseTerminal?.(runId)}
              />
            ) : null}
            {queuedMessages.length > 0 ? (
              <div className={`${styles.queueDock} ${styles.composerDockCard}`}>
                <div className={styles.queueDockHeader}>
                  <span className={styles.queueDockTitle}>{`排队消息 ${queuedMessages.length}`}</span>
                  <span className={styles.queueDockHint}>
                    运行中继续输入的需求会在这里排队
                  </span>
                </div>
            {queuedMessages.map((item, index) => (
              <div key={item.id} className={styles.queueItem}>
                <div className={styles.queueGrip} aria-hidden="true">⋮⋮</div>
                <button
                  type="button"
                  className={styles.queueContent}
                  onClick={() => onEditQueuedMessage?.(item.id)}
                  title="编辑排队消息"
                >
                  <span className={styles.queuePreview}>
                    {item.content}
                  </span>
                </button>
                <div className={styles.queueActions}>
                  <span className={styles.queueActionHintWrap}>
                    <span className={styles.queueActionHint}>
                      {getQueueModeLabel(item.mode, index)}
                    </span>
                    {index === 0 ? (
                      <Tooltip
                        placement="topRight"
                        title={getQueueModeDescription(item.mode)}
                      >
                        <button
                          type="button"
                          className={styles.queueInfoBtn}
                          aria-label="排队说明"
                        >
                          <InfoCircleOutlined />
                        </button>
                      </Tooltip>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    className={styles.queueActionBtn}
                    onClick={() => onSendQueuedMessageNow?.(item.id)}
                    title={getQueuePrimaryActionTitle(loading, index)}
                  >
                    {getQueuePrimaryActionLabel(loading, index)}
                  </button>
                  <button
                    type="button"
                    className={styles.queueActionBtn}
                    onClick={() => onEditQueuedMessage?.(item.id)}
                    title="编辑消息"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className={styles.queueActionBtn}
                    onClick={() => onRemoveQueuedMessage?.(item.id)}
                    title="删除排队"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
              </div>
            ) : null}
            </div>
          ) : null}
          {isTerminated ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: '#999', fontSize: 13, userSelect: 'none' }}>
              此会话已归档，无法继续对话。
            </div>
          ) : (
            <div className={`${styles.inputBox} ${mobile ? styles.inputBoxMobile : ''}`}>
            {/* 图片预览 */}
            {images.length > 0 && (
              <div className={styles.imagePreviewRow}>
                {images.map((img, idx) => (
                  <div key={idx} className={styles.imagePreviewItem}>
                    <img src={img} alt="" className={styles.imagePreviewImg} />
                    <button className={styles.imageRemoveBtn} onClick={() => removeImage(idx)}>
                      <CloseOutlined style={{ fontSize: 10 }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className={styles.inputTextarea}
              value={input}
              onChange={e => onInputChange(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handlePaste}
              placeholder={mobile ? '输入消息，系统输入法可直接语音输入' : '输入消息...'}
              rows={1}
            />
          {slashToken && (
            <div style={{
              padding: '0 12px 8px',
              fontSize: helperFontSize,
              color: hasUnsupportedSlashCommand ? '#d48806' : '#2468d6'
            }}>
              {matchedSlashCommand ? (
                <>
                  命令模式：<strong>{matchedSlashCommand.command}</strong>
                  {matchedSlashCommand.argumentHint ? ` ${matchedSlashCommand.argumentHint}` : ''}
                  {' '}· {matchedSlashCommand.description}
                  {matchedSlashCommand.aliases.length > 0 ? ` · 别名：${matchedSlashCommand.aliases.join(', ')}` : ''}
                </>
              ) : hasUnsupportedSlashCommand ? (
                <>
                  未识别的命令 <strong>{slashToken}</strong>（将作为普通文本发送）。
                </>
              ) : (
                <>
                  正在选择命令。Slash 命令必须单独发送，可在命令后附带参数，但不能和普通聊天文本混发。
                </>
              )}
            </div>
          )}
          {slashMatches.length > 0 && (
            <div style={{ padding: '0 12px 8px' }}>
              <div style={{ marginBottom: 6, fontSize: helperMutedFontSize, color: '#6b7280' }}>
                ↑↓ 切换命令 · Tab 补全 · Enter 选择 · Esc 退出
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {slashMatches.map((item, index) => {
                  const active = index === selectedSlashIndex;
                  return (
                    <button
                      key={item.command}
                      type="button"
                      onMouseEnter={() => setSelectedSlashIndex(index)}
                      onClick={() => applySlashCommand(item)}
                      title={item.description}
                      style={{
                        border: active ? '1px solid #91caff' : '1px solid #d9e8ff',
                        background: active ? '#e6f4ff' : '#f5f9ff',
                        color: '#2468d6',
                        borderRadius: 12,
                        fontSize: helperFontSize,
                        lineHeight: '18px',
                        padding: '8px 10px',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {item.command}
                        {item.argumentHint ? ` ${item.argumentHint}` : ''}
                      </div>
                      <div style={{ marginTop: 2, color: '#5b6b88' }}>
                        {item.description}
                        {item.aliases.length > 0 ? ` · 别名：${item.aliases.join(', ')}` : ''}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {embeddedSlashMatch && (
            <div style={{ padding: '0 12px 8px', fontSize: helperFontSize, color: '#c25100' }}>
              检测到命令 {embeddedSlashMatch.command}。Slash 命令必须单独发送，不能和普通文本混在同一条消息里。
            </div>
          )}
          {/* 隐藏文件输入 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          {/* 底部工具栏 */}
          <div className={styles.inputToolbar}>
            <div className={styles.inputToolbarLeft}>
              <button
                className={styles.inputToolbarBtn}
                title="上传图片"
                onClick={() => fileInputRef.current?.click()}
              >
                <PlusOutlined style={{ fontSize: 16 }} />
              </button>
              {mobile ? (
                <button
                  type="button"
                  className={styles.mobileMetaBtn}
                  onClick={() => setMobileControlsOpen(true)}
                >
                  <div className={styles.mobileComposerMeta}>
                    <span>{mobileAccountSummary}</span>
                    <span>{effectiveSelectedModel || emptyModelHint}</span>
                  </div>
                </button>
              ) : (
                <Dropdown
                  trigger={['click']}
                  disabled={models.length === 0}
                  menu={{
                    items: models.map(m => {
                      const isActive = effectiveSelectedModel === m.value;
                      return {
                        key: m.value,
                        onClick: () => onModelChange(m.value),
                        label: (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px', width: '100%' }}>
                            <span style={{ fontWeight: isActive ? 600 : 400, color: '#333' }}>{m.label}</span>
                            {isActive && <span style={{ color: '#2563eb' }}>✓</span>}
                          </div>
                        ),
                        style: { borderRadius: 8, margin: '2px 4px', background: isActive ? '#f8fafc' : 'transparent' }
                      };
                    })
                  }}
                  dropdownRender={(menu) => (
                    <div style={{ background: '#fff', borderRadius: 12, padding: '4px 0', boxShadow: '0 4px 24px rgba(0,0,0,0.08)', minWidth: 160 }}>
                      {models.length === 0 ? <div style={{ padding: '12px', textAlign: 'center', color: '#999', fontSize: 13 }}>{emptyModelHint}</div> : menu}
                    </div>
                  )}
                >
                  <button type="button" className={styles.metaDropdownBtn}>
                    <span>{effectiveSelectedModel || emptyModelHint}</span>
                    <DownOutlined style={{ fontSize: 10, color: '#9ca3af', marginLeft: 2 }} />
                  </button>
                </Dropdown>
              )}
            </div>
            <div className={styles.inputToolbarRight}>
              {!mobile ? (
                <Dropdown
                  trigger={['click']}
                  disabled={filteredAccounts.length === 0}
                  menu={{
                    items: Object.entries(
                      filteredAccounts.reduce((acc, account) => {
                        if (!acc[account.provider]) acc[account.provider] = [];
                        acc[account.provider].push(account);
                        return acc;
                      }, {} as Record<string, Account[]>)
                    ).map(([provider, providerAccounts]) => ({
                      type: 'group',
                      label: <span style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', paddingLeft: 4 }}>{providerNames[provider as Provider] || provider}</span>,
                      children: providerAccounts.map(acc => {
                        const isActive = selectedAccount?.provider === acc.provider && selectedAccount?.accountId === acc.accountId;
                        return {
                          key: `${acc.provider}-${acc.accountId}`,
                          onClick: () => onAccountChange(acc),
                          label: (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', color: isActive ? '#fff' : '#333' }}>
                              <ProviderIcon provider={acc.provider} size={14} />
                              <span style={{ fontWeight: isActive ? 600 : 400 }}>{formatChatAccountLabel(acc)}</span>
                              {acc.apiKeyMode ? (
                                <span style={{ fontSize: 10, background: isActive ? 'rgba(255,255,255,0.2)' : '#f0f0f0', padding: '0 6px', borderRadius: 4, color: isActive ? '#fff' : '#666' }}>
                                  key
                                </span>
                              ) : null}
                            </div>
                          ),
                          style: isActive ? { background: '#4b5563', borderRadius: 8, margin: '2px 4px' } : { borderRadius: 8, margin: '2px 4px' }
                        };
                      })
                    }))
                  }}
                  dropdownRender={(menu) => (
                    <div style={{ background: '#fff', borderRadius: 12, padding: '4px 0', boxShadow: '0 4px 24px rgba(0,0,0,0.08)', minWidth: 220 }}>
                      {filteredAccounts.length === 0 ? <div style={{ padding: '12px', textAlign: 'center', color: '#999', fontSize: 13 }}>无可用账号</div> : menu}
                    </div>
                  )}
                >
                  <button type="button" className={styles.metaDropdownBtn}>
                    {selectedAccount ? (
                      <>
                        <ProviderIcon provider={selectedAccount.provider} size={12} />
                        <span>{formatChatAccountLabel(selectedAccount)}</span>
                        {selectedAccount.apiKeyMode ? <span className={styles.metaKeyBadge}>key</span> : null}
                        <DownOutlined style={{ fontSize: 10, color: '#9ca3af', marginLeft: 2 }} />
                      </>
                    ) : (
                      <>
                        <span>无可用账号</span>
                        <DownOutlined style={{ fontSize: 10, color: '#9ca3af', marginLeft: 2 }} />
                      </>
                    )}
                  </button>
                </Dropdown>
              ) : null}
              {/* 发送/停止：固定位置的切换按钮，loading 时变为停止 */}
              <button
                type="button"
                className={`${styles.sendBtn} ${loading ? styles.sendBtnStop : canSend ? styles.sendBtnActive : ''}`}
                onClick={() => {
                  if (loading) { onStop(); return; }
                  if (canSend && !embeddedSlashMatch) onSend();
                }}
                disabled={!loading && (!canSend || Boolean(embeddedSlashMatch))}
                title={loading ? '停止' : '发送'}
                aria-label={loading ? '停止生成' : '发送消息'}
              >
                {loading
                  ? <img src={stopIcon} alt="" className={styles.sendBtnStopIcon} aria-hidden="true" />
                  : <img src={canSend ? sendIcon : disabledSendIcon} alt="" className={styles.sendBtnIcon} aria-hidden="true" />
                }
              </button>
            </div>
          </div>
          </div>
        )}
        </div>
      </div>
      {mobile ? (
        <Drawer
          placement="bottom"
          height="auto"
          open={mobileControlsOpen}
          onClose={() => setMobileControlsOpen(false)}
          title="聊天设置"
          className={styles.mobileControlsDrawer}
          styles={{
            header: { padding: '14px 16px 10px', borderBottom: 'none' },
            body: { padding: '0 16px calc(16px + env(safe-area-inset-bottom))' },
            content: { borderRadius: '24px 24px 0 0', overflow: 'hidden' }
          }}
        >
          <div className={styles.mobileSheetHandle} />
          <div className={styles.mobileControlsSection}>
            <div className={styles.mobileControlsLabel}>账号</div>
            <Select
              value={selectedAccount ? `${selectedAccount.provider}-${selectedAccount.accountId}` : undefined}
              onChange={(value) => {
                const [provider, accountId] = value.split('-');
                const account = accounts.find(a => a.provider === provider && a.accountId === accountId);
                if (account) onAccountChange(account);
              }}
              options={filteredAccounts.map(acc => ({
                label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ProviderIcon provider={acc.provider} size={14} />
                  <span>{formatChatAccountLabel(acc)}</span>
                  {acc.apiKeyMode ? <span title="API Key">key</span> : null}
                </span>,
                value: `${acc.provider}-${acc.accountId}`
              }))}
              style={{ width: '100%' }}
              size="large"
            />
          </div>
          <div className={styles.mobileControlsSection}>
            <div className={styles.mobileControlsLabel}>模型</div>
            <Select
              value={effectiveSelectedModel || undefined}
              onChange={onModelChange}
              options={models}
              disabled={models.length === 0}
              placeholder={emptyModelHint}
              style={{ width: '100%' }}
              size="large"
            />
          </div>
          <div className={styles.mobileVoiceHint}>
            语音输入直接使用系统输入法麦克风即可，这里不单独接管录音。
          </div>
          <Button type="primary" block size="large" onClick={() => setMobileControlsOpen(false)}>
            完成
          </Button>
        </Drawer>
      ) : null}
    </>
  );
};

export default MessageArea;
