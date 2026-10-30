import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { Select, Empty, Button, Drawer, Tooltip } from 'antd';
import { ArrowDownOutlined, PlusOutlined, InfoCircleOutlined, CodeOutlined } from '@ant-design/icons';
import type { ChatMessage, Account, ChatAccount, Session, NativeSlashCommand, QueuedChatMessage, Provider, InteractivePrompt, ModelMetadata } from '@/types';
import { chatAPI, modelsAPI, sessionsAPI, resolveActiveServer } from '@/services/api';
import MessageBubble from './MessageBubble';
import ProviderIcon from './ProviderIcon';
import ComposerAccountMenu from './composer/ComposerAccountMenu';
import ComposerApprovalMenu from './composer/ComposerApprovalMenu';
import ComposerModelMenu from './composer/ComposerModelMenu';
import DictationButton from './composer/DictationButton';
import DictationRecordingBar from './composer/DictationRecordingBar';
import { useDictation } from './composer/useDictation';
import dictationStyles from './composer/dictation.module.css';
import { getProviderLabel, providerAccentStyle } from './provider-registry';
import TaskDock from './TaskDock';
import StatsLine from './StatsLine';
import SlashCommandMenu from './SlashCommandMenu';
import FileReferencePopover, { type FileReferenceCandidate } from './FileReferencePopover';
import { useFileReferenceCandidates } from './use-file-reference-candidates';
import ContextMeter from './ContextMeter';
import ComposerAttachmentGallery from './ComposerAttachmentGallery';
import { CHAT_ATTACHMENT_ACCEPT, shouldConvertLargePaste, type ChatDocumentAttachment } from './attachment-files';
import { useChatFileInput } from './use-chat-file-input';
import InSessionSearchBar from './InSessionSearchBar';
import { useFlipReorder } from '@/hooks/use-flip-reorder';
import { useSwitchFade } from '@/hooks/use-switch-fade';
import { useAppendEnter } from '@/hooks/use-append-enter';
import { IN_SESSION_SEARCH_OPEN_EVENT } from './chat-global-shortcuts';
import PromptPresetsCapsule from './PromptPresetsCapsule';
import { findLatestActiveChecklist } from './message-structure';
import { resolveNativeSessionWriteBlock } from '@/features/legacy-chat/native-session-write-policy';
import { CaptureIdentityBoundary } from '@/features/capture';
import { useMobileOverscrollFeedback } from '@/components/mobile/use-mobile-overscroll-feedback';
import PlanChoiceDock from './PlanChoiceDock';
import TerminalDock, { type TerminalRunState } from './TerminalDock';
import { useOpenProjectTerminal } from '@/features/web-terminal/use-open-project-terminal';
import {
  composerDraftKey,
  readComposerDraft,
  writeComposerDraft,
} from '@/features/chat-runtime/composer-draft-store';
import { decorateMessagesWithPendingState } from './live-message-state.js';
import { filterRenderableChatMessages } from './message-display-policy.js';
import { resolvePendingTailState } from './pending-tail-state.js';
import { normalizePendingStatusText } from './provider-pending-policy.js';
import { getAccountDefaultModel, getSessionModelKey, listAccountEnabledModels, listAihServerModels, recallSessionModel, rememberSessionModel, resolveEffectiveSelectedModel } from './account-model-selection.js';
import {
  invalidateCatalogCache,
  readCachedCatalog,
  writeCachedCatalog
} from './account-model-catalog-cache';
import { onAccountModelCatalogChanged } from '@/features/models/account-model-catalog-events';
import { isSessionAccountProviderCompatible } from './session-provider-policy.js';
import {
  AIH_SERVER_ACCOUNT_LABEL,
  GATEWAY_SELECTION_SCOPE,
  isAihServerAccount,
  makeAihServerAccount,
  providerFromGatewayScope,
  supportsAihServer
} from './aih-server-account';
import { getAccountIdentityLabel } from '@/utils/account-labels';
import { useCollapsePresence } from '@/hooks/use-collapse-presence';
import { usePresenceList } from '@/hooks/use-presence-list';
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
import areaStyles from './message-area.module.css';
import composerStyles from './composer/composer.module.css';
import filePreviewStyles from './file-preview.module.css';

// chat.module.css 拆分后按域合并；各类名在三个模块间无交集，引用行为不变
const styles = { ...areaStyles, ...composerStyles, ...filePreviewStyles };

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

const isChatSelectableAccount = (account: ChatAccount) => {
  if (!account.configured) return false;
  if (account.status === 'down') return false;
  if (String(account.schedulableStatus || '').trim() && account.schedulableStatus !== 'schedulable') return false;
  const runtimeStatus = String(account.runtimeStatus || '').trim();
  if (runtimeStatus && runtimeStatus !== 'healthy') return false;
  return true;
};

// 账号模型目录缓存（accountRef→启用模型）：切账号时先用缓存立即渲染，后台异步刷新，
// 避免每次点开会话/切账号都清空重拉、闪一下"无可用模型"。
// 同时**持久化到 localStorage**(按 当前server+accountRef 分键)，页面刷新/冷启动也能立即出模型，
// 不再等 API 慢半拍(尤其远端 server 往返 + 第三方端点探测)。
// 缓存本体与跨页面失效都在 account-model-catalog-cache 模块里：失效订阅必须是**模块级**
// 的，组件 effect 只在挂载时注册，而用户完全可能「在账号页加模型 → 切回 chat 但还没进
// 会话」（本组件未挂载）→ 事件丢失 → 旧缓存原样保留（2026-10-23 用户反馈的正是这个）。
const accountModelCatalogCache = {
  get: (key: string) => readCachedCatalog(key),
  set: (key: string, value: { ids: string[]; defaultModel: string }) => writeCachedCatalog(key, value),
  delete: (key: string) => invalidateCatalogCache(key)
};

// 订阅装在应用入口（app.tsx）而不是这里：本组件是懒加载 chunk，用户「在账号页加模型
// → 切回 chat 但还没进会话」时它根本没求值，事件会丢。

function catalogStorageKey(targetKey: string): string {
  let serverId = 'local';
  try {
    const active = resolveActiveServer();
    serverId = active.serverId || 'local';
  } catch (_error) {
    serverId = 'local';
  }
  return `chat-model-catalog:v1:${serverId}:${targetKey}`;
}

function readPersistedCatalog(targetKey: string): { ids: string[]; defaultModel: string } | null {
  if (typeof window === 'undefined' || !targetKey) return null;
  try {
    const raw = window.localStorage.getItem(catalogStorageKey(targetKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.ids)) {
      return { ids: parsed.ids as string[], defaultModel: String(parsed.defaultModel || '') };
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function writePersistedCatalog(targetKey: string, value: { ids: string[]; defaultModel: string }): void {
  if (typeof window === 'undefined' || !targetKey) return;
  try {
    window.localStorage.setItem(catalogStorageKey(targetKey), JSON.stringify(value));
  } catch (_error) {
    // ignore quota / serialization errors
  }
}

function findCodexUsageWindow(account: ChatAccount, window: '5h' | '7days') {
  if (account.provider !== 'codex' || account.apiKeyMode) return null;
  const snapshot = account.usageSnapshot;
  if (!snapshot || snapshot.kind !== 'codex_oauth_status' || !Array.isArray(snapshot.entries)) return null;
  const entry = snapshot.entries.find((item) => String(item.window || '').trim().toLowerCase() === window);
  if (!entry || entry.remainingPct == null) return null;
  const numeric = Number(entry.remainingPct);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function formatChatAccountLabel(account: ChatAccount) {
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
  selectedAccount: ChatAccount | null;
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
  documents?: ChatDocumentAttachment[];
  onDocumentsChange?: (documents: ChatDocumentAttachment[]) => void;
  onLoadMore?: () => void;
  onInputChange: (val: string) => void;
  onSend: () => void;
  onStop: () => void;
  onEditQueuedMessage?: (id: string) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onSendQueuedMessageNow?: (id: string) => void;
  // mid-run 插话(P2c):立即把该队列消息注入当前运行(不打断)。仅支持 steer 的 provider 传入。
  onSteerQueuedMessage?: (id: string) => void;
  // 会话级审批模式(P3):选择器仅在 onApprovalModeChange 传入时显示(claude native 先行)。
  approvalMode?: 'bypass' | 'confirm' | 'plan';
  onApprovalModeChange?: (mode: 'bypass' | 'confirm' | 'plan') => void;
  onSelectPlanChoice?: (value: string, prompt: InteractivePrompt) => void;
  terminalRun?: TerminalRunState | null;
  onRegisterTerminalWriter?: (runId: string, writer: ((data: string) => void) | null) => void;
  onTerminalInput?: (runId: string, data: string) => void;
  onTerminalResize?: (runId: string, cols: number, rows: number) => void;
  onCloseTerminal?: (runId: string) => void;
  onAccountChange: (account: ChatAccount) => void;
  onModelChange: (model: string) => void;
  onImagesChange?: (images: string[]) => void;
  // 当前项目路径：底部终端新开时直接进入该目录（而非 home）。
  terminalCwd?: string;
  onForkSession?: (messageIndex: number) => void;
  // 重新生成：用上一轮 user 消息内容直接重发(不改当前草稿)
  onRetry?: (prompt: string) => void;
}

const MessageArea = ({
  mobile = false,
  session, isTerminated: isTerminatedProp, messages, accounts, selectedAccount, selectedModel,
  input, loading, loadingStatusText, queuedMessages = [], externalPending = false, externalPendingStatusText, interactivePrompt = null, hasMoreHistory, images = [], documents = [], onDocumentsChange, onLoadMore, onInputChange,
  onSend, onStop, onEditQueuedMessage, onRemoveQueuedMessage, onSendQueuedMessageNow, onSteerQueuedMessage, approvalMode = 'bypass', onApprovalModeChange, onSelectPlanChoice,
  terminalRun = null, onRegisterTerminalWriter, onTerminalInput, onTerminalResize, onCloseTerminal,
  onAccountChange, onModelChange, onImagesChange, terminalCwd, onForkSession, onRetry
}: Props) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingVisualTsRef = useRef<number>(Date.now());
  // 排队消息的增删/换序：其余条目滑到新位置，而不是整列瞬间重排。
  const queueFlipRef = useFlipReorder<HTMLDivElement>(queuedMessages);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [accountModelState, setAccountModelState] = useState<{ targetKey: string; ids: string[]; defaultModel: string; loading: boolean; metadata?: Record<string, ModelMetadata> }>(() => {
    return { targetKey: '', ids: [], defaultModel: '', loading: false };
  });
  // 模型目录重新加载令牌：账号模型页改了模型（增删/启停）时 +1，让下面的加载 effect
  // 重跑（它不依赖 selectedTargetKey 之外的东西，切换账号才重跑）。
  const [catalogReloadToken, setCatalogReloadToken] = useState(0);
  const [slashCommands, setSlashCommands] = useState<NativeSlashCommand[]>([]);
  const [slashPassthrough, setSlashPassthrough] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // 终端入口唯一：输入框工具栏按钮打开全局 Web Terminal 浮窗（不再内嵌底部终端面板）。
  const openProjectTerminal = useOpenProjectTerminal();
  const legacyDraftIdentity = useMemo(() => ({
    sessionId: session?.id,
    draft: Boolean(session?.draft),
    workspaceMode: session?.mode || 'chat',
    projectPath: session?.projectPath || terminalCwd,
  }), [session?.draft, session?.id, session?.mode, session?.projectPath, terminalCwd]);
  const legacyDraftKey = composerDraftKey(legacyDraftIdentity);
  const hydratedLegacyDraftKey = useRef('');
  useEffect(() => {
    if (hydratedLegacyDraftKey.current === legacyDraftKey) return;
    hydratedLegacyDraftKey.current = legacyDraftKey;
    const stored = readComposerDraft(legacyDraftIdentity);
    if (stored !== input) onInputChange(stored);
  }, [input, legacyDraftIdentity, legacyDraftKey, onInputChange]);
  useEffect(() => {
    if (hydratedLegacyDraftKey.current !== legacyDraftKey) return;
    const timer = window.setTimeout(() => writeComposerDraft(legacyDraftIdentity, input), 180);
    return () => {
      window.clearTimeout(timer);
      writeComposerDraft(legacyDraftIdentity, input);
    };
  }, [input, legacyDraftIdentity, legacyDraftKey]);
  const [inSessionSearchOpen, setInSessionSearchOpen] = useState(false);
  // Cmd/Ctrl+F 唤起检索胶囊:事件源在 Chat.tsx(chat-global-shortcuts 是全局快捷键单一事实源)
  useEffect(() => {
    const openSearch = () => setInSessionSearchOpen(true);
    window.addEventListener(IN_SESSION_SEARCH_OPEN_EVENT, openSearch);
    return () => window.removeEventListener(IN_SESSION_SEARCH_OPEN_EVENT, openSearch);
  }, []);
  const dictation = useDictation();
  const addFiles = useChatFileInput({ images, documents, onImagesChange, onDocumentsChange });
  // 切换会话：消息内容整体换掉（跨会话没有可比的旧坐标），用一次只碰 opacity 的淡入表达「切换」。
  // 不做重挂载——长会话重挂全部气泡的代价远超一条合成器动画；key 记在模块级，
  // 外壳整块重挂载时同样能判断出「换过会话」。
  useSwitchFade(threadRef, session ? String(session.id || 'draft') : '');

  useMobileOverscrollFeedback(scrollContainerRef);
  const startDictation = useCallback(() => {
    dictation.start(input, onInputChange);
  }, [dictation, input, onInputChange]);
  const activeProvider = session
    ? (selectedAccount && (session.draft || isSessionAccountProviderCompatible(session, selectedAccount.provider))
        ? selectedAccount.provider : session.provider)
    : '';

  // 拖拽多模态图片/文件进入 Composer
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  }, [isDragging]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    void addFiles(Array.from(files));
  }, [addFiles]);

  // 处理粘贴图片
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!shouldConvertLargePaste(text)) return;
    e.preventDefault();
    void addFiles.addPastedText(text);
  }, [addFiles]);

  // 处理文件选择
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    void addFiles(Array.from(files));
    e.target.value = ''; // reset
  };

  const removeImage = (idx: number) => {
    onImagesChange?.(images.filter((_, i) => i !== idx));
  };

  const selectedAccountRef = String(selectedAccount?.accountRef || '').trim();
  const aihServerSelected = isAihServerAccount(selectedAccount);
  const aihServerProvider = aihServerSelected ? String(selectedAccount?.provider || '') : '';
  // 网关目标是全局唯一标识（不绑 provider），与账号菜单的 option id 一致。
  const selectedTargetKey = aihServerSelected ? GATEWAY_SELECTION_SCOPE : selectedAccountRef;
  const accountModelIds = accountModelState.targetKey === selectedTargetKey ? accountModelState.ids : [];
  const effectiveSelectedModel = resolveEffectiveSelectedModel(selectedModel, accountModelIds);
  const activeModelMeta = accountModelState.metadata && effectiveSelectedModel
    ? accountModelState.metadata[effectiveSelectedModel]
    : undefined;
  const dynamicMaxTokens = activeModelMeta?.limits?.context
    || (effectiveSelectedModel.toLowerCase().includes('flash-image') ? 65536 : 128000);

  // 加载当前账号启用模型：会话框只能使用账号投影，不能回退到 provider 聚合列表。
  // 缓存优先 + 后台异步刷新：切账号时若有缓存立即显示（不清空、不闪"无可用模型"），
  // 同时后台拉最新，回来再更新缓存与显示。
  useEffect(() => {
    if (!selectedTargetKey) {
      setAccountModelState({ targetKey: '', ids: [], defaultModel: '', loading: false });
      return;
    }

    let cancelled = false;
    // 内存缓存 → localStorage 持久缓存,任一命中即立即渲染,消除刷新/冷启动的"无可用模型"闪烁。
    let cached = accountModelCatalogCache.get(selectedTargetKey);
    if (!cached) {
      const persisted = readPersistedCatalog(selectedTargetKey);
      if (persisted) {
        cached = persisted;
        accountModelCatalogCache.set(selectedTargetKey, persisted);
      }
    }
    setAccountModelState({
      targetKey: selectedTargetKey,
      ids: cached ? cached.ids : [],
      defaultModel: cached ? cached.defaultModel : '',
      loading: true
    });
    // 网关账号：拉全量目录(不带 accountRef 作用域)，用 provider 聚合列表；普通账号：账号投影。
    modelsAPI.listCatalog(aihServerSelected ? {} : { accountRef: selectedAccountRef })
      .then((catalog) => {
        const next = aihServerSelected
          ? { ids: listAihServerModels(catalog, aihServerProvider), defaultModel: '', metadata: catalog.metadata }
          : {
              ids: listAccountEnabledModels(catalog, selectedAccountRef),
              defaultModel: getAccountDefaultModel(catalog, selectedAccountRef),
              metadata: catalog.metadata
            };
        // 空结果(账号真无模型 or 探测失败)不覆盖已有非空缓存,避免从"有模型"倒退成"无可用模型"。
        const prior = accountModelCatalogCache.get(selectedTargetKey);
        const effective = next.ids.length > 0
          ? next
          : (prior && prior.ids.length > 0 ? prior : next);
        accountModelCatalogCache.set(selectedTargetKey, effective);
        writePersistedCatalog(selectedTargetKey, effective);
        if (!cancelled) {
          setAccountModelState({ targetKey: selectedTargetKey, ...effective, loading: false });
        }
      })
      .catch(() => {
        // 刷新失败：保留缓存内容，仅结束 loading，不清空成"无可用模型"。
        if (!cancelled) {
          setAccountModelState((prev) => (
            prev.targetKey === selectedTargetKey ? { ...prev, loading: false } : prev
          ));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAccountRef, selectedTargetKey, aihServerSelected, aihServerProvider, catalogReloadToken]);

  // 缓存失效本身由模块级订阅处理（见 account-model-catalog-cache）；这里只负责
  // 让加载 effect 重跑 —— 它只依赖 selectedTargetKey，切换账号才触发，模型目录变了
  // 得靠这个 token 显式推一次。
  useEffect(() => onAccountModelCatalogChanged(() => {
    setAccountModelState((prev) => ({ ...prev, loading: true }));
    setCatalogReloadToken((token) => token + 1);
  }), []);

  const hasSession = Boolean(session);
  useEffect(() => {
    if (!hasSession) {
      setSlashCommands([]);
      setSlashPassthrough(false);
      return;
    }
    const provider = activeProvider;
    let cancelled = false;
    chatAPI.getSlashCommands(provider)
      .then((response) => {
        if (!cancelled) {
          setSlashCommands(response.commands || []);
          setSlashPassthrough(response.slashPassthrough === true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSlashCommands([]);
          setSlashPassthrough(false);
        }
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
    ? accounts.filter((account) => isSessionAccountProviderCompatible(session, account.provider))
    : accounts
  ).filter(isChatSelectableAccount);

  /**
   * 网关目标该带哪个 provider —— 只影响 harness 目录命名与模型元数据解析，不进标识
   * （网关目标是全局唯一的，见 aih-server-account 的 GATEWAY_SELECTION_SCOPE）。
   *
   * 优先沿用当前会话/选中目标已有的 provider（存量 `gateway:<provider>` 会话因此保持原样），
   * 否则退回会话 provider，最后退回首个可用账号的 provider。
   */
  const gatewayTargetProvider: Provider = (() => {
    const fromSelected = isAihServerAccount(selectedAccount)
      ? String(selectedAccount?.provider || '').trim()
      : '';
    if (fromSelected) return fromSelected as Provider;
    // 存量会话：accountRef 可能还是旧的 `gateway:<provider>`，从中取回 provider。
    const fromLegacyScope = providerFromGatewayScope(session?.accountRef);
    if (fromLegacyScope) return fromLegacyScope;
    const fromSession = String(session?.provider || '').trim();
    if (fromSession) return fromSession as Provider;
    return (filteredAccounts[0]?.provider || 'codex') as Provider;
  })();

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
  const hasUnsupportedSlashCommand = Boolean(slashToken) && !matchedSlashCommand
    && slashMatches.length === 0 && !slashPassthrough;
  const embeddedSlashMatch = !trimmedInput.startsWith('/')
    ? slashCommands.find((item) => {
        const tokens = trimmedInput.split(/\s+/).filter(Boolean);
        return tokens.includes(item.command) || item.aliases.some((alias) => tokens.includes(alias));
      }) || null
    : null;

  // @ 文件引用：光标前最近的 `@query` token（行首或空白后的 @ 片段）触发文件树下拉。
  // 与 slash 命令互斥：slashToken 存在时不弹文件引用（slash 命令必须单独发送，不混普通文本）。
  const [selectedFileRefIndex, setSelectedFileRefIndex] = useState(0);
  const [fileRefDismissed, setFileRefDismissed] = useState(false);
  const pendingFileRefCaretRef = useRef<number | null>(null);
  const fileRefMatch = useMemo(() => {
    if (slashToken) return null;
    const el = textareaRef.current;
    const caret = el && typeof el.selectionStart === 'number' ? el.selectionStart : input.length;
    const before = input.slice(0, caret);
    const match = before.match(/(?:^|\s)@([^\s@]{0,80})$/);
    if (!match) return null;
    return { query: match[1], start: caret - match[1].length - 1, end: caret };
  }, [input, slashToken]);
  const fileRefMenuOpen = Boolean(fileRefMatch) && !fileRefDismissed;
  const fileRefs = useFileReferenceCandidates(
    session?.projectPath,
    fileRefMatch?.query || '',
    fileRefMenuOpen,
  );
  // 输入继续变化时解除 Esc 屏蔽；query 变化时回到第一个候选。
  useEffect(() => { setFileRefDismissed(false); }, [input]);
  useEffect(() => { setSelectedFileRefIndex(0); }, [fileRefMatch?.query]);
  useEffect(() => {
    setSelectedFileRefIndex((current) => Math.min(current, Math.max(0, fileRefs.candidates.length - 1)));
  }, [fileRefs.candidates.length]);

  const applyFileReference = useCallback((item: FileReferenceCandidate | null) => {
    if (!item || !fileRefMatch) return;
    const inserted = `@${item.path} `;
    pendingFileRefCaretRef.current = fileRefMatch.start + inserted.length;
    onInputChange(`${input.slice(0, fileRefMatch.start)}${inserted}${input.slice(fileRefMatch.end)}`);
  }, [fileRefMatch, input, onInputChange]);

  // 选中插入后把光标恢复到插入片段末尾（受控 value 变更会把光标甩到末尾）。
  useLayoutEffect(() => {
    if (pendingFileRefCaretRef.current === null) return;
    const pos = pendingFileRefCaretRef.current;
    pendingFileRefCaretRef.current = null;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  }, [input]);
  const isTerminated = isTerminatedProp || session?.status === 'stopped' || session?.status === 'archived';
  // 非 draft 的不可续写原生会话（如 zcode/kimi/kiro）：禁用输入框，防止消息落到
  // 无状态推理端点，产生 OAuth 报错或「刷新即消失」的幽灵轮次。
  const nativeWriteBlock = resolveNativeSessionWriteBlock(session);
  const accountDefaultModel = accountModelState.targetKey === selectedTargetKey ? accountModelState.defaultModel : '';
  const models = accountModelIds.map(m => ({ label: m, value: m }));
  const modelsLoading = accountModelState.targetKey === selectedTargetKey && accountModelState.loading;
  // 加载中且暂无模型 → "加载中…"；确实空 → "无可用模型"。避免刷新窗口误显示"无可用模型"。
  const emptyModelHint = modelsLoading && models.length === 0 ? '加载中…' : '无可用模型';
  const hasAccountModel = Boolean(effectiveSelectedModel);
  const hasPendingAttachments = addFiles.pending.length > 0;
  const canSend = !isTerminated && !nativeWriteBlock && hasAccountModel && !hasPendingAttachments
    && (trimmedInput.length > 0 || images.length > 0 || documents.length > 0)
    && !embeddedSlashMatch && !hasUnsupportedSlashCommand;

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
    return filterRenderableChatMessages(pendingState.messages);
  }, [activeProvider, externalPending, externalPendingStatusText, loading, loadingStatusText, messages]);

  // 追加一条消息：只让新出现的消息行淡入上移（流式内容变化 id 不变，不会重播）。
  // 气泡 key 是「角色-位置」，切会话时位置会重合，所以用会话 id 做基线重置。
  const messageKeys = useMemo(
    () => displayMessages.map((msg, index) => `${msg.role}-${index}`),
    [displayMessages]
  );
  useAppendEnter(threadRef, messageKeys, session ? String(session.id || 'draft') : 'draft', {
    selector: '[data-chat-anchor-key]',
  });

  const renderedMessageNodes = useMemo(() => (
    displayMessages.map((msg, i) => {
      const isFollowup = msg.role === 'assistant' && i > 0 && displayMessages[i - 1].role === 'assistant';
      return (
      <CaptureIdentityBoundary
        // key 必须稳定：不能把 pending 编进去，否则流式回复从 pending→done 时
        // key 变化会强制卸载重挂整个气泡，造成"闪屏"。消息位置(i)在流式期间不变，
        // 内容变化由 message prop 触发正常 re-render，无需用 key 强制刷新。
        key={`${msg.role}-${i}`}
        provider={getProviderLabel(sessionProvider)}
        model={effectiveSelectedModel || msg.model || session?.model || ''}
      >
        <MessageBubble
          isFollowup={isFollowup}
          message={msg}
          provider={sessionProvider}
          session={session}
          mobile={mobile}
          onRetry={msg.role === 'assistant' && onRetry ? () => onRetry(displayMessages[i - 1]?.content || '') : undefined}
          onFork={() => onForkSession?.(i)}
        />
      </CaptureIdentityBoundary>
      );
    })
  ), [displayMessages, effectiveSelectedModel, mobile, sessionProvider, session, onRetry, onForkSession]);

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
  // 选项卡退场期间仍需留在 dock 栈里，否则整个栈会随判定一起卸载、退场动画看不到
  const planChoicePresence = useCollapsePresence(showPlanChoiceDock, 160);
  // 回到底部按钮：隐藏时留 140ms 播放退场（否则滚到顶部/底部时按钮直接消失，是整段交互里最突兀的硬切）
  const scrollBtnPresence = useCollapsePresence(showScrollBottom, 140);
  // 移除排队消息：先留 170ms 播退场（.aih-leaving）再卸载，队列不会「点一下整行消失」。
  const queuePresence = usePresenceList(queuedMessages, (item) => item.id, 170);
  const hasComposerDock = Boolean(activeChecklist) || planChoicePresence.present || showTerminalDock
    || queuePresence.render.length > 0;
  const helperFontSize = mobile ? 13 : 12;

  // 会话模型默认值的唯一解析处（切会话按会话键重算，不靠"模型失效"触发，避免与父组件竞争）：
  //   · 新会话(draft) / 无记录 → 账号默认模型
  //   · 已存在会话 → 该会话上次实际用的模型：先本标签页内存(最新选择/发送，盖过扫描滞后)，
  //     再服务端持久化(model_usage_records，跟随 server、可读历史)，都没有才退账号默认
  //   · 兜底 → 第一个可用模型
  // 用户在本会话手动选过则保留其选择、不被默认覆盖。
  const sessionModelKey = getSessionModelKey(session);
  // 「用户是否在本会话手选过模型」的归属改用会话实例 id(草稿也有 draft-xxx id)跟踪。
  // 旧实现用 sessionModelKey,但 getSessionModelKey 对草稿会话返回 '',导致 userPicked 判定里的
  // Boolean(sessionModelKey) 恒 false → 草稿里任何手选都被下方自动解析副作用覆盖回 accountModelIds[0];
  // agy 账号无默认模型时,表现为「webchat 改不动 agy 模型、总弹回第一个」。
  const sessionPickIdentity = session ? String(session.id || '') : '';
  const pickedSessionKeyRef = useRef('');

  // 拉取该会话在服务端记录的最近用模（跟随当前 server）。draft / 无 id 不拉。
  const persistedSessionProvider = session?.provider || '';
  const persistedSessionId = session && !session.draft ? session.id : '';
  const [serverSessionModel, setServerSessionModel] = useState('');
  useEffect(() => {
    setServerSessionModel('');
    if (!persistedSessionProvider || !persistedSessionId) return;
    let cancelled = false;
    sessionsAPI.getLastModel(persistedSessionProvider, persistedSessionId)
      .then((model) => { if (!cancelled) setServerSessionModel(String(model || '')); })
      .catch(() => {});
    return () => { cancelled = true; };
    // 目录快照会刷新标题和时间；同一会话的元数据更新不应重发模型请求。
  }, [persistedSessionProvider, persistedSessionId]);

  useEffect(() => {
    if (!session) return;
    if (!accountModelIds.length) return; // 目录未就绪：先不解析，别清空、别闪切
    const isValid = (id: string) => Boolean(id) && accountModelIds.includes(id);
    const userPicked = Boolean(sessionPickIdentity) && pickedSessionKeyRef.current === sessionPickIdentity;
    if (userPicked && isValid(selectedModel)) return; // 用户在本会话手选过且仍有效 → 保留
        let nextModel = '';
    if (session && !session.draft) {
      const remembered = recallSessionModel(session);
      if (isValid(remembered)) nextModel = remembered;

      // 1. 优先从历史消息列表中提取最后一条成功消息的模型（最高优先级真相）
      if (!nextModel && Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          const candidate = String(m?.model || '').trim();
          if (candidate && isValid(candidate)) {
            nextModel = candidate;
            break;
          }
        }
      }

      // 2. 其次读服务端持久化记录的会话模型
      if (!nextModel && isValid(serverSessionModel)) nextModel = serverSessionModel;
    }
    if (!nextModel && isValid(accountDefaultModel)) nextModel = accountDefaultModel;
    if (!nextModel) nextModel = accountModelIds[0] || '';
    if (selectedModel !== nextModel) onModelChange(nextModel);
  }, [accountDefaultModel, accountModelIds, messages, onModelChange, selectedModel, session, sessionModelKey, serverSessionModel]);

  // 用户显式切换模型：标记本会话已手选 + 记入内存（draft 时 key 为空自动跳过），即时反映到解析。
  const handleModelPick = useCallback((model: string) => {
    pickedSessionKeyRef.current = sessionPickIdentity;
    onModelChange(model);
    try { import("@/services/cross-tab-session-sync").then(m => m.crossTabSync.broadcast("MODEL_CHANGED", { model })); } catch {}
    rememberSessionModel(session, model); // 非草稿才真正记忆(draft key 为空自动跳过)
  }, [onModelChange, session, sessionPickIdentity]);

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
    // @ 文件引用菜单打开时优先接管导航键（与 slash 命令互斥，见 fileRefMatch）。
    if (fileRefMenuOpen) {
      const count = fileRefs.candidates.length;
      if (e.key === 'Escape') {
        e.preventDefault();
        setFileRefDismissed(true);
        return;
      }
      if (count > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setSelectedFileRefIndex((current) => (
          e.key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count
        ));
        return;
      }
      if (count > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
        e.preventDefault();
        applyFileReference(fileRefs.candidates[selectedFileRefIndex] || fileRefs.candidates[0] || null);
        return;
      }
    }

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
    applyFileReference,
    applySlashCommand,
    embeddedSlashMatch,
    fileRefMenuOpen,
    fileRefs.candidates,
    handleKeyDown,
    hasUnsupportedSlashCommand,
    matchedSlashCommand,
    onInputChange,
    selectedFileRefIndex,
    selectedSlashIndex,
    slashPassthrough,
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
      {/* 会话内关键词检索胶囊 */}
      <InSessionSearchBar
        open={inSessionSearchOpen}
        onClose={() => setInSessionSearchOpen(false)}
        messages={displayMessages}
        onScrollToMessage={(idx) => {
          const container = scrollContainerRef.current;
          if (!container) return;
          const target = container.querySelector(`[data-chat-anchor-key*="${idx}"]`) as HTMLElement;
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }}
      />
      {/* 消息列表 */}
      <div
        className={`${styles.messageArea} ${mobile ? styles.messageAreaMobile : ''}`}
        ref={scrollContainerRef}
        onScroll={handleScroll}
        data-provider={sessionProvider}
        style={providerAccentStyle(sessionProvider)}
      >
        <div className={styles.messageThread} ref={threadRef}>
          {displayMessages.length === 0 ? (
            <div className={styles.welcomeState}>
              <div className={styles.welcomeTitle}>你今天想聊些什么？</div>
              <div className={styles.welcomeHint}>
                可以附加图片、视频、Markdown、文本和代码文件，也可以使用系统输入法语音输入。
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
                    background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--hos-radius-xs)',
                    padding: mobile ? '6px 16px' : '4px 16px', cursor: 'pointer', fontSize: mobile ? 13 : 12, color: 'var(--color-muted-strong)'
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

        {scrollBtnPresence.present && (
          <button
            onClick={scrollToBottom}
            className={`${styles.scrollBottomBtn} ${scrollBtnPresence.expanded ? '' : styles.scrollBottomBtnLeaving}`}
          >
            <ArrowDownOutlined />
          </button>
        )}
      </div>

      {/* ChatGPT 风格输入区域 */}
      <div className={`${styles.inputArea} ${mobile ? styles.inputAreaMobile : ''}`}>
        <StatsLine messages={messages} />
        <div
          className={`${styles.composerShell} ${isDragging ? styles.composerShellDragging : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{ position: 'relative' }}
        >
          {isDragging ? (
            <div className={styles.composerDropOverlay}>
              <span>拖放文件至此处附加</span>
            </div>
          ) : null}
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
            {queuePresence.render.length > 0 ? (
              <div ref={queueFlipRef} className={`${styles.queueDock} ${styles.composerDockCard}`}>
                <div className={styles.queueDockHeader}>
                  <span className={styles.queueDockTitle}>{`排队消息 ${queuedMessages.length}`}</span>
                  <span className={styles.queueDockHint}>
                    运行中继续输入的需求会在这里排队
                  </span>
                </div>
            {queuePresence.render.map(({ item, leaving }, index) => (
              <div
                key={item.id}
                data-flip-key={item.id}
                className={`${styles.queueItem}${leaving ? ' aih-leaving' : ''}`}
                aria-hidden={leaving || undefined}
              >
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
                  {onSteerQueuedMessage && (loading || externalPending) ? (
                    <button
                      type="button"
                      className={styles.queueActionBtn}
                      onClick={() => onSteerQueuedMessage(item.id)}
                      title="插话:立即注入当前运行(不打断),模型在当前动作后处理"
                    >
                      插话
                    </button>
                  ) : null}
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
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--color-muted)', fontSize: 13, userSelect: 'none' }}>
              此会话已归档，无法继续对话。
            </div>
          ) : nativeWriteBlock ? (
            <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--color-muted)', fontSize: 13, userSelect: 'none' }}>
              {nativeWriteBlock}
            </div>
          ) : (
            <div className={`${styles.inputBox} ${mobile ? styles.inputBoxMobile : ''}`}>
            {/* 多模态附件画廊 */}
            <ComposerAttachmentGallery images={images} onRemove={removeImage}
              documents={documents} onRemoveDocument={(index) => onDocumentsChange?.(documents.filter((_, i) => i !== index))}
              pending={addFiles.pending}
              onRetryPending={(key) => { void addFiles.retryPending(key); }}
              onRemovePending={addFiles.removePending} />
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
              color: hasUnsupportedSlashCommand ? 'var(--color-warning)' : 'var(--color-accent)'
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
                  未识别的命令 <strong>{slashToken}</strong>（当前 provider 不支持透传）。
                </>
              ) : slashPassthrough ? (
                <>命令将透传给 provider CLI：<strong>{slashToken}</strong>，可附带参数。</>
              ) : (
                <>
                  正在选择命令。Slash 命令必须单独发送，可在命令后附带参数，但不能和普通聊天文本混发。
                </>
              )}
            </div>
          )}
          <SlashCommandMenu
            commands={slashMatches}
            selectedIndex={selectedSlashIndex}
            onSelect={applySlashCommand}
            onHoverIndex={setSelectedSlashIndex}
            visible={Boolean(slashToken && slashMatches.length > 0)}
          />
          <FileReferencePopover
            candidates={fileRefs.candidates}
            loading={fileRefs.loading}
            fetchError={fileRefs.fetchError}
            hasProject={Boolean(session?.projectPath)}
            selectedIndex={selectedFileRefIndex}
            onSelect={applyFileReference}
            onHoverIndex={setSelectedFileRefIndex}
            visible={fileRefMenuOpen}
          />
          {embeddedSlashMatch && (
            <div style={{ padding: '0 12px 8px', fontSize: helperFontSize, color: 'var(--color-warning)' }}>
              检测到命令 {embeddedSlashMatch.command}。Slash 命令必须单独发送，不能和普通文本混在同一条消息里。
            </div>
          )}
          {/* 隐藏文件输入 */}
          <input
            ref={fileInputRef}
            type="file"
            accept={CHAT_ATTACHMENT_ACCEPT}
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          {/* 底部工具栏 */}
          <div className={styles.inputToolbar}>
            <div className={styles.inputToolbarLeft}>
              <button
                className={styles.inputToolbarBtn}
                title="上传文件"
                aria-label="上传文件"
                onClick={() => fileInputRef.current?.click()}
              >
                <PlusOutlined style={{ fontSize: 16 }} />
              </button>
              {!dictation.recording && (
                <button
                  type="button"
                  className={styles.inputToolbarBtn}
                  title="打开终端"
                  aria-label="打开终端"
                  onClick={() => void openProjectTerminal(terminalCwd)}
                >
                  <CodeOutlined style={{ fontSize: 16 }} />
                </button>
              )}
              {dictation.recording ? null : mobile ? (
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
                <ComposerAccountMenu
                  value={selectedAccount
                    ? (isAihServerAccount(selectedAccount)
                        ? GATEWAY_SELECTION_SCOPE
                        : selectedAccount.accountRef)
                    : ''}
                  options={[
                    // 网关目标全局唯一一条：不钉账号、也不钉 provider，由网关按模型 id 挑号。
                    // provider 取当前会话/首个可用者，仅用于 harness 目录命名与元数据解析。
                    ...(gatewayTargetProvider ? [{
                      id: GATEWAY_SELECTION_SCOPE,
                      provider: gatewayTargetProvider,
                      label: AIH_SERVER_ACCOUNT_LABEL,
                      badge: 'gateway',
                    }] : []),
                    ...filteredAccounts.map((account) => ({
                      id: account.accountRef,
                      provider: account.provider,
                      label: formatChatAccountLabel(account),
                      badge: account.apiKeyMode ? 'key' : 'OAuth',
                    })),
                  ]}
                  onChange={(value) => {
                    if (value === GATEWAY_SELECTION_SCOPE) {
                      onAccountChange(makeAihServerAccount(gatewayTargetProvider));
                      return;
                    }
                    const account = filteredAccounts.find((candidate) => candidate.accountRef === value);
                    if (account) onAccountChange(account);
                  }}
                />
              )}
              {onApprovalModeChange && !mobile && !dictation.recording ? (
                <ComposerApprovalMenu value={approvalMode} onChange={onApprovalModeChange} />
              ) : null}
            </div>
            <div className={`${styles.inputToolbarRight} ${dictation.recording ? dictationStyles.toolbarRightRecording : ''}`}>
              {dictation.recording ? (
                <DictationRecordingBar elapsedSeconds={dictation.elapsedSeconds} onStop={dictation.stop} />
              ) : (
                <>
                  {!mobile ? (
                    <ComposerModelMenu
                      models={models.map((model) => ({
                        id: model.value,
                        label: model.label,
                        supportedEfforts: [],
                        defaultEffort: '',
                      }))}
                      model={effectiveSelectedModel}
                      effort=""
                      loading={modelsLoading}
                      onModelChange={handleModelPick}
                      onEffortChange={() => {}}
                    />
                  ) : null}
                  {!mobile && dictation.supported ? (
                    <DictationButton onClick={startDictation} />
                  ) : null}
                </>
              )}
              <PromptPresetsCapsule onSelect={(tpl) => onInputChange(tpl)} mobile={mobile} />
              <ContextMeter
                messages={messages}
                maxTokens={dynamicMaxTokens}
                onCompactSuggest={() => onInputChange('/compact')}
              />
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
            content: { borderRadius: 'var(--hos-radius-md) var(--hos-radius-md) 0 0', overflow: 'hidden' }
          }}
        >
          <div className={styles.mobileSheetHandle} />
          <div className={styles.mobileControlsSection}>
            <div className={styles.mobileControlsLabel}>账号</div>
            <Select
              value={selectedAccount
                ? (isAihServerAccount(selectedAccount)
                    ? GATEWAY_SELECTION_SCOPE
                    : selectedAccount.accountRef)
                : undefined}
              onChange={(value) => {
                if (value === GATEWAY_SELECTION_SCOPE) {
                  onAccountChange(makeAihServerAccount(gatewayTargetProvider));
                  return;
                }
                const account = accounts.find(a => a.accountRef === value);
                if (account) onAccountChange(account);
              }}
              options={[
                // 网关目标全局唯一一条：不钉账号、不钉 provider，由网关按模型 id 挑号。
                // 图标用会话 provider（仅视觉），不参与标识。
                ...(filteredAccounts.length > 0 || supportsAihServer(gatewayTargetProvider) ? [{
                  label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ProviderIcon provider={gatewayTargetProvider} size={14} />
                    <span>{AIH_SERVER_ACCOUNT_LABEL}</span>
                    <span title="网关" style={{ fontSize: 10, color: 'var(--color-muted)' }}>网关</span>
                  </span>,
                  value: GATEWAY_SELECTION_SCOPE
                }] : []),
                ...filteredAccounts.map(acc => ({
                  label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ProviderIcon provider={acc.provider} size={14} />
                    <span>{formatChatAccountLabel(acc)}</span>
                    {acc.apiKeyMode ? <span title="API Key">key</span> : null}
                  </span>,
                  value: acc.accountRef
                }))
              ]}
              style={{ width: '100%' }}
              size="large"
            />
          </div>
          <div className={styles.mobileControlsSection}>
            <div className={styles.mobileControlsLabel}>模型</div>
            <Select
              value={effectiveSelectedModel || undefined}
              onChange={handleModelPick}
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
