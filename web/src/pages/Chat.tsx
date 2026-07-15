import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Layout, message, Empty, Modal, Input, Grid, Breadcrumb } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import { chatAPI, accountsAPI, sessionsAPI, isSessionRequestCancelled, guardedWebUiEventSource, resolveActiveServer } from '@/services/api';
import {
  CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY,
  CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY,
  CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY,
  CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY,
  clearLoadFailureMessage,
  showLoadFailureMessage
} from '@/services/load-failure-message.js';
import {
  advanceSessionHistoryWindow,
  didSessionHistoryCursorReset,
  didSessionHistorySnapshotReset,
  isSessionHistorySnapshotCurrent,
  loadContiguousSessionHistoryTail,
  rebaseLatestSessionHistoryTail,
  rebaseOlderSessionHistoryPage
} from '@/services/session-history-window.js';
import {
  applyProjectSessionHydrationResponse,
  canApplyProjectSessionHydration,
  isHydratedProjectSessionsStale,
  isProjectSessionSnapshotComplete,
  preserveHydratedProjectSessions,
  shouldHydrateProjectSessions
} from '@/services/project-session-hydration.js';
import { isAbsoluteProjectPath } from '@/services/project-path-policy.js';
import type {
  ChatMessage,
  Account,
  ChatAccount,
  AggregatedProject,
  Session,
  SessionMessageBundle,
  ChatStreamEvent,
  SessionEventItem,
  Provider,
  QueuedChatMessage,
  InteractivePrompt
} from '@/types';
import { ProjectList, MessageArea } from '@/components/chat';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import MobileBackButton from '@/components/mobile/MobileBackButton';
import type { TerminalRunState } from '@/components/chat/TerminalDock';
import { providerAccentStyle } from '@/components/chat/provider-registry';
import styles from '@/components/chat/chat.module.css';
import {
  getActualSessionRunKey,
  getSessionRunKey,
  findActiveRunKeyForSession as findActiveRunKeyForSessionState,
  collectRunningSessionKeys,
  resolveSelectedSessionQueueKey
} from '@/components/chat/active-run-state.js';
import { isSessionRunning as isProjectSessionRunning } from '@/components/chat/project-runtime-state.js';
import { rememberSessionModel } from '@/components/chat/account-model-selection.js';
import { isAihServerAccount, makeAihServerAccount } from '@/components/chat/aih-server-account';
import {
  applySessionAssistantEvent,
  applyStreamingAssistantEvent
} from '@/components/chat/assistant-event-adapter.js';
import {
  getThinkingStatusText,
  getProcessingStatusText,
  getGeneratingStatusText,
  shouldUseExternalPending
} from '@/components/chat/provider-pending-policy.js';
import { resolveSessionWatchUpdateAction } from '@/components/chat/session-watch-state.js';
import {
  supportsBackgroundRunWatch,
  supportsMidRunSteer,
  supportsSessionWatchPending,
  supportsToolBoundaryQueue
} from '@/components/chat/provider-capabilities.js';
import {
  appendQueuedMessage,
  prependQueuedMessage,
  removeQueuedMessage,
  shiftQueuedMessage,
  shiftQueuedMessageByMode,
  moveQueuedMessages as moveQueuedMessagesState,
  moveQueuedMessageToFront,
  resolveQueuedMode,
  readPersistedQueue,
  writePersistedQueue
} from '@/components/chat/queue-state.js';
import { FolderOpenOutlined, PlusOutlined, RightOutlined, LoadingOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import {
  readPersistedSelection,
  writePersistedSelection
} from './chat-selection-state.js';
import {
  buildAssistantCompletionNotification,
  normalizeMessageText,
  shouldNotifyAssistantCompleted
} from './chat-notification.js';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const { Sider, Content } = Layout;

// 已知上游/网关错误码 → 干净可执行的中文提示。后端(webui-chat-routes)已尽量翻译，
// 这里是前端安全网：兜住仍然漏出错误码或嵌套 JSON 的路径，避免把 upstream_error /
// {"error":"no_available_account",...} 这种技术串直接甩到用户脸上。
const CHAT_ERROR_CODE_MESSAGES: Record<string, string> = {
  no_available_account: '当前 server 上没有可用于该模型的账号：账号可能未在此 server 完成登录/凭据配置，或该模型不在账号的可用清单里。请在「账号」页补全该 server 的账号，或改用其他账号/模型。',
  account_not_configured: '所选账号在当前 server 上尚未完成配置（缺少登录凭据）。请先在「账号」页为该 server 补全登录后再发送。',
  invalid_claude_api_config: 'claude API Key 或 ANTHROPIC_BASE_URL 缺失，请在「账号」页补全配置。',
  missing_model: '请先选择一个模型再发送。',
  model_required: '请先选择一个模型再发送。',
  model_not_found: '该模型在当前 server 上不可用，请改用其他模型。',
  rate_limited: '该账号当前被上游限流/熔断，请稍后重试或改用其他账号。',
  cooldown: '该账号当前被上游限流/熔断，请稍后重试或改用其他账号。'
};

const humanizeChatError = (err: any, fallback: string): string => {
  const data = err?.response?.data;
  // 后端翻译后的干净 message 最优先。
  const backendMessage = typeof data?.message === 'string' ? data.message.trim() : '';
  if (backendMessage && backendMessage !== data?.error) return backendMessage;

  const code = typeof data?.error === 'string' ? data.error : '';
  if (code && CHAT_ERROR_CODE_MESSAGES[code]) return CHAT_ERROR_CODE_MESSAGES[code];

  // sendStream 抛的是普通 Error，其 message 可能已是干净中文，也可能仍是错误码/JSON。
  const rawMessage = typeof err?.message === 'string' ? err.message.trim() : '';
  if (rawMessage) {
    if (CHAT_ERROR_CODE_MESSAGES[rawMessage]) return CHAT_ERROR_CODE_MESSAGES[rawMessage];
    if (rawMessage[0] === '{' || rawMessage[0] === '[') {
      try {
        const parsed = JSON.parse(rawMessage);
        const parsedCode = typeof parsed?.error === 'string' ? parsed.error : '';
        if (parsedCode && CHAT_ERROR_CODE_MESSAGES[parsedCode]) return CHAT_ERROR_CODE_MESSAGES[parsedCode];
        const parsedMessage = typeof parsed?.message === 'string' ? parsed.message.trim()
          : (typeof parsed?.detail === 'string' ? parsed.detail.trim() : '');
        if (parsedMessage) return parsedMessage;
      } catch (_error) {
        // 非 JSON，按原样往下走。
      }
    }
    if (backendMessage) return backendMessage;
    return rawMessage;
  }

  if (backendMessage) return backendMessage;
  return fallback;
};

const getProjectLastActivityAt = (project: AggregatedProject) => {
  if (!Array.isArray(project.sessions) || project.sessions.length === 0) {
    return Number(project.addedAt) || 0;
  }
  return Math.max(
    ...project.sessions.map((session) => Number(session.updatedAt) || 0),
    Number(project.addedAt) || 0
  );
};

const sortSessionsByUpdatedAtDesc = (sessions: Session[]) =>
  [...sessions].sort((left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0));

const sortProjectsByLastActivityDesc = (items: AggregatedProject[]) =>
  [...items].sort((left, right) => getProjectLastActivityAt(right) - getProjectLastActivityAt(left));

const normalizeMessageImages = (images?: string[]) => {
  const seen = new Set<string>();
  return (Array.isArray(images) ? images : [])
    .map((item) => String(item || '').trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
};

const resolveSessionProjectDirName = (
  provider: Provider,
  projectPath?: string,
  projectDirName?: string
) => {
  const normalizedProjectDirName = String(projectDirName || '').trim();
  if (normalizedProjectDirName) return normalizedProjectDirName;
  if (provider !== 'claude') return undefined;
  const normalizedProjectPath = String(projectPath || '').trim();
  if (!normalizedProjectPath) return undefined;
  return normalizedProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
};

const toMessageTimeMs = (timestamp?: string | number) => {
  if (typeof timestamp === 'number') return timestamp;
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

type PersistedChatSelection = {
  projectPath?: string;
  sessionId?: string;
  provider?: string;
  projectDirName?: string;
};

type ActiveSessionRun = {
  runKey: string;
  draftSessionId?: string;
  provider: Provider;
  sessionId?: string;
  runId?: string;
  projectDirName?: string;
  projectPath?: string;
  controller: AbortController;
};

type QueuedSessionMessage = QueuedChatMessage & {
  provider: Provider;
  model?: string;
  mode: 'after_turn' | 'after_tool_call';
} & (
  | { accountRef: string; gateway?: false }
  | { gateway: true; accountRef?: never }
);

const resolveQueuedAccount = (queued: QueuedSessionMessage, accounts: Account[]): ChatAccount | null => {
  if (queued.gateway) return makeAihServerAccount(queued.provider);
  return accounts.find((account) => account.accountRef === queued.accountRef) || null;
};

const pickChatAccount = (
  current: ChatAccount | null,
  accounts: Account[],
  preferredProvider?: Provider
) => {
  // 网关目标不在真实 accounts 列表里，下面按 currentKey 找不到会被 providerMatch 顶掉成
  // 真实账号 → 每次账号轮询刷新都把用户的"走网关"选择清掉。provider 一致(或无偏好)时保留它。
  if (current && isAihServerAccount(current) && (!preferredProvider || current.provider === preferredProvider)) {
    return current;
  }
  // 会话有明确 provider 时，选中账号必须同 provider——否则从 codex 会话切到 opencode/agy 会话后，
  // 账号会死死停在原来的 codex 账号（如 yeslaoban），下拉显示错 provider 的模型、无法切换。
  // 只有 current 与目标 provider 一致（或无偏好）时才保留 current。
  if (current && !isAihServerAccount(current) && (!preferredProvider || current.provider === preferredProvider)) {
    const nextCurrent = accounts.find((account) => account.accountRef === current.accountRef);
    if (nextCurrent) return nextCurrent;
  }
  if (preferredProvider) {
    const providerMatch = accounts.find((account) => account.provider === preferredProvider);
    if (providerMatch) return providerMatch;
  }
  return accounts[0] || null;
};

const areDuplicateUserMessages = (left?: ChatMessage, right?: ChatMessage) => {
  if (!left || !right) return false;
  if (left.role !== 'user' || right.role !== 'user') return false;
  if (normalizeMessageText(left.content) !== normalizeMessageText(right.content)) return false;

  const leftImages = normalizeMessageImages(left.images);
  const rightImages = normalizeMessageImages(right.images);
  if (leftImages.length !== rightImages.length) return false;
  if (leftImages.some((item, index) => item !== rightImages[index])) return false;

  const leftTime = toMessageTimeMs(left.timestamp);
  const rightTime = toMessageTimeMs(right.timestamp);
  if (!leftTime || !rightTime) return true;
  return Math.abs(leftTime - rightTime) <= 30 * 1000;
};

const dedupeChatMessages = (messages: ChatMessage[]) => {
  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    const current: ChatMessage = {
      ...message,
      content: normalizeMessageText(message.content),
      images: normalizeMessageImages(message.images)
    };
    const previous = deduped[deduped.length - 1];
    if (areDuplicateUserMessages(previous, current)) {
      deduped[deduped.length - 1] = {
        ...previous,
        images: (current.images || []).length > 0 ? current.images : previous.images,
        timestamp: current.timestamp || previous.timestamp
      };
      continue;
    }
    deduped.push(current);
  }
  return deduped;
};

const isChatSelectableAccount = (account: Account) => {
  if (!account.configured) return false;
  if (account.status === 'down') return false;
  if (String(account.schedulableStatus || '').trim() && account.schedulableStatus !== 'schedulable') return false;
  const runtimeStatus = String(account.runtimeStatus || '').trim();
  if (runtimeStatus && runtimeStatus !== 'healthy') return false;
  return true;
};

// 项目列表本地缓存：与账号缓存一样按「当前 server」分键。此前全局共用一份（v1），
// 激活远端 server 后先渲染出本机的项目列表（另一台 server 的数据），一旦用它去解析
// 远端会话/项目选中（路径对不上）就把选中清空、把用户踢回空态。
const PROJECTS_CACHE_PREFIX = 'chat-projects-cache:v2:';
const PROJECTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const projectsCacheKey = (): string => {
  try {
    const { serverId } = resolveActiveServer();
    return PROJECTS_CACHE_PREFIX + (serverId || 'local');
  } catch {
    return PROJECTS_CACHE_PREFIX + 'local';
  }
};

const projectHydrationServerKey = (): string => {
  const activeServer = resolveActiveServer();
  return `${activeServer.serverId || 'local'}:${activeServer.isRemote ? 'remote' : 'same-origin'}`;
};

// 账号本地缓存：按「当前 server」分键（本机/各远端账号不同，绝不能全局共用一份）。
// 目的：进会话页先用缓存即时渲染，消除"请先配置可用账号"闪烁 + 远端 450ms 空窗；再异步刷新。
const CHAT_ACCOUNTS_CACHE_PREFIX = 'chat-accounts-cache:v1:';
const CHAT_ACCOUNTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const chatAccountsCacheKey = (): string => {
  try {
    const { serverId } = resolveActiveServer();
    return CHAT_ACCOUNTS_CACHE_PREFIX + (serverId || 'local');
  } catch {
    return CHAT_ACCOUNTS_CACHE_PREFIX + 'local';
  }
};
const readCachedChatAccounts = (): Account[] => {
  if (typeof window === 'undefined') return [];
  try {
    const payload = JSON.parse(localStorage.getItem(chatAccountsCacheKey()) || 'null');
    if (!payload || !Array.isArray(payload.accounts)) return [];
    if (Date.now() - Number(payload.updatedAt || 0) > CHAT_ACCOUNTS_CACHE_TTL_MS) return [];
    return payload.accounts as Account[];
  } catch {
    return [];
  }
};
const writeCachedChatAccounts = (accounts: Account[]): void => {
  if (typeof window === 'undefined') return;
  try {
    // 精简存储：丢掉体积大的 usageSnapshot（会话选账号用不到），把缓存压到几 KB。
    const slim = accounts.map((account) => ({ ...account, usageSnapshot: undefined }));
    localStorage.setItem(chatAccountsCacheKey(), JSON.stringify({ updatedAt: Date.now(), accounts: slim }));
  } catch {}
};

type CachedProjectsPayload = {
  updatedAt: number;
  projects: AggregatedProject[];
};

const readCachedProjects = (): AggregatedProject[] => {
  if (typeof window === 'undefined') return [];
  try {
    const payload = JSON.parse(localStorage.getItem(projectsCacheKey()) || 'null') as CachedProjectsPayload | null;
    if (!payload || !Array.isArray(payload.projects)) return [];
    if (Date.now() - Number(payload.updatedAt || 0) > PROJECTS_CACHE_TTL_MS) return [];
    return payload.projects;
  } catch {
    return [];
  }
};

const writeCachedProjects = (projects: AggregatedProject[]): void => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(projectsCacheKey(), JSON.stringify({
      updatedAt: Date.now(),
      projects
    }));
    // 清掉旧的全局共用键（v1），避免残留另一台 server 的项目列表被误读。
    localStorage.removeItem('chat-projects-cache:v1');
  } catch {}
};

const Chat = () => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [accounts, setAccounts] = useState<Account[]>(() => readCachedChatAccounts().filter(isChatSelectableAccount));
  const [accountsLoadFailed, setAccountsLoadFailed] = useState(false);
  const [projects, setProjects] = useState<AggregatedProject[]>(() => readCachedProjects());
  const [hydratingProjectPaths, setHydratingProjectPaths] = useState<Set<string>>(new Set());
  const [selectedProject, setSelectedProject] = useState<AggregatedProject | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<ChatAccount | null>(null);
  const [allMessages, setAllMessages] = useState<ChatMessage[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [watchPendingStatus, setWatchPendingStatus] = useState<string | null>(null);
  const [runningSessionKeys, setRunningSessionKeys] = useState<Set<string>>(new Set());
  const [passiveRunningSessionKeys, setPassiveRunningSessionKeys] = useState<Set<string>>(new Set());
  const [runStatusByKey, setRunStatusByKey] = useState<Record<string, string>>({});
  const [interactivePromptsByRunKey, setInteractivePromptsByRunKey] = useState<Record<string, InteractivePrompt>>({});
  const [terminalRunsByKey, setTerminalRunsByKey] = useState<Record<string, TerminalRunState>>({});
  const [queuedMessagesByKey, setQueuedMessagesByKey] = useState<Record<string, QueuedSessionMessage[]>>({});
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  // 初值留空：具体默认由 MessageArea 依据「新会话→账号默认 / 已存在会话→上次使用」统一解析。
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [images, setImages] = useState<string[]>([]);
  const [openProjectVisible, setOpenProjectVisible] = useState(false);
  const [openProjectPath, setOpenProjectPath] = useState('');
  const [openProjectName, setOpenProjectName] = useState('');
  const [dirModalVisible, setDirModalVisible] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [dirList, setDirList] = useState<Array<{ name: string; path: string }>>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [selectedDirPath, setSelectedDirPath] = useState('');
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const selectedSessionRef = useRef<Session | null>(null);
  const selectedProjectStateRef = useRef<AggregatedProject | null>(null);
  const projectsRef = useRef<AggregatedProject[]>(projects);
  const hydratedProjectsRef = useRef<Map<string, AggregatedProject>>(new Map(
    projects
      .filter((project) => isProjectSessionSnapshotComplete(project))
      .map((project) => [project.path, project])
  ));
  const hydratedProjectsServerKeyRef = useRef(projectHydrationServerKey());
  const staleHydratedProjectPathsRef = useRef<Set<string>>(new Set());
  const initialSelectionRef = useRef<PersistedChatSelection>(readPersistedSelection());
  const pendingProjectSelectionRef = useRef<PersistedChatSelection>(initialSelectionRef.current);
  const projectSnapshotReceivedAtRef = useRef(0);
  const projectSnapshotRevisionRef = useRef(0);
  const projectSnapshotGenerationRef = useRef(0);
  const projectHttpRequestRef = useRef(0);
  const projectSessionHydrationSequenceRef = useRef(0);
  const latestProjectSessionHydrationRef = useRef<Map<string, number>>(new Map());
  const inflightProjectSessionHydrationRef = useRef<Map<string, Promise<void>>>(new Map());
  const projectSessionHydrationSelectionRef = useRef<Map<string, PersistedChatSelection>>(new Map());
  const projectRefreshFallbackTimerRef = useRef<number | null>(null);
  const activeRunsRef = useRef<Map<string, ActiveSessionRun>>(new Map());
  const sessionMessagesCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  const sessionHistoryWindowCacheRef = useRef<Map<string, SessionMessageBundle>>(new Map());
  const sessionHistoryLoadMoreRef = useRef<Set<string>>(new Set());
  const sessionHistorySelectionRevisionRef = useRef(0);
  const sessionCursorCacheRef = useRef<Map<string, number>>(new Map());
  const sessionReloadTimersRef = useRef<Map<string, number>>(new Map());
  const activeRunWatchersRef = useRef<Map<string, { eventSource: EventSource | null; cursor: number; reconnectTimer: number | null }>>(new Map());
  // 终端写入通道（按 runId）：terminal-output 直接写进 xterm；面板尚未挂载时先缓冲，注册时回放。
  const terminalWritersRef = useRef<Map<string, (data: string) => void>>(new Map());
  const terminalOutputBufferRef = useRef<Map<string, string[]>>(new Map());
  const sessionWatchRef = useRef<EventSource | null>(null);
  // detached run（刷新/断连后仍在服务端跑的 native run）：按会话稳定键记 runId，
  // 用于停止（abortRun）与交互 prompt 回答（sendRunInput）——本地 activeRuns 里没有它。
  const detachedRunRef = useRef<{ sessionKey: string; runId: string } | null>(null);
  // 会话级审批模式(P3):bypass(默认极速)/confirm(权限确认)/plan(计划+确认),按会话持久。
  const [approvalMode, setApprovalMode] = useState<'bypass' | 'confirm' | 'plan'>('bypass');
  const approvalModeRef = useRef<'bypass' | 'confirm' | 'plan'>('bypass');
  approvalModeRef.current = approvalMode;
  const approvalModeStorageKey = (session: Session | null) =>
    session && !session.draft ? `chat-approval-mode:v1:${getSessionRunKey(session)}` : '';
  useEffect(() => {
    const key = approvalModeStorageKey(selectedSession);
    if (!key) { setApprovalMode('bypass'); return; }
    try {
      const saved = window.localStorage.getItem(key);
      setApprovalMode(saved === 'confirm' || saved === 'plan' ? saved : 'bypass');
    } catch { setApprovalMode('bypass'); }
  }, [selectedSession?.id, selectedSession?.projectDirName, selectedSession?.provider]);
  const handleApprovalModeChange = useCallback((mode: 'bypass' | 'confirm' | 'plan') => {
    setApprovalMode(mode);
    const key = approvalModeStorageKey(selectedSessionRef.current);
    if (key) { try { window.localStorage.setItem(key, mode); } catch { /* ignore */ } }
  }, []);
  const sessionWatchReconnectTimerRef = useRef<number | null>(null);
  const projectRuntimeWatchRef = useRef<EventSource | null>(null);
  const projectRuntimeReconnectTimerRef = useRef<number | null>(null);
  const accountsRef = useRef<Account[]>([]);
  const accountsSnapshotReceivedAtRef = useRef(0);
  const accountsHttpRequestRef = useRef(0);
  const watchPendingStartedAtRef = useRef<number>(0);
  const resumeSyncTimerRef = useRef<number | null>(null);
  const notificationPermissionRequestedRef = useRef(false);
  const hiddenAtRef = useRef<number>(0);
  const suppressAbortToastRef = useRef(false);
  const reloadSessionHistoryRef = useRef<(session: Session) => Promise<void>>(async () => {});
  const hydrateProjectSessionsRef = useRef<(
    projectPath: string,
    selection?: PersistedChatSelection,
    force?: boolean
  ) => Promise<void>>(async () => {});
  const applySessionEventsRef = useRef<(
    session: Session,
    events: SessionEventItem[],
    cursor?: number
  ) => void>(() => {});
  const runSessionMessageRef = useRef<null | ((args: {
    session: Session;
    account: ChatAccount;
    model?: string;
    content: string;
    imageList: string[];
  }) => Promise<void>)>(null);

  const INITIAL_MSG_COUNT = 30;
  const LOAD_MORE_COUNT = 20;

  const dropPendingAssistantPlaceholder = () => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const next = current.slice();
      const last = next[next.length - 1];
      if (last && last.role === 'assistant' && last.pending) {
        next.pop();
      }
      return next;
    });
  };

  const updatePendingAssistantStatus = (statusText: string) => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const next = current.slice();
      const last = next[next.length - 1];
      if (!last || last.role !== 'assistant' || !last.pending) return current;
      next[next.length - 1] = {
        ...last,
        statusText
      };
      return next;
    });
  };

  const requestBrowserNotificationPermission = useCallback(() => {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    if (notificationPermissionRequestedRef.current) return;
    notificationPermissionRequestedRef.current = true;
    Notification.requestPermission().catch(() => {});
  }, []);

  const notifyAssistantCompleted = useCallback((provider: Provider, content: string) => {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
    if (!shouldNotifyAssistantCompleted({
      permission: Notification.permission,
      visibilityState: document.visibilityState,
      hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : true
    })) {
      return;
    }
    const payload = buildAssistantCompletionNotification(provider, content, providerNames);
    try {
      new Notification(payload.title, { body: payload.body });
    } catch {}
  }, []);

  const loadMoreHistory = async () => {
    const session = selectedSessionRef.current;
    if (!session || session.draft) return;
    const cacheKey = getSessionCacheKey(session);
    const selectionRevision = sessionHistorySelectionRevisionRef.current;
    const historyWindow = sessionHistoryWindowCacheRef.current.get(cacheKey);
    const currentLen = messages.length;
    const totalLen = allMessages.length;
    if (currentLen < totalLen) {
      const moreCount = Math.min(LOAD_MORE_COUNT, totalLen - currentLen);
      const startIdx = totalLen - currentLen - moreCount;
      setMessages(allMessages.slice(Math.max(0, startIdx)));
      setHasMoreHistory(startIdx > 0 || Boolean(historyWindow?.hasMore));
      return;
    }
    if (!historyWindow?.hasMore || sessionHistoryLoadMoreRef.current.has(cacheKey)) return;

    sessionHistoryLoadMoreRef.current.add(cacheKey);
    try {
      const olderPage = await sessionsAPI.getSessionMessagesBundle(
        session.provider,
        session.id,
        session.projectDirName,
        { before: historyWindow.start, limit: LOAD_MORE_COUNT }
      );
      const latestWindow = sessionHistoryWindowCacheRef.current.get(cacheKey) || historyWindow;
      const merged = rebaseOlderSessionHistoryPage(latestWindow, olderPage) as SessionMessageBundle;
      const addedCount = Math.max(0, latestWindow.start - merged.start);
      sessionHistoryWindowCacheRef.current.set(cacheKey, merged);
      sessionMessagesCacheRef.current.set(cacheKey, merged.messages);
      if (
        !selectedSessionRef.current
        || getSessionCacheKey(selectedSessionRef.current) !== cacheKey
        || sessionHistorySelectionRevisionRef.current !== selectionRevision
      ) return;
      setAllMessages(merged.messages);
      setMessages((current) => [
        ...merged.messages.slice(0, addedCount),
        ...current
      ]);
      setHasMoreHistory(merged.hasMore);
      clearLoadFailureMessage(message, CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY);
    } catch (error) {
      if (
        selectedSessionRef.current
        && getSessionCacheKey(selectedSessionRef.current) === cacheKey
        && sessionHistorySelectionRevisionRef.current === selectionRevision
        && !isSessionRequestCancelled(error)
      ) {
        showLoadFailureMessage(message, CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY, '加载更早的会话历史失败');
      }
    } finally {
      sessionHistoryLoadMoreRef.current.delete(cacheKey);
    }
  };

const findProjectBySessionId = (items: AggregatedProject[], selection: PersistedChatSelection) => {
  const sessionId = selection.sessionId;
  if (!sessionId) return null;
  for (const project of items) {
    const matched = project.sessions.find((session) => (
      session.id === sessionId
      && (!selection.provider || session.provider === selection.provider)
      && (!selection.projectDirName || session.projectDirName === selection.projectDirName)
    ));
    if (matched) {
      return { project, session: matched };
    }
  }
  return null;
  };

  const fetchProjects = async () => {
    const data = await sessionsAPI.getAllProjects();
    return data.filter((p) =>
      p.name !== '默认项目' && p.path !== '默认项目' && isAbsoluteProjectPath(p.path)
    );
  };

  const normalizeProjects = (items: AggregatedProject[]) => (
    Array.isArray(items)
      ? sortProjectsByLastActivityDesc(items.filter((p) =>
        p.name !== '默认项目' && p.path !== '默认项目' && isAbsoluteProjectPath(p.path)
      ))
      : []
  );

  const clearProjectRefreshFallbackTimer = () => {
    if (projectRefreshFallbackTimerRef.current === null) return;
    window.clearTimeout(projectRefreshFallbackTimerRef.current);
    projectRefreshFallbackTimerRef.current = null;
  };

  const resetProjectSessionHydration = (serverKey: string): void => {
    hydratedProjectsServerKeyRef.current = serverKey;
    hydratedProjectsRef.current.clear();
    staleHydratedProjectPathsRef.current.clear();
    latestProjectSessionHydrationRef.current.clear();
    inflightProjectSessionHydrationRef.current.clear();
    projectSessionHydrationSelectionRef.current.clear();
    setHydratingProjectPaths(new Set());
  };

  const applyProjectSnapshot = (
    items: AggregatedProject[],
    options: PersistedChatSelection = {},
    skipProjectHydration = false
  ) => {
    projectSnapshotGenerationRef.current += 1;
    const currentServerKey = projectHydrationServerKey();
    if (hydratedProjectsServerKeyRef.current !== currentServerKey) {
      resetProjectSessionHydration(currentServerKey);
    }
    const compactProjects = normalizeProjects(items);
    const newlyStaleProjectPaths: string[] = [];
    compactProjects.forEach((project) => {
      const hydratedProject = hydratedProjectsRef.current.get(project.path);
      if (!hydratedProject) return;
      if (isProjectSessionSnapshotComplete(project)) {
        staleHydratedProjectPathsRef.current.delete(project.path);
        return;
      }
      if (
        isHydratedProjectSessionsStale(project, hydratedProject)
        && !staleHydratedProjectPathsRef.current.has(project.path)
      ) {
        staleHydratedProjectPathsRef.current.add(project.path);
        newlyStaleProjectPaths.push(project.path);
      }
    });
    const filtered = preserveHydratedProjectSessions(
      compactProjects,
      hydratedProjectsRef.current
    ) as AggregatedProject[];
    const visibleProjectPaths = new Set(filtered.map((project) => project.path));
    for (const projectPath of hydratedProjectsRef.current.keys()) {
      if (!visibleProjectPaths.has(projectPath)) {
        hydratedProjectsRef.current.delete(projectPath);
        staleHydratedProjectPathsRef.current.delete(projectPath);
      }
    }
    filtered.forEach((project) => {
      if (hydratedProjectsRef.current.has(project.path)) {
        hydratedProjectsRef.current.set(project.path, project);
      }
    });
    writeCachedProjects(filtered);
    projectsRef.current = filtered;
    setProjects(filtered);
    if (!skipProjectHydration) {
      newlyStaleProjectPaths.forEach((projectPath) => {
        hydrateProjectSessionsRef.current(projectPath, { projectPath }, true).catch(() => {});
      });
    }
    const currentSession = selectedSessionRef.current;
    const currentProject = selectedProjectStateRef.current;
    const selection = {
      sessionId: options.sessionId || (!currentSession?.draft ? currentSession?.id : undefined),
      provider: options.provider || currentSession?.provider,
      projectDirName: options.projectDirName || currentSession?.projectDirName,
      projectPath: options.projectPath || currentSession?.projectPath || currentProject?.path
    };

    if (selection.sessionId) {
      const matched = findProjectBySessionId(filtered, selection);
      if (matched) {
        if (!skipProjectHydration && shouldHydrateProjectSessions(matched.project, selection)) {
          hydrateProjectSessionsRef.current(matched.project.path, selection).catch(() => {});
        }
        if (options.sessionId) {
          setExpandedProjects((current) => new Set([...current, matched.project.id]));
        }
        setSelectedProject(matched.project);
        // 引用稳定性：project SSE 快照每次都重建 session 对象。若身份未变就保留旧引用，
        // 否则 selectedSession 每次快照都换新对象，会让依赖它的 effect（会话 watch、
        // slash-commands、消息加载）反复 teardown+重建——表现为 SSE 无限重连/轮询。
        setSelectedSession((prev) => {
          if (prev
            && prev.id === matched.session.id
            && prev.provider === matched.session.provider
            && prev.projectDirName === matched.session.projectDirName
            && !prev.draft) {
            return prev;
          }
          return matched.session;
        });
        return filtered;
      }
    }

    if (selection.projectPath) {
      const project = filtered.find((item) => item.path === selection.projectPath) || null;
      if (project) {
        if (!skipProjectHydration && shouldHydrateProjectSessions(project, selection)) {
          hydrateProjectSessionsRef.current(project.path, selection).catch(() => {});
        }
        if (options.projectPath) {
          setExpandedProjects((current) => new Set([...current, project.id]));
        }
      } else if (currentSession?.draft) {
        // 当前正停在草稿会话上，但本次快照里没有它所在的项目（远端列表迟到/缺失、或
        // 另一来源的过期列表）：保持现有选中不动，绝不把用户和未落盘的草稿踢回空态。
        return filtered;
      }
      setSelectedProject(project);
      // 仅在 projectPath 真正变化时才替换 draft session 对象；否则保持原引用，
      // 避免每次 project 快照都生成等价新对象触发 effect 重跑。
      if (currentSession?.draft && currentSession.projectPath !== selection.projectPath) {
        setSelectedSession({
          ...currentSession,
          projectPath: selection.projectPath
        });
      }
    }

    return filtered;
  };

  const hydrateProjectSessions = async (
    projectPath: string,
    selection: PersistedChatSelection = {},
    force = false
  ): Promise<void> => {
    const normalizedPath = String(projectPath || '').trim();
    if (!normalizedPath) return;
    const currentProject = projectsRef.current.find((project) => project.path === normalizedPath);
    const hydrationIsStale = staleHydratedProjectPathsRef.current.has(normalizedPath);
    if (
      !currentProject
      || (!force && !hydrationIsStale && !shouldHydrateProjectSessions(currentProject, selection))
    ) return;

    const serverKey = projectHydrationServerKey();
    if (hydratedProjectsServerKeyRef.current !== serverKey) {
      resetProjectSessionHydration(serverKey);
      return;
    }
    const requestKey = `${serverKey}\u0000${normalizedPath}`;
    if (selection.sessionId || selection.projectPath) {
      projectSessionHydrationSelectionRef.current.set(requestKey, {
        ...projectSessionHydrationSelectionRef.current.get(requestKey),
        ...selection,
        projectPath: normalizedPath
      });
    }
    const inflight = inflightProjectSessionHydrationRef.current.get(requestKey);
    if (inflight) return inflight;

    const requestId = ++projectSessionHydrationSequenceRef.current;
    const snapshotGeneration = projectSnapshotGenerationRef.current;
    latestProjectSessionHydrationRef.current.set(normalizedPath, requestId);
    setHydratingProjectPaths((current) => new Set([...current, normalizedPath]));

    let retryForNewerSnapshot = false;
    const request = (async () => {
      try {
        const hydratedProject = await sessionsAPI.getProjectSessions(normalizedPath);
        const currentServerKey = projectHydrationServerKey();
        const canApply = canApplyProjectSessionHydration({
          requestId,
          latestRequestId: latestProjectSessionHydrationRef.current.get(normalizedPath),
          serverKey,
          currentServerKey,
          projectPath: normalizedPath,
          responseProjectPath: hydratedProject?.path,
          currentProjectPaths: new Set(projectsRef.current.map((project) => project.path))
        });
        if (!canApply) return;
        if (projectSnapshotGenerationRef.current !== snapshotGeneration) {
          retryForNewerSnapshot = true;
          return;
        }

        const latestProject = projectsRef.current.find((project) => project.path === normalizedPath);
        if (!latestProject) return;
        const mergedProject = applyProjectSessionHydrationResponse(
          latestProject,
          hydratedProject
        ) as AggregatedProject;
        staleHydratedProjectPathsRef.current.delete(normalizedPath);
        hydratedProjectsRef.current.set(normalizedPath, mergedProject);
        const nextProjects = projectsRef.current.map((project) => (
          project.path === normalizedPath ? mergedProject : project
        ));
        const pendingSelection = projectSessionHydrationSelectionRef.current.get(requestKey) || selection;
        projectSessionHydrationSelectionRef.current.delete(requestKey);
        clearLoadFailureMessage(message, CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY);
        applyProjectSnapshot(nextProjects, pendingSelection, true);
      } catch (_error) {
        const currentServerKey = projectHydrationServerKey();
        if (
          latestProjectSessionHydrationRef.current.get(normalizedPath) === requestId
          && currentServerKey === serverKey
        ) {
          showLoadFailureMessage(
            message,
            CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY,
            '加载完整会话列表失败，请再次展开项目重试'
          );
        }
      } finally {
        if (latestProjectSessionHydrationRef.current.get(normalizedPath) === requestId) {
          setHydratingProjectPaths((current) => {
            const next = new Set(current);
            next.delete(normalizedPath);
            return next;
          });
        }
      }
    })();

    inflightProjectSessionHydrationRef.current.set(requestKey, request);
    try {
      await request;
    } finally {
      if (inflightProjectSessionHydrationRef.current.get(requestKey) === request) {
        inflightProjectSessionHydrationRef.current.delete(requestKey);
      }
      if (retryForNewerSnapshot) {
        window.setTimeout(() => {
          const pendingSelection = projectSessionHydrationSelectionRef.current.get(requestKey) || selection;
          hydrateProjectSessionsRef.current(normalizedPath, pendingSelection, true).catch(() => {});
        }, 0);
      }
    }
  };
  hydrateProjectSessionsRef.current = hydrateProjectSessions;

  const applySessionHistory = (history: ChatMessage[]) => {
    const normalizedHistory = dedupeChatMessages(history);
    setAllMessages(normalizedHistory);
    if (normalizedHistory.length > INITIAL_MSG_COUNT) {
      setMessages(normalizedHistory.slice(-INITIAL_MSG_COUNT));
      setHasMoreHistory(true);
    } else {
      setMessages(normalizedHistory);
      setHasMoreHistory(false);
    }
  };

  // 实时同步 reload 属于「纯追加」时(旧消息是新记录的完全相同前缀、只多了尾部),只把尾部 append
  // 进去,保住用户已展开/滚动的窗口——否则 applySessionHistory 会把可见窗口重置成最后 INITIAL_MSG_COUNT
  // 条并整窗重渲染(大会话卡顿 + 丢滚动位置)。任何非纯追加(编辑/重排/收缩)安全回退整窗 apply。
  // 服务端仍是事实源,append 的是同一份数组的尾部,不会与整窗 apply 产生差异。
  const isPureHistoryAppend = (previous: ChatMessage[], next: ChatMessage[]) => {
    if (next.length <= previous.length) return false;
    for (let i = 0; i < previous.length; i += 1) {
      const a = previous[i];
      const b = next[i];
      if (!a || !b
        || a.role !== b.role
        || normalizeMessageText(a.content) !== normalizeMessageText(b.content)
        || String(a.timestamp || '') !== String(b.timestamp || '')) {
        return false;
      }
    }
    return true;
  };

  const applyReloadedSessionHistory = (previous: ChatMessage[], next: ChatMessage[]) => {
    const dedupedPrevious = dedupeChatMessages(previous);
    const normalizedNext = dedupeChatMessages(next);
    if (dedupedPrevious.length > 0 && isPureHistoryAppend(dedupedPrevious, normalizedNext)) {
      const appended = normalizedNext.slice(dedupedPrevious.length);
      if (appended.length === 0) return;
      setAllMessages(normalizedNext);
      setMessages((current) => [...current, ...appended]);
      return;
    }
    applySessionHistory(normalizedNext);
  };

  const getSessionCacheKey = (session: Session) =>
    `${session.provider}:${session.id}:${session.projectDirName || ''}`;

  const findActiveRunKeyForSession = useCallback((session: Session | null) => {
    return findActiveRunKeyForSessionState(session, activeRunsRef.current.values());
  }, []);

  const refreshSelectedSessionLoading = useCallback(() => {
    const currentSession = selectedSessionRef.current;
    setLoading(Boolean(findActiveRunKeyForSession(currentSession)));
  }, [findActiveRunKeyForSession]);

  const syncRunningSessions = useCallback(() => {
    setRunningSessionKeys(collectRunningSessionKeys(activeRunsRef.current.values()));
    refreshSelectedSessionLoading();
  }, [refreshSelectedSessionLoading]);

  function registerActiveRun(run: ActiveSessionRun) {
    activeRunsRef.current.set(run.runKey, run);
    if (run.sessionId) {
      connectActiveRunWatch(run.runKey, {
        id: run.sessionId,
        title: '',
        updatedAt: Date.now(),
        provider: run.provider,
        projectDirName: run.projectDirName,
        projectPath: run.projectPath
      });
    }
    syncRunningSessions();
  }

  function renameActiveRun(previousRunKey: string, nextRunKey: string, patch: Partial<ActiveSessionRun> = {}) {
    const currentRun = activeRunsRef.current.get(previousRunKey);
    if (!currentRun) return previousRunKey;
    activeRunsRef.current.delete(previousRunKey);
    setRunStatusByKey((current) => {
      const next = { ...current };
      const previousStatus = next[previousRunKey];
      delete next[previousRunKey];
      if (previousStatus) {
        next[nextRunKey] = previousStatus;
      }
      return next;
    });
    setInteractivePromptsByRunKey((current) => {
      const prompt = current[previousRunKey];
      if (!prompt) return current;
      const next = { ...current };
      delete next[previousRunKey];
      next[nextRunKey] = prompt;
      return next;
    });
    setTerminalRunsByKey((current) => {
      const terminalRun = current[previousRunKey];
      if (!terminalRun) return current;
      const next = { ...current };
      delete next[previousRunKey];
      next[nextRunKey] = terminalRun;
      return next;
    });
    activeRunsRef.current.set(nextRunKey, {
      ...currentRun,
      ...patch,
      runKey: nextRunKey
    });
    clearActiveRunWatch(previousRunKey);
    const nextRun = activeRunsRef.current.get(nextRunKey);
    if (nextRun?.sessionId) {
      connectActiveRunWatch(nextRunKey, {
        id: nextRun.sessionId,
        title: '',
        updatedAt: Date.now(),
        provider: nextRun.provider,
        projectDirName: nextRun.projectDirName,
        projectPath: nextRun.projectPath
      });
    }
    syncRunningSessions();
    return nextRunKey;
  }

  function updateActiveRun(runKey: string, patch: Partial<ActiveSessionRun>) {
    const currentRun = activeRunsRef.current.get(runKey);
    if (!currentRun) return;
    activeRunsRef.current.set(runKey, {
      ...currentRun,
      ...patch
    });
  }

  function unregisterActiveRun(runKey: string) {
    clearActiveRunWatch(runKey);
    activeRunsRef.current.delete(runKey);
    setRunStatusByKey((current) => {
      if (!(runKey in current)) return current;
      const next = { ...current };
      delete next[runKey];
      return next;
    });
    setInteractivePromptsByRunKey((current) => {
      if (!(runKey in current)) return current;
      const next = { ...current };
      delete next[runKey];
      return next;
    });
    syncRunningSessions();
  }

  const updateRunStatus = useCallback((runKey: string, statusText: string) => {
    setRunStatusByKey((current) => {
      if (current[runKey] === statusText) return current;
      return {
        ...current,
        [runKey]: statusText
      };
    });
  }, []);

  const enqueueSessionMessage = useCallback((sessionKey: string, item: QueuedSessionMessage) => {
    setQueuedMessagesByKey((current) => appendQueuedMessage(current, sessionKey, item));
  }, []);

  const removeQueuedSessionMessage = useCallback((sessionKey: string, messageId: string) => {
    setQueuedMessagesByKey((current) => removeQueuedMessage(current, sessionKey, messageId));
  }, []);

  const shiftQueuedSessionMessage = useCallback((sessionKey: string): QueuedSessionMessage | null => {
    let shifted: QueuedSessionMessage | null = null;
    setQueuedMessagesByKey((current) => {
      const result = shiftQueuedMessage(current, sessionKey);
      shifted = result.shifted;
      return result.nextState;
    });
    return shifted;
  }, []);

  const shiftQueuedSessionMessageByMode = useCallback((sessionKey: string, mode: QueuedSessionMessage['mode']): QueuedSessionMessage | null => {
    let shifted: QueuedSessionMessage | null = null;
    setQueuedMessagesByKey((current) => {
      const result = shiftQueuedMessageByMode(current, sessionKey, mode);
      shifted = result.shifted;
      return result.nextState;
    });
    return shifted;
  }, []);

  const moveQueuedMessages = useCallback((fromKey: string, toKey: string) => {
    if (!fromKey || !toKey || fromKey === toKey) return;
    setQueuedMessagesByKey((current) => moveQueuedMessagesState(current, fromKey, toKey));
  }, []);

  const flushQueuedToolCallMessage = useCallback((session: Session) => {
    const runKey = findActiveRunKeyForSession(session);
    if (!runKey) return;
    const activeRun = activeRunsRef.current.get(runKey);
    if (!activeRun || !activeRun.runId) return;
    const queued = shiftQueuedSessionMessageByMode(runKey, 'after_tool_call');
    if (!queued) return;
    chatAPI.sendRunInput(activeRun.runId, queued.content, true).catch(() => {
      enqueueSessionMessage(runKey, queued);
    });
  }, [enqueueSessionMessage, findActiveRunKeyForSession, shiftQueuedSessionMessageByMode]);

  const clearActiveRunWatch = useCallback((runKey: string) => {
    const watcher = activeRunWatchersRef.current.get(runKey);
    if (!watcher) return;
    if (watcher.reconnectTimer != null) {
      window.clearTimeout(watcher.reconnectTimer);
    }
    watcher.eventSource?.close();
    activeRunWatchersRef.current.delete(runKey);
  }, []);

  const connectActiveRunWatch = useCallback((runKey: string, session: Session) => {
    if (typeof window === 'undefined') return;
    if (!supportsBackgroundRunWatch(session.provider) || !session.id || session.draft) return;
    if (
      selectedSessionRef.current
      && getSessionCacheKey(selectedSessionRef.current) === getSessionCacheKey(session)
    ) {
      return;
    }

    clearActiveRunWatch(runKey);
    const params = new URLSearchParams();
    params.set('sessionId', session.id);
    params.set('provider', session.provider);
    if (session.projectDirName) params.set('projectDirName', session.projectDirName);

    const state = {
      eventSource: guardedWebUiEventSource(`/v0/webui/sessions/watch?${params.toString()}`),
      cursor: 0,
      reconnectTimer: null as number | null
    };
    activeRunWatchersRef.current.set(runKey, state);

    state.eventSource.onmessage = () => {
      sessionsAPI.getSessionEvents(session.provider, session.id, state.cursor, session.projectDirName)
        .then((payload) => {
          state.cursor = payload.cursor;
          if (
            payload.hasAssistantToolCall
            || (payload.events || []).some((event) => event.type === 'assistant_tool_call')
          ) {
            flushQueuedToolCallMessage(session);
          }
        })
        .catch(() => {});
    };

    state.eventSource.onerror = () => {
      state.eventSource?.close();
      if (!activeRunsRef.current.has(runKey)) {
        clearActiveRunWatch(runKey);
        return;
      }
      if (state.reconnectTimer != null) {
        window.clearTimeout(state.reconnectTimer);
      }
      state.reconnectTimer = window.setTimeout(() => {
        connectActiveRunWatch(runKey, session);
      }, 1200);
    };
  }, [clearActiveRunWatch, flushQueuedToolCallMessage]);

  const clearSessionWatch = useCallback(() => {
    if (sessionWatchReconnectTimerRef.current != null) {
      window.clearTimeout(sessionWatchReconnectTimerRef.current);
      sessionWatchReconnectTimerRef.current = null;
    }
    if (sessionWatchRef.current) {
      sessionWatchRef.current.close();
      sessionWatchRef.current = null;
    }
  }, []);

  const clearProjectRuntimeWatch = useCallback(() => {
    if (projectRuntimeReconnectTimerRef.current != null) {
      window.clearTimeout(projectRuntimeReconnectTimerRef.current);
      projectRuntimeReconnectTimerRef.current = null;
    }
    clearProjectRefreshFallbackTimer();
    if (projectRuntimeWatchRef.current) {
      projectRuntimeWatchRef.current.close();
      projectRuntimeWatchRef.current = null;
    }
  }, []);

  const clearWatchPending = useCallback(() => {
    watchPendingStartedAtRef.current = 0;
    setWatchPendingStatus(null);
  }, []);

  const markWatchPending = useCallback((session: Session, statusText = getThinkingStatusText(session.provider)) => {
    const currentSession = selectedSessionRef.current;
    if (!currentSession || getSessionCacheKey(currentSession) !== getSessionCacheKey(session)) return;
    if (!watchPendingStartedAtRef.current) {
      watchPendingStartedAtRef.current = Date.now();
    }
    setWatchPendingStatus(statusText);
  }, []);

  const scheduleSessionReload = useCallback((session: Session, delayMs = 180) => {
    const cacheKey = `${session.provider}:${session.id}:${session.projectDirName || ''}`;
    const reasoningSnapshotKey = `${cacheKey}:reasoning-snapshot`;
    const existingTimer = sessionReloadTimersRef.current.get(cacheKey);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }
    const nextTimer = window.setTimeout(() => {
      sessionReloadTimersRef.current.delete(cacheKey);
      const currentCursor = sessionCursorCacheRef.current.get(cacheKey) || 0;
      sessionsAPI.getSessionEvents(
        session.provider,
        session.id,
        currentCursor,
        session.projectDirName
      ).then((payload) => {
        const cursorReset = didSessionHistoryCursorReset(currentCursor, payload.cursor);
        if (cursorReset) {
          sessionHistoryWindowCacheRef.current.delete(cacheKey);
          sessionMessagesCacheRef.current.delete(cacheKey);
        }
        sessionCursorCacheRef.current.set(cacheKey, payload.cursor);
        if (payload.events && payload.events.length > 0) {
          applySessionEventsRef.current(session, payload.events, payload.cursor);
        }
        if (payload.requiresSnapshot) {
          const hasReasoningEvent = payload.events?.some((event) => event.type === 'assistant_reasoning');
          if (hasReasoningEvent) {
            const pendingReasoningSnapshot = sessionReloadTimersRef.current.get(reasoningSnapshotKey);
            if (pendingReasoningSnapshot != null) {
              window.clearTimeout(pendingReasoningSnapshot);
            }
            const reasoningSnapshotTimer = window.setTimeout(() => {
              sessionReloadTimersRef.current.delete(reasoningSnapshotKey);
              const currentSession = selectedSessionRef.current;
              if (!currentSession || getSessionCacheKey(currentSession) !== cacheKey) return;
              reloadSessionHistoryRef.current(session).catch(() => {});
            }, 420);
            sessionReloadTimersRef.current.set(reasoningSnapshotKey, reasoningSnapshotTimer);
            return;
          }
          return reloadSessionHistoryRef.current(session);
        }
      }).catch((error) => {
        if (isSessionRequestCancelled(error)) return;
        reloadSessionHistoryRef.current(session).catch(() => {});
      });
    }, delayMs);
    sessionReloadTimersRef.current.set(cacheKey, nextTimer);
  }, []);

  const reloadSessionHistory = useCallback(async (session: Session) => {
    if (session.draft) return;
    const cacheKey = getSessionCacheKey(session);
    const snapshotRetryKey = `${cacheKey}:snapshot-retry`;
    const reasoningSnapshotKey = `${cacheKey}:reasoning-snapshot`;
    const previousWindow = sessionHistoryWindowCacheRef.current.get(cacheKey);
    let loadedWindow: SessionMessageBundle | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      loadedWindow = await loadContiguousSessionHistoryTail(
        previousWindow,
        (options: { before?: number }) => sessionsAPI.getSessionMessagesBundle(
          session.provider,
          session.id,
          session.projectDirName,
          options
        )
      ) as SessionMessageBundle;
      const observedCursor = sessionCursorCacheRef.current.get(cacheKey) || 0;
      if (didSessionHistorySnapshotReset(previousWindow, loadedWindow, observedCursor)) {
        sessionHistoryWindowCacheRef.current.delete(cacheKey);
        sessionMessagesCacheRef.current.delete(cacheKey);
        sessionCursorCacheRef.current.set(cacheKey, loadedWindow.cursor);
        break;
      }
      if (isSessionHistorySnapshotCurrent(observedCursor, loadedWindow)) break;
      loadedWindow = null;
    }
    if (!loadedWindow) {
      const currentSession = selectedSessionRef.current;
      if (!currentSession || getSessionCacheKey(currentSession) !== cacheKey) return;
      if (!sessionReloadTimersRef.current.has(snapshotRetryKey)) {
        const retryTimer = window.setTimeout(() => {
          sessionReloadTimersRef.current.delete(snapshotRetryKey);
          const currentSession = selectedSessionRef.current;
          if (!currentSession || getSessionCacheKey(currentSession) !== cacheKey) return;
          reloadSessionHistoryRef.current(session).catch(() => {});
        }, 180);
        sessionReloadTimersRef.current.set(snapshotRetryKey, retryTimer);
      }
      return;
    }
    const pendingSnapshotRetry = sessionReloadTimersRef.current.get(snapshotRetryKey);
    if (pendingSnapshotRetry != null) {
      window.clearTimeout(pendingSnapshotRetry);
      sessionReloadTimersRef.current.delete(snapshotRetryKey);
    }
    const pendingReasoningSnapshot = sessionReloadTimersRef.current.get(reasoningSnapshotKey);
    if (pendingReasoningSnapshot != null) {
      window.clearTimeout(pendingReasoningSnapshot);
      sessionReloadTimersRef.current.delete(reasoningSnapshotKey);
    }
    const latestWindow = sessionHistoryWindowCacheRef.current.get(cacheKey);
    const nextWindow = rebaseLatestSessionHistoryTail(
      latestWindow,
      loadedWindow
    ) as SessionMessageBundle;
    const previousHistory = sessionMessagesCacheRef.current.get(cacheKey) || [];
    const history = nextWindow.messages;
    sessionHistoryWindowCacheRef.current.set(cacheKey, nextWindow);
    sessionMessagesCacheRef.current.set(cacheKey, history);
    sessionCursorCacheRef.current.set(cacheKey, nextWindow.cursor);
    if (selectedSessionRef.current && getSessionCacheKey(selectedSessionRef.current) === cacheKey) {
      const latest = Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
      const previousLatest = previousHistory.length > 0 ? previousHistory[previousHistory.length - 1] : null;
      const hasNewAssistantReply = Boolean(
        latest
        && latest.role === 'assistant'
        && (
          history.length > previousHistory.length
          || String(latest.content || '') !== String(previousLatest && previousLatest.content || '')
          || String(latest.timestamp || '') !== String(previousLatest && previousLatest.timestamp || '')
        )
      );
      if (hasNewAssistantReply) {
        clearWatchPending();
      }
      applyReloadedSessionHistory(previousHistory, history);
      if (nextWindow.hasMore) setHasMoreHistory(true);
      clearLoadFailureMessage(message, CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY);
    }
  }, [clearWatchPending]);

  const applySessionEvents = useCallback((
    session: Session,
    events: SessionEventItem[],
    cursor = 0
  ) => {
    if (!Array.isArray(events) || events.length === 0) return;
    const cacheKey = getSessionCacheKey(session);
    const isCurrentSession = Boolean(
      selectedSessionRef.current
      && getSessionCacheKey(selectedSessionRef.current) === cacheKey
    );
    const baseMessages = sessionMessagesCacheRef.current.get(cacheKey) || [];
    const nextMessages = [...baseMessages];

    events.forEach((event) => {
      if (event.type === 'user_message') {
        const content = String(event.content || '').trim();
        const images = Array.isArray(event.images) ? event.images : [];
        const key = `${event.timestamp || ''}::${content}`;
        const exists = nextMessages.some((item) =>
          item.role === 'user'
          && `${item.timestamp || ''}::${String(item.content || '').trim()}` === key
        );
        if (!exists) {
          nextMessages.push({
            role: 'user',
            content,
            images,
            timestamp: event.timestamp
          });
        }
        return;
      }

      if (event.type === 'assistant_text') {
        if (isCurrentSession) clearWatchPending();
        nextMessages.splice(
          0,
          nextMessages.length,
          ...applySessionAssistantEvent(nextMessages, event, {
            pending: false,
            provider: session.provider,
            thinkingStatusText: getThinkingStatusText(session.provider),
            processingStatusText: getProcessingStatusText()
          })
        );
        return;
      }

      if (event.type === 'assistant_reasoning') {
        markWatchPending(session, getThinkingStatusText(session.provider));
        nextMessages.splice(
          0,
          nextMessages.length,
          ...applySessionAssistantEvent(nextMessages, event, {
            pending: false,
            provider: session.provider,
            thinkingStatusText: getThinkingStatusText(session.provider),
            processingStatusText: getProcessingStatusText()
          })
        );
        return;
      }

      if (event.type === 'assistant_tool_call' || event.type === 'assistant_tool_result') {
        if (event.type === 'assistant_tool_call' && supportsToolBoundaryQueue(session.provider, false)) {
          flushQueuedToolCallMessage(session);
        }
        const isSessionStillRunning = Boolean(findActiveRunKeyForSession(session));
        if (isCurrentSession) clearWatchPending();
        nextMessages.splice(
          0,
          nextMessages.length,
          ...applySessionAssistantEvent(nextMessages, event, {
            pending: isSessionStillRunning,
            provider: session.provider,
            thinkingStatusText: getThinkingStatusText(session.provider),
            processingStatusText: getProcessingStatusText()
          })
        );
        return;
      }
    });

    const normalizedMessages = dedupeChatMessages(nextMessages);
    sessionMessagesCacheRef.current.set(cacheKey, normalizedMessages);
    const nextWindow = advanceSessionHistoryWindow(
      sessionHistoryWindowCacheRef.current.get(cacheKey),
      normalizedMessages,
      cursor
    ) as SessionMessageBundle | null;
    if (nextWindow) sessionHistoryWindowCacheRef.current.set(cacheKey, nextWindow);
    if (isCurrentSession) {
      applySessionHistory(normalizedMessages);
    }
  }, [applySessionHistory, clearWatchPending, findActiveRunKeyForSession, flushQueuedToolCallMessage, markWatchPending]);

  useEffect(() => {
    reloadSessionHistoryRef.current = reloadSessionHistory;
  }, [reloadSessionHistory]);

  useEffect(() => {
    applySessionEventsRef.current = applySessionEvents;
  }, [applySessionEvents]);

  useEffect(() => {
    clearWatchPending();
  }, [
    clearWatchPending,
    selectedSession?.draft,
    selectedSession?.id,
    selectedSession?.projectDirName,
    selectedSession?.provider
  ]);

  const connectSessionWatch = useCallback((session: Session) => {
    if (!session || session.draft || !session.id) return;
    if (typeof window === 'undefined') return;

    clearSessionWatch();

    const params = new URLSearchParams();
    params.set('sessionId', session.id);
    params.set('provider', session.provider);
    if (session.projectDirName) {
      params.set('projectDirName', session.projectDirName);
    }

    const eventSource = guardedWebUiEventSource(`/v0/webui/sessions/watch?${params.toString()}`);
    sessionWatchRef.current = eventSource;

    eventSource.onmessage = (evt) => {
      // 审批事件(P3)必须在「本地活跃 run 早退」之前处理:live 页的权限确认也走 watch 通道。
      try {
        const early = JSON.parse(evt.data);
        const earlyKey = getSessionRunKey(session);
        if (early.eventType === 'session:approval-request' && early.prompt && earlyKey) {
          if (early.runId) detachedRunRef.current = { sessionKey: earlyKey, runId: String(early.runId) };
          setInteractivePromptsByRunKey((current) => ({ ...current, [earlyKey]: early.prompt }));
          return;
        }
        if (early.eventType === 'session:approval-resolved' && earlyKey) {
          setInteractivePromptsByRunKey((current) => {
            if (!current[earlyKey] || current[earlyKey].promptId !== early.promptId) return current;
            const next = { ...current };
            delete next[earlyKey];
            return next;
          });
          return;
        }
      } catch {}
      if (findActiveRunKeyForSession(session)) {
        return;
      }
      try {
        const data = JSON.parse(evt.data);
        const stableKey = getSessionRunKey(session);
        // detached run 的 runId 透传在会话事件里：记下来供停止/回答交互 prompt 用。
        if (data.runId && stableKey) {
          detachedRunRef.current = { sessionKey: stableKey, runId: String(data.runId) };
        }
        // 交互 prompt 的出现/收起（detached 场景由 watch 通道送达）：存到会话稳定键下,
        // selectedSessionInteractivePrompt 回退到该键即可弹出 PlanChoiceDock。
        if (data.eventType === 'session:interactive-prompt' && data.prompt && stableKey) {
          setInteractivePromptsByRunKey((current) => ({ ...current, [stableKey]: data.prompt }));
          markWatchPending(session, '等待你的选择…');
          return;
        }
        if (data.eventType === 'session:interactive-prompt-cleared' && stableKey) {
          setInteractivePromptsByRunKey((current) => {
            if (!current[stableKey]) return current;
            const next = { ...current };
            delete next[stableKey];
            return next;
          });
          return;
        }
        const action = resolveSessionWatchUpdateAction(data);
        if (action.clearPending) {
          clearWatchPending();
          if (detachedRunRef.current?.sessionKey === stableKey) detachedRunRef.current = null;
          if (stableKey) {
            setInteractivePromptsByRunKey((current) => {
              if (!current[stableKey]) return current;
              const next = { ...current };
              delete next[stableKey];
              return next;
            });
            // detached run 结束:把队列里下一条发出去(本地无 activeRun,原本没人 flush)。
            // 与 activeRun 收尾路径(下方 shiftQueuedSessionMessage + runSessionMessage)同构。
            const nextQueued = shiftQueuedSessionMessage(stableKey);
            if (nextQueued && session && !session.draft) {
              const queuedToRun = nextQueued;
              const targetSession = session;
              window.setTimeout(() => {
                const backgroundAccount = resolveQueuedAccount(queuedToRun, accountsRef.current);
                if (!backgroundAccount) return;
                runSessionMessageRef.current?.({
                  session: targetSession,
                  account: backgroundAccount,
                  model: queuedToRun.model,
                  content: queuedToRun.content,
                  imageList: Array.isArray(queuedToRun.images) ? queuedToRun.images : []
                })?.catch(() => {});
              }, 0);
            }
          }
        }
        if (action.markPending) {
          markWatchPending(
            session,
            supportsSessionWatchPending(session.provider)
              ? getThinkingStatusText(session.provider)
              : getGeneratingStatusText()
          );
        }
        if (action.reload) {
          scheduleSessionReload(session);
        }
      } catch {}
    };

    eventSource.onerror = () => {
      eventSource.close();
      if (sessionWatchRef.current === eventSource) {
        sessionWatchRef.current = null;
      }
      if (sessionWatchReconnectTimerRef.current != null) {
        window.clearTimeout(sessionWatchReconnectTimerRef.current);
      }
      const currentSession = selectedSessionRef.current;
      const canReconnect = document.visibilityState === 'visible'
        && navigator.onLine
        && currentSession
        && !currentSession.draft
        && getSessionCacheKey(currentSession) === getSessionCacheKey(session);
      if (!canReconnect) return;
      sessionWatchReconnectTimerRef.current = window.setTimeout(() => {
        sessionWatchReconnectTimerRef.current = null;
        const latestSession = selectedSessionRef.current;
        if (
          !latestSession
          || latestSession.draft
          || getSessionCacheKey(latestSession) !== getSessionCacheKey(session)
        ) return;
        connectSessionWatch(latestSession);
      }, 1200);
    };
  }, [clearSessionWatch, clearWatchPending, findActiveRunKeyForSession, markWatchPending, scheduleSessionReload, shiftQueuedSessionMessage]);

  const connectProjectRuntimeWatch = useCallback(() => {
    if (typeof window === 'undefined') return;

    clearProjectRuntimeWatch();
    const eventSource = sessionsAPI.watchProjects({
      onSnapshot: ({ revision, projects: nextProjects }) => {
        projectSnapshotReceivedAtRef.current = Date.now();
        projectSnapshotRevisionRef.current = revision;
        clearLoadFailureMessage(message, CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY);
        setLoadingProjects(false);
        clearProjectRefreshFallbackTimer();
        const pendingSelection = pendingProjectSelectionRef.current;
        pendingProjectSelectionRef.current = {};
        applyProjectSnapshot(nextProjects, pendingSelection);
      },
      onRuntime: (nextRunningSessionKeys) => {
        setPassiveRunningSessionKeys(nextRunningSessionKeys);
      },
      onConnected: () => {
        if (projectSnapshotReceivedAtRef.current === 0) {
          setLoadingProjects(true);
        }
      },
      onError: () => {
        eventSource.close();
        if (projectRuntimeWatchRef.current === eventSource) {
          projectRuntimeWatchRef.current = null;
        }
        if (projectRuntimeReconnectTimerRef.current != null) {
          window.clearTimeout(projectRuntimeReconnectTimerRef.current);
        }
        projectRuntimeReconnectTimerRef.current = window.setTimeout(() => {
          projectRuntimeReconnectTimerRef.current = null;
          if (document.visibilityState === 'hidden') return;
          connectProjectRuntimeWatch();
        }, 1500);
        if (projectSnapshotReceivedAtRef.current === 0) {
          loadProjects(pendingProjectSelectionRef.current).catch(() => {});
        }
      }
    });
    projectRuntimeWatchRef.current = eventSource;
  }, [clearProjectRuntimeWatch]);

  const handleResumeSync = useCallback(async (_syncReason: 'visible' | 'online' | 'pageshow') => {
    const session = selectedSessionRef.current;
    connectProjectRuntimeWatch();
    if (!session) return;

    if (session.draft) return;

    connectSessionWatch(session);

    try {
      await reloadSessionHistory(session);
      await loadProjects({});
    } catch {}
  }, [connectProjectRuntimeWatch, connectSessionWatch, reloadSessionHistory]);

  const applyChatAccounts = useCallback((incomingAccounts: Account[]) => {
    const usableAccounts = incomingAccounts.filter(isChatSelectableAccount);
    accountsRef.current = usableAccounts;
    setAccounts(usableAccounts);
    setSelectedAccount((current) => pickChatAccount(
      current,
      usableAccounts,
      selectedSessionRef.current?.provider
    ));
  }, []);

  const loadAccounts = useCallback(async () => {
    // 缓存优先：先用本地缓存即时渲染(按当前 server 键)，消除"请先配置可用账号"闪烁 + 空窗，再异步刷新。
    const cached = readCachedChatAccounts();
    const requestId = ++accountsHttpRequestRef.current;
    const snapshotReceivedAt = accountsSnapshotReceivedAtRef.current;
    if (cached.length) applyChatAccounts(cached);
    try {
      const { accounts: data } = await accountsAPI.list();
      if (
        requestId !== accountsHttpRequestRef.current
        || snapshotReceivedAt !== accountsSnapshotReceivedAtRef.current
      ) return;
      clearLoadFailureMessage(message, CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY);
      applyChatAccounts(data);
      writeCachedChatAccounts(data);
      setAccountsLoadFailed(false);
    } catch (error: any) {
      if (
        requestId !== accountsHttpRequestRef.current
        || snapshotReceivedAt !== accountsSnapshotReceivedAtRef.current
      ) return;
      // 区分"没配账号"与"远端没连上"：代理到远端 server 失败(server_proxy_upstream_failed / 网络)
      // 不是缺账号，别误导用户去配置。有缓存则不进失败态、静默保留缓存。
      setAccountsLoadFailed(cached.length === 0);
      if (cached.length === 0) {
        const raw = String(error?.message || error || '');
        const isUpstream = raw.includes('server_proxy_upstream_failed') || raw.includes('fetch failed') || raw.includes('Network');
        showLoadFailureMessage(
          message,
          CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY,
          isUpstream ? '远端 server 连接异常，账号未加载，请稍后点刷新重试' : '加载账号失败'
        );
      }
    }
  }, [applyChatAccounts]);

  const loadProjects = async (options: PersistedChatSelection = {}) => {
    pendingProjectSelectionRef.current = options;
    clearProjectRefreshFallbackTimer();
    if (projectRuntimeWatchRef.current && projectSnapshotReceivedAtRef.current > 0) {
      const previousSnapshotAt = projectSnapshotReceivedAtRef.current;
      setLoadingProjects(true);
      try {
        await sessionsAPI.requestProjectsSnapshot();
        projectRefreshFallbackTimerRef.current = window.setTimeout(() => {
          if (projectSnapshotReceivedAtRef.current > previousSnapshotAt) return;
          loadProjectsFromHttp(options).catch(() => {});
        }, 2000);
        return;
      } catch {
        // Fall through to the HTTP fallback below.
      }
    }
    await loadProjectsFromHttp(options);
  };

  const loadProjectsFromHttp = async (options: PersistedChatSelection = {}) => {
    const requestId = ++projectHttpRequestRef.current;
    const snapshotReceivedAt = projectSnapshotReceivedAtRef.current;
    setLoadingProjects(true);
    try {
      const filtered = await fetchProjects();
      if (
        requestId !== projectHttpRequestRef.current
        || snapshotReceivedAt !== projectSnapshotReceivedAtRef.current
      ) return;
      projectSnapshotReceivedAtRef.current = Date.now();
      clearLoadFailureMessage(message, CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY);
      applyProjectSnapshot(filtered, options);
    } catch {
      if (
        requestId === projectHttpRequestRef.current
        && snapshotReceivedAt === projectSnapshotReceivedAtRef.current
      ) {
        showLoadFailureMessage(message, CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY, '加载项目失败');
      }
    } finally {
      if (requestId === projectHttpRequestRef.current) {
        setLoadingProjects(false);
        clearProjectRefreshFallbackTimer();
      }
    }
  };


  useEffect(() => {
    const initialSelection = initialSelectionRef.current;
    pendingProjectSelectionRef.current = initialSelection;
    const cachedProjects = readCachedProjects();
    if (cachedProjects.length > 0) {
      applyProjectSnapshot(cachedProjects, initialSelection);
      setLoadingProjects(false);
    } else {
      setLoadingProjects(true);
    }
    connectProjectRuntimeWatch();
    projectRefreshFallbackTimerRef.current = window.setTimeout(() => {
      if (projectSnapshotReceivedAtRef.current > 0) return;
      loadProjectsFromHttp(initialSelection).catch(() => {});
    }, cachedProjects.length > 0 ? 800 : 2500);
    return () => {
      projectHttpRequestRef.current += 1;
      clearProjectRefreshFallbackTimer();
    };
  }, [connectProjectRuntimeWatch]);

  useEffect(() => {
    const fallbackTimer = window.setTimeout(() => {
      if (accountsSnapshotReceivedAtRef.current > 0) return;
      loadAccounts().catch(() => {});
    }, 2500);
    const watcher = accountsAPI.watch({
      onSnapshot: ({ accounts: snapshotAccounts }) => {
        accountsSnapshotReceivedAtRef.current = Date.now();
        clearLoadFailureMessage(message, CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY);
        applyChatAccounts(snapshotAccounts);
      },
      onAccount: (account) => {
        const withoutAccount = accountsRef.current.filter((item) => item.accountRef !== account.accountRef);
        applyChatAccounts(isChatSelectableAccount(account) ? [...withoutAccount, account] : withoutAccount);
      },
      onAccountRemoved: (event) => {
        applyChatAccounts(accountsRef.current.filter((account) => account.accountRef !== event.accountRef));
      },
      onError: () => {
        if (accountsSnapshotReceivedAtRef.current > 0) return;
        loadAccounts().catch(() => {});
      }
    });
    return () => {
      accountsHttpRequestRef.current += 1;
      window.clearTimeout(fallbackTimer);
      watcher.close();
    };
  }, [applyChatAccounts, loadAccounts]);

  useEffect(() => {
    if (!isMobile) return;
    if (selectedProject || selectedSession) return;
    // 无项目/会话时回到列表页（iOS 导航栈根视图）
    setMobileShowChat(false);
  }, [isMobile, projects.length, selectedProject, selectedSession]);

  // 进入对话视图（push 视图）时开启沉浸态：隐藏底部 TabBar，把整屏让给消息流 + 输入框。
  // 通过 body 上的 data 属性驱动 mobile-shell.css，无需与 MobileTabBar 组件耦合。
  useEffect(() => {
    const immersive = isMobile && mobileShowChat;
    if (immersive) {
      document.body.dataset.mobileImmersive = '1';
    } else {
      delete document.body.dataset.mobileImmersive;
    }
    return () => {
      delete document.body.dataset.mobileImmersive;
    };
  }, [isMobile, mobileShowChat]);

  useLayoutEffect(() => {
    selectedSessionRef.current = selectedSession;
    sessionHistorySelectionRevisionRef.current += 1;
  }, [
    selectedSession?.provider,
    selectedSession?.id,
    selectedSession?.projectDirName,
    selectedSession?.draft
  ]);

  useEffect(() => {
    selectedProjectStateRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    activeRunsRef.current.forEach((run, runKey) => {
      if (!run.sessionId) return;
      const session: Session = {
        id: run.sessionId,
        title: '',
        updatedAt: Date.now(),
        provider: run.provider,
        projectDirName: run.projectDirName,
        projectPath: run.projectPath
      };
      if (selectedSession && getSessionCacheKey(selectedSession) === getSessionCacheKey(session)) {
        clearActiveRunWatch(runKey);
        return;
      }
      connectActiveRunWatch(runKey, session);
    });
  }, [clearActiveRunWatch, connectActiveRunWatch, selectedSession]);

  useEffect(() => {
    writePersistedSelection({
      projectPath: selectedProject?.path,
      sessionId: selectedSession?.draft ? undefined : selectedSession?.id,
      provider: selectedSession?.draft ? undefined : selectedSession?.provider,
      projectDirName: selectedSession?.draft ? undefined : selectedSession?.projectDirName
    });
  }, [
    selectedProject?.path,
    selectedSession?.draft,
    selectedSession?.id,
    selectedSession?.projectDirName,
    selectedSession?.provider
  ]);

  // 会话模型的持久化/恢复统一交给 MessageArea（唯一解析处）+ 用户显式切换时写入会话记忆，
  // 这里不再用「监听 selectedModel」的副作用回写（会在切会话瞬间把上一个会话的模型写到新会话键上）。

  const selectedSessionRunKey = selectedSession ? findActiveRunKeyForSession(selectedSession) : '';
  // detached run（本地无 activeRun）的交互 prompt 存在会话稳定键下,取不到 live 键时回退它。
  const selectedSessionStableKey = selectedSession && !selectedSession.draft ? getSessionRunKey(selectedSession) : '';
  const selectedSessionInteractivePrompt = (selectedSessionRunKey
    ? interactivePromptsByRunKey[selectedSessionRunKey]
    : null) || (selectedSessionStableKey ? interactivePromptsByRunKey[selectedSessionStableKey] : null) || null;
  const selectedSessionRunStatusText = selectedSessionRunKey
    ? runStatusByKey[selectedSessionRunKey] || undefined
    : undefined;
  const selectedSessionQueueKey = resolveSelectedSessionQueueKey(selectedSession, selectedSessionRunKey);
  const selectedQueuedMessages = selectedSessionQueueKey ? (queuedMessagesByKey[selectedSessionQueueKey] || []) : [];
  // 终端面板按「稳定会话键」取，使其在运行结束（activeRun 注销）后仍能继续显示。
  const selectedSessionTerminalRun = selectedSession
    ? terminalRunsByKey[getSessionRunKey(selectedSession)] || null
    : null;

  const handleSelectPlanChoice = useCallback(async (choice: string, prompt: InteractivePrompt) => {
    const normalizedChoice = String(choice || '').trim();
    if (!/^[1-9]\d*$/.test(normalizedChoice)) return;
    const session = selectedSessionRef.current;
    const currentRunKey = findActiveRunKeyForSession(session);
    const stableKey = session && !session.draft ? getSessionRunKey(session) : '';
    // 审批卡(P3):走审批决策端点(1=允许,其余=拒绝),不进 PTY 输入通道。
    if ((prompt as any)?.kind === 'approval' && (prompt as any)?.approvalId) {
      const approval = prompt as any;
      const activeApprovalRun = currentRunKey ? activeRunsRef.current.get(currentRunKey) : null;
      const approvalRunId = String(approval.runId || activeApprovalRun?.runId
        || (detachedRunRef.current?.sessionKey === stableKey ? detachedRunRef.current?.runId : '') || '');
      const promptKeyForApproval = (currentRunKey && interactivePromptsByRunKey[currentRunKey]) ? currentRunKey : stableKey;
      if (promptKeyForApproval) {
        setInteractivePromptsByRunKey((current) => {
          if (current[promptKeyForApproval]?.promptId !== approval.promptId) return current;
          const next = { ...current };
          delete next[promptKeyForApproval];
          return next;
        });
      }
      try {
        await chatAPI.decideApproval(approvalRunId, approval.approvalId, normalizedChoice === '1' ? 'allow' : 'deny');
        message.success(normalizedChoice === '1' ? '已允许,继续执行' : '已拒绝该操作');
      } catch (err: any) {
        message.error(humanizeChatError(err, '审批提交失败'));
      }
      return;
    }
    // live run 优先；detached run（刷新后经 watch/活跃 run 查询恢复的 prompt）回退到稳定键 + 记录的 runId。
    const promptKey = (currentRunKey && interactivePromptsByRunKey[currentRunKey]) ? currentRunKey : stableKey;
    const activeRun = currentRunKey ? activeRunsRef.current.get(currentRunKey) : null;
    const detached = detachedRunRef.current;
    const runId = activeRun?.runId
      || (detached && stableKey && detached.sessionKey === stableKey ? detached.runId : '');
    const activePrompt = promptKey ? interactivePromptsByRunKey[promptKey] : null;
    if (!promptKey || !runId || !activePrompt || activePrompt.promptId !== prompt.promptId) {
      message.warning('当前计划选择已过期');
      return;
    }

    try {
      setInteractivePromptsByRunKey((current) => {
        if (current[promptKey]?.promptId !== prompt.promptId) return current;
        const next = { ...current };
        delete next[promptKey];
        return next;
      });
      await chatAPI.sendRunInput(runId, normalizedChoice, true, prompt.promptId);
      if (currentRunKey) updateRunStatus(currentRunKey, '已提交计划选择');
    } catch (error: any) {
      setInteractivePromptsByRunKey((current) => {
        if (current[promptKey]) return current;
        return {
          ...current,
          [promptKey]: prompt
        };
      });
      message.error(error?.response?.data?.message || error?.message || '发送计划选择失败');
    }
  }, [findActiveRunKeyForSession, interactivePromptsByRunKey, updateRunStatus]);

  // TerminalDock 挂载时注册 write 通道；注册瞬间回放挂载前缓冲的 terminal-output。
  const registerTerminalWriter = useCallback((runId: string, writer: ((data: string) => void) | null) => {
    if (!runId) return;
    if (writer) {
      terminalWritersRef.current.set(runId, writer);
      const buffered = terminalOutputBufferRef.current.get(runId);
      if (buffered && buffered.length > 0) {
        buffered.forEach((chunk) => writer(chunk));
        terminalOutputBufferRef.current.delete(runId);
      }
    } else {
      terminalWritersRef.current.delete(runId);
    }
  }, []);

  const handleTerminalInput = useCallback((runId: string, data: string) => {
    if (!runId || !data) return;
    // 逐键透传真实键序列（含回车 \r），不补换行。
    chatAPI.sendRunInput(runId, data, false).catch(() => {});
  }, []);

  const handleTerminalResize = useCallback((runId: string, cols: number, rows: number) => {
    if (!runId) return;
    chatAPI.resizeRunTerminal(runId, cols, rows).catch(() => {});
  }, []);

  const handleCloseTerminal = useCallback((runId: string) => {
    if (!runId) return;
    // 关闭终端 = 结束这条常驻会话:abort 真正 kill 掉 CLI 进程并让 SSE 收尾(finally 注销 activeRun /
    // 清停止钮)。否则进程与运行态会残留(之前"关掉还卡住"的原因)。
    chatAPI.abortRun(runId).catch(() => {});
    terminalWritersRef.current.delete(runId);
    terminalOutputBufferRef.current.delete(runId);
    setTerminalRunsByKey((current) => {
      let changed = false;
      const next: Record<string, TerminalRunState> = {};
      for (const [key, value] of Object.entries(current)) {
        if (value.runId === runId) {
          changed = true;
          continue;
        }
        next[key] = value;
      }
      return changed ? next : current;
    });
  }, []);

  const handleEditQueuedMessage = useCallback((messageId: string) => {
    if (!selectedSessionQueueKey) return;
    const queued = (queuedMessagesByKey[selectedSessionQueueKey] || []).find((item) => item.id === messageId);
    if (!queued) return;
    setInput(queued.content);
    setImages(Array.isArray(queued.images) ? queued.images : []);
    removeQueuedSessionMessage(selectedSessionQueueKey, messageId);
  }, [queuedMessagesByKey, removeQueuedSessionMessage, selectedSessionQueueKey]);

  const handleRemoveQueuedMessage = useCallback((messageId: string) => {
    if (!selectedSessionQueueKey) return;
    removeQueuedSessionMessage(selectedSessionQueueKey, messageId);
  }, [removeQueuedSessionMessage, selectedSessionQueueKey]);

  const prioritizeQueuedSessionMessage = useCallback((sessionKey: string, messageId: string): QueuedSessionMessage | null => {
    let moved: QueuedSessionMessage | null = null;
    setQueuedMessagesByKey((current) => {
      const result = moveQueuedMessageToFront(current, sessionKey, messageId);
      moved = result.moved;
      return result.nextState;
    });
    return moved;
  }, []);

  useEffect(() => {
    return () => {
      clearSessionWatch();
      clearProjectRuntimeWatch();
      activeRunWatchersRef.current.forEach((watcher) => {
        if (watcher.reconnectTimer != null) {
          window.clearTimeout(watcher.reconnectTimer);
        }
        watcher.eventSource?.close();
      });
      activeRunWatchersRef.current.clear();
      activeRunsRef.current.forEach((run) => {
        run.controller.abort();
      });
      activeRunsRef.current.clear();
      sessionReloadTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      sessionReloadTimersRef.current.clear();
      if (resumeSyncTimerRef.current != null) {
        window.clearTimeout(resumeSyncTimerRef.current);
        resumeSyncTimerRef.current = null;
      }
    };
  }, [clearProjectRuntimeWatch, clearSessionWatch]);

  useEffect(() => {
    const scheduleResumeSync = (reason: 'visible' | 'online' | 'pageshow') => {
      if (resumeSyncTimerRef.current != null) {
        window.clearTimeout(resumeSyncTimerRef.current);
      }
      resumeSyncTimerRef.current = window.setTimeout(() => {
        resumeSyncTimerRef.current = null;
        handleResumeSync(reason).catch(() => {});
      }, reason === 'online' ? 600 : 350);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        clearSessionWatch();
        clearProjectRuntimeWatch();
        return;
      }
      scheduleResumeSync('visible');
    };

    const handleOnline = () => scheduleResumeSync('online');
    const handlePageShow = () => scheduleResumeSync('pageshow');

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [clearProjectRuntimeWatch, clearSessionWatch, handleResumeSync]);

  const selectedSessionEffectKey = selectedSession
    ? `${getSessionCacheKey(selectedSession)}:${selectedSession.draft ? 'draft' : 'saved'}`
    : '';

  useEffect(() => {
    const session = selectedSessionRef.current;
    if (!session || `${getSessionCacheKey(session)}:${session.draft ? 'draft' : 'saved'}` !== selectedSessionEffectKey) {
      return;
    }
    if (session.draft) {
      // 草稿会话可能已经有对话内容（api-proxy 路径不落盘、消息只活在运行缓存里）。
      // 草稿对象因快照/账号联动被换新引用时，必须从缓存恢复，而不是无脑清空——
      // 否则远端 api-proxy 草稿刚收到的回复会被一次无关的重渲染抹掉。
      const cachedDraftMessages = sessionMessagesCacheRef.current.get(getSessionCacheKey(session));
      if (cachedDraftMessages && cachedDraftMessages.length > 0) {
        applySessionHistory(cachedDraftMessages);
      } else {
        setMessages([]);
        setAllMessages([]);
        setHasMoreHistory(false);
      }
      clearLoadFailureMessage(message, CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY);
      return;
    }

    let disposed = false;
    const loadMessages = async () => {
      const cacheKey = getSessionCacheKey(session);
      const cached = sessionMessagesCacheRef.current.get(cacheKey);
      const cachedWindow = sessionHistoryWindowCacheRef.current.get(cacheKey);
      if (cached && cached.length > 0) {
        applySessionHistory(cached);
        if (cachedWindow?.hasMore) setHasMoreHistory(true);
      } else {
        setMessages([]);
        setAllMessages([]);
        setHasMoreHistory(false);
      }
      try {
        await reloadSessionHistory(session);
        if (disposed) return;
        setSelectedAccount((current) => {
          if (current?.provider === session.provider) return current;
          return accountsRef.current.find((account) => account.provider === session.provider) || current;
        });
        const ownerProject = projectsRef.current.find((project) => project.path === session.projectPath) || null;
        if (ownerProject) setSelectedProject(ownerProject);
      } catch (error) {
        if (disposed || isSessionRequestCancelled(error)) return;
        showLoadFailureMessage(message, CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY, '加载会话历史失败');
      }
    };

    loadMessages().catch(() => {});
    return () => {
      disposed = true;
    };
  }, [reloadSessionHistory, selectedSessionEffectKey]);

  useEffect(() => {
    clearSessionWatch();
    refreshSelectedSessionLoading();
    const session = selectedSessionRef.current;
    if (!session || session.draft
      || `${getSessionCacheKey(session)}:${session.draft ? 'draft' : 'saved'}` !== selectedSessionEffectKey) {
      return;
    }

    // detached run 恢复：刷新/切换后查服务端是否仍有本会话的 run 在跑（断连不 kill 之后 run 会
    // 活到跑完）。有 → 恢复"运行中"pending 态 + 记 runId（停止/回答走它）+ 恢复待回答的 prompt。
    if (session.id) {
      chatAPI.listActiveRuns(session.id, session.provider, session.projectDirName)
        .then((runs) => {
          const current = selectedSessionRef.current;
          if (!current || getSessionCacheKey(current) !== getSessionCacheKey(session)) return;
          if (findActiveRunKeyForSession(current)) return; // 本地已有 live run,不需要 detached 恢复
          const run = runs[0];
          if (!run || !run.runId) return;
          const stableKey = getSessionRunKey(current);
          if (!stableKey) return;
          detachedRunRef.current = { sessionKey: stableKey, runId: run.runId };
          markWatchPending(current, getThinkingStatusText(current.provider));
          if (run.activePrompt) {
            setInteractivePromptsByRunKey((existing) => ({ ...existing, [stableKey]: run.activePrompt! }));
          }
        });
    }

    if (session.id) {
      connectSessionWatch(session);
      return () => {
        clearSessionWatch();
        const cacheKey = getSessionCacheKey(session);
        [cacheKey, `${cacheKey}:snapshot-retry`, `${cacheKey}:reasoning-snapshot`].forEach((timerKey) => {
          const existingTimer = sessionReloadTimersRef.current.get(timerKey);
          if (existingTimer == null) return;
          window.clearTimeout(existingTimer);
          sessionReloadTimersRef.current.delete(timerKey);
        });
      };
    }
  }, [clearSessionWatch, connectSessionWatch, findActiveRunKeyForSession, markWatchPending, refreshSelectedSessionLoading, selectedSessionEffectKey]);

  const handleSelectProject = (project: AggregatedProject) => {
    setSelectedProject(project);
    hydrateProjectSessions(project.path, { projectPath: project.path }).catch(() => {});
    if (selectedSession && selectedSession.projectPath !== project.path) {
      setSelectedSession(null);
      setMessages([]);
      setAllMessages([]);
      setHasMoreHistory(false);
    }
  };

  const handleSelectSession = (session: Session) => {
    setSelectedSession(session);
    const ownerProject = projects.find((project) => project.path === session.projectPath) || null;
    if (ownerProject) {
      setSelectedProject(ownerProject);
      setExpandedProjects((current) => new Set([...current, ownerProject.id]));
    }
    if (isMobile) setMobileShowChat(true);
  };

  const handleCreateSession = () => {
    const targetProject = selectedProject;
    const defaultAccount = selectedAccount || accounts[0] || null;
    if (!targetProject) {
      message.warning('请先选择一个项目');
      return;
    }
    if (!defaultAccount) {
      // 无账号：先分清是"远端没连上"还是"真的没配账号"，避免误导。
      if (accountsLoadFailed) {
        message.error('远端账号尚未加载成功（连接异常），请点刷新重试，不是缺少账号配置');
      } else {
        message.warning('请先配置可用账号');
      }
      return;
    }

    const draftSession: Session = {
      id: `draft-${Date.now()}`,
      title: '新会话',
      updatedAt: Date.now(),
      provider: defaultAccount.provider,
      projectPath: targetProject.path,
      draft: true
    };
    setSelectedSession(draftSession);
    setSelectedAccount(defaultAccount);
    setMessages([]);
    setAllMessages([]);
    setHasMoreHistory(false);
    setInput('');
    if (isMobile) setMobileShowChat(true);
  };

  const handleMobileBack = useCallback(() => {
    setMobileShowChat(false);
  }, []);

  // iOS 风格左缘滑动返回：从屏幕左缘起手、横向滑出足够距离即返回列表
  const edgeSwipeRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const handleChatTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    edgeSwipeRef.current = { x: touch.clientX, y: touch.clientY, active: touch.clientX <= 28 };
  }, []);
  const handleChatTouchEnd = useCallback((e: React.TouchEvent) => {
    const state = edgeSwipeRef.current;
    if (!state.active) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - state.x;
    const dy = touch.clientY - state.y;
    edgeSwipeRef.current.active = false;
    if (dx > 64 && Math.abs(dx) > Math.abs(dy) * 1.6) handleMobileBack();
  }, [handleMobileBack]);

  const handlePickProject = async () => {
    setSelectedDirPath('');
    setCurrentPath('');
    setDirList([]);
    setDirModalVisible(true);
    loadLocalDirectory('');
  };

  const loadLocalDirectory = async (subDir: string) => {
    setLoadingDirs(true);
    try {
      const res = await sessionsAPI.browseProjectDirectory(subDir);
      if (res.ok) {
        setCurrentPath(res.currentDir);
        setParentPath(res.parentDir);
        setDirList(res.directories || []);
        setSelectedDirPath(res.currentDir);
      } else {
        message.error(res.message || '加载目录失败');
      }
    } catch (err: any) {
      message.error(`无法获取服务端目录列表: ${err.message || '未知错误'}`);
      setDirModalVisible(false);
    } finally {
      setLoadingDirs(false);
    }
  };

  const handleConfirmDirectory = () => {
    if (!selectedDirPath) {
      message.warning('请选择一个目录');
      return;
    }
    setOpenProjectPath(selectedDirPath);
    const parts = selectedDirPath.split(/[\\/]/).filter(Boolean);
    const lastPart = parts[parts.length - 1] || '';
    if (lastPart && !openProjectName.trim()) {
      setOpenProjectName(lastPart);
    }
    setDirModalVisible(false);
  };

  const renderBreadcrumbs = () => {
    if (!currentPath) return null;
    const parts = currentPath.split(/[\\/]/).filter(Boolean);
    const isWin = currentPath.includes('\\') || (parts.length > 0 && /^[a-zA-Z]:/.test(parts[0]));
    const breadcrumbItems = [];

    breadcrumbItems.push(
      <Breadcrumb.Item key="root" onClick={() => loadLocalDirectory('/')}>
        <span style={{ cursor: 'pointer', color: 'var(--color-info)' }}>[Root]</span>
      </Breadcrumb.Item>
    );

    let pathAccumulator = '';
    parts.forEach((part, index) => {
      if (index === 0 && /^[a-zA-Z]:/.test(part)) {
        pathAccumulator = part;
      } else {
        pathAccumulator += (isWin ? '\\' : '/') + part;
      }
      const targetPath = pathAccumulator;
      const isLast = index === parts.length - 1;
      breadcrumbItems.push(
        <Breadcrumb.Item key={index} onClick={isLast ? undefined : () => loadLocalDirectory(targetPath)}>
          <span style={isLast ? { fontWeight: 'bold' } : { cursor: 'pointer', color: 'var(--color-info)' }}>
            {part}
          </span>
        </Breadcrumb.Item>
      );
    });

    return (
      <Breadcrumb
        separator={<RightOutlined style={{ fontSize: '10px', color: '#bfbfbf' }} />}
        style={{ marginBottom: '16px', background: '#f5f5f5', padding: '8px 12px', borderRadius: '4px' }}
      >
        {breadcrumbItems}
      </Breadcrumb>
    );
  };

  const handleOpenProject = async () => {
    const projectPath = openProjectPath.trim();
    const projectName = openProjectName.trim();
    if (!projectPath) {
      message.warning('请输入项目路径');
      return;
    }
    try {
      const project = await sessionsAPI.openProject(projectPath, projectName || undefined);
      setOpenProjectVisible(false);
      setOpenProjectPath('');
      setOpenProjectName('');
      await loadProjects({ projectPath: project.path });
      setExpandedProjects((current) => new Set([...current, project.id]));
      setSelectedSession(null);
      if (isMobile) setMobileShowChat(false);
      message.success('项目已打开');
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '打开项目失败');
    }
  };

  const runSessionMessage = useCallback(async ({
    session,
    account,
    model,
    content,
    imageList
  }: {
    session: Session;
    account: ChatAccount;
    model?: string;
    content: string;
    imageList: string[];
  }) => {
    const requestSession = session;
    const requestProjectPath = requestSession.projectPath || selectedProject?.path;
    const resolvedProjectDirName = resolveSessionProjectDirName(
      account.provider,
      requestProjectPath,
      requestSession.projectDirName
    );
    if (!requestProjectPath) {
      throw new Error('当前会话缺少项目路径');
    }

    const requestRunKey = findActiveRunKeyForSession(requestSession) || getSessionRunKey(requestSession);
    const controller = new AbortController();
    let activeRunKey = requestRunKey;
    let usedNativeSession = false;
    let createdSessionId = '';
    const baseMessages = sessionMessagesCacheRef.current.get(getSessionCacheKey(requestSession))
      || (
        selectedSessionRef.current
        && getSessionCacheKey(selectedSessionRef.current) === getSessionCacheKey(requestSession)
          ? messages
          : []
      );
    let latestRunMessages = dedupeChatMessages([
      ...baseMessages,
      {
        role: 'user' as const,
        content: content.trim(),
        images: imageList.slice(),
        timestamp: Date.now()
      },
      {
        role: 'assistant',
        content: '',
        pending: true,
        statusText: '已发送，正在连接...',
        timestamp: Date.now()
      }
    ]);

    // native-session（claude/codex/gemini 且非 api-key 鉴权）由真实 CLI 自己持有会话历史，
    // 靠 sessionId resume 续上下文 —— payload 不应携带历史，只发当轮 prompt。
    // 代理路径（agy，或 api-key 鉴权的官方 provider）是无状态的，必须带历史；但要丢掉
    // 空内容 / pending 占位的 assistant 消息：发给 gemini/agy 上游会触发 INVALID_ARGUMENT（400）。
    const useNativeSession = (
      account.provider === 'claude'
      || account.provider === 'codex'
      || account.provider === 'gemini'
    ) && !account.apiKeyMode;
    const requestMessages = useNativeSession
      ? [{ role: 'user' as const, content: content.trim() }]
      : latestRunMessages
        .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
        .filter((message) => !(message.role === 'assistant' && !String(message.content || '').trim()))
        .map((message) => ({
          role: message.role,
          content: message.content
        }));

    const syncVisibleMessages = () => {
      const currentSession = selectedSessionRef.current;
      if (!currentSession) return;
      const currentRunKey = findActiveRunKeyForSession(currentSession) || getSessionRunKey(currentSession);
      if (
        currentRunKey !== activeRunKey
        && getSessionCacheKey(currentSession) !== getSessionCacheKey(requestSession)
      ) {
        return;
      }
      setMessages(latestRunMessages);
    };

    const persistRunMessages = (resolvedSession: Session) => {
      sessionMessagesCacheRef.current.set(getSessionCacheKey(resolvedSession), latestRunMessages);
      if (
        selectedSessionRef.current
        && getSessionCacheKey(selectedSessionRef.current) === getSessionCacheKey(resolvedSession)
      ) {
        applySessionHistory(latestRunMessages);
      } else {
        syncVisibleMessages();
      }
    };

    let resolvedSession: Session = requestSession;
    persistRunMessages(resolvedSession);

    registerActiveRun({
      runKey: activeRunKey,
      draftSessionId: requestSession.draft ? requestSession.id : undefined,
      provider: requestSession.provider,
      sessionId: requestSession.draft ? undefined : requestSession.id,
      projectDirName: requestSession.projectDirName,
      projectPath: requestProjectPath,
      controller
    });
    updateRunStatus(activeRunKey, '已发送，正在连接...');
    requestBrowserNotificationPermission();
    // 新一轮发送清掉本会话上一条 slash 命令残留的终端面板；若本轮也是 terminal slash，ready 会重新建。
    setTerminalRunsByKey((current) => {
      if (!(activeRunKey in current)) return current;
      const next = { ...current };
      delete next[activeRunKey];
      return next;
    });

    // 终端模式(slash 交互):终端本身是交互面，不走"正在处理"占位气泡(常驻终端永不"完成")。
    let isTerminalRun = false;

    const applyRunMessages = (updater: (current: ChatMessage[]) => ChatMessage[]) => {
      latestRunMessages = updater([...latestRunMessages]);
      persistRunMessages(resolvedSession);
    };

    const updateSelectedPendingStatus = (statusText: string) => {
      updateRunStatus(activeRunKey, statusText);
      const currentSession = selectedSessionRef.current;
      if (currentSession && getSessionCacheKey(currentSession) === getSessionCacheKey(resolvedSession)) {
        updatePendingAssistantStatus(statusText);
      }
    };

    try {
      const adoptCreatedSession = (nextSessionId: string) => {
        if (!nextSessionId || createdSessionId === nextSessionId) return;
        createdSessionId = nextSessionId;
        const nextRunKey = getActualSessionRunKey(account.provider, nextSessionId, resolvedProjectDirName);
        moveQueuedMessages(activeRunKey, nextRunKey);
        activeRunKey = renameActiveRun(activeRunKey, nextRunKey, {
          provider: account.provider,
          sessionId: nextSessionId,
          projectDirName: resolvedProjectDirName,
          projectPath: requestProjectPath
        });
        resolvedSession = {
          ...requestSession,
          id: nextSessionId,
          draft: false,
          provider: account.provider,
          projectPath: requestProjectPath,
          projectDirName: resolvedProjectDirName
        };
        persistRunMessages(resolvedSession);
        // 新会话落地为真实会话：内存记住本次用模，覆盖服务端用量扫描滞后（服务端会随用量落库）。
        if (model) rememberSessionModel(resolvedSession, model);
        updateSelectedPendingStatus(`会话已创建，${getGeneratingStatusText()}`);
        const stillOnDraft = Boolean(
          selectedSessionRef.current?.draft
          && getSessionCacheKey(selectedSessionRef.current) === getSessionCacheKey(requestSession)
        );
        // 立即把当前会话切到刚创建的真实会话——否则 selectedSession 仍是 draft，
        // URL 同步写不进 sessionId，刷新页面就又开了一个新会话（无限新会话）。
        if (stillOnDraft) {
          setSelectedSession(resolvedSession);
        }
        loadProjects(
          stillOnDraft
            ? {
                sessionId: nextSessionId,
                projectPath: requestProjectPath,
                provider: account.provider,
                projectDirName: resolvedProjectDirName
              }
            : { projectPath: requestProjectPath }
        ).catch(() => {});
      };

      const handleStreamEvent = (event: ChatStreamEvent) => {
        if (event.mode === 'native-session') {
          usedNativeSession = true;
        }
        if (event.type === 'ready' && event.runId) {
          updateActiveRun(activeRunKey, { runId: event.runId });
          if (event.interactionMode === 'terminal') {
            const runId = event.runId;
            isTerminalRun = true;
            setTerminalRunsByKey((current) => ({
              ...current,
              [activeRunKey]: {
                runId,
                command: String(event.slashCommand || '').trim(),
                active: true
              }
            }));
            // 终端就是交互面(slash 选择器等):去掉"正在处理"占位气泡——否则常驻终端永不"完成",
            // 气泡+停止钮一直卡。运行态改由 TerminalDock 顶部"运行中"指示。
            dropPendingAssistantPlaceholder();
            updateRunStatus(activeRunKey, '终端运行中');
            return;
          }
          updateSelectedPendingStatus('已连接，准备处理中...');
          return;
        }
        if (event.type === 'interactive-prompt' && event.prompt?.promptId) {
          const prompt = {
            ...event.prompt,
            runId: event.runId || event.prompt.runId
          };
          setInteractivePromptsByRunKey((current) => ({
            ...current,
            [activeRunKey]: prompt
          }));
          updateSelectedPendingStatus('等待选择计划处理方式...');
          return;
        }
        if (event.type === 'interactive-prompt-cleared') {
          setInteractivePromptsByRunKey((current) => {
            const currentPrompt = current[activeRunKey];
            if (!currentPrompt) return current;
            if (event.promptId && currentPrompt.promptId !== event.promptId) return current;
            const next = { ...current };
            delete next[activeRunKey];
            return next;
          });
          return;
        }
        if (event.type === 'session-created' && event.sessionId) {
          adoptCreatedSession(event.sessionId);
          return;
        }
        if (event.type === 'terminal-output' && event.text) {
          const runId = event.runId || '';
          const text = event.text;
          if (runId) {
            const writer = terminalWritersRef.current.get(runId);
            if (writer) {
              writer(text);
            } else {
              // 面板还没挂载好：先缓冲，registerTerminalWriter 注册时回放。
              const buffered = terminalOutputBufferRef.current.get(runId) || [];
              buffered.push(text);
              terminalOutputBufferRef.current.set(runId, buffered);
            }
          }
          // 终端模式不刷"正在处理"占位气泡(会把刚去掉的气泡又加回来 → 又卡)。
          if (!isTerminalRun) updateSelectedPendingStatus(getProcessingStatusText());
          return;
        }
        if (event.type === 'thinking' && event.thinking) {
          updateSelectedPendingStatus(getThinkingStatusText(requestSession.provider));
          applyRunMessages((next) => {
            return applyStreamingAssistantEvent(next, event, {
              timestamp: Date.now(),
              provider: requestSession.provider,
              thinkingStatusText: getThinkingStatusText(requestSession.provider)
            });
          });
          return;
        }
        if (event.type === 'delta') {
          updateSelectedPendingStatus(getGeneratingStatusText());
          applyRunMessages((next) => {
            return applyStreamingAssistantEvent(next, event, {
              timestamp: Date.now(),
              provider: requestSession.provider,
              generatingStatusText: getGeneratingStatusText()
            });
          });
          return;
        }
        // 工具调用实时流式：turn 进行中就把工具卡片追加到 pending 气泡(TUI 式)。
        if (event.type === 'assistant_tool_call' || event.type === 'assistant_tool_result') {
          applyRunMessages((next) => {
            return applyStreamingAssistantEvent(next, event, {
              timestamp: Date.now(),
              provider: requestSession.provider
            });
          });
          return;
        }
        if (event.type === 'result' || event.type === 'done') {
          if (requestSession.draft && event.sessionId && !createdSessionId) {
            adoptCreatedSession(event.sessionId);
          }
          if (typeof event.content === 'string' && event.content) {
            const finalContent = event.content;
            applyRunMessages((next) => {
              return applyStreamingAssistantEvent(next, event, {
                timestamp: Date.now(),
                provider: requestSession.provider
              });
            });
            notifyAssistantCompleted(requestSession.provider, finalContent);
          } else if (event.type === 'done') {
            applyRunMessages((next) => {
              return applyStreamingAssistantEvent(next, event, {
                timestamp: Date.now(),
                provider: requestSession.provider
              });
            });
            notifyAssistantCompleted(requestSession.provider, '');
          }
        }
      };

      await chatAPI.sendStream({
        messages: requestMessages,
        prompt: content.trim(),
        provider: account.provider,
        ...(isAihServerAccount(account)
          ? { gateway: true as const }
          : { accountRef: account.accountRef }),
        createSession: Boolean(requestSession.draft),
        sessionId: requestSession.draft ? undefined : requestSession.id,
        projectDirName: requestSession.draft ? undefined : requestSession.projectDirName,
        projectPath: requestProjectPath,
        model: model || undefined,
        images: imageList,
        approvalMode: approvalModeRef.current,
        stream: true
      }, {
        signal: controller.signal,
        onEvent: handleStreamEvent
      });

      if (requestSession.draft) {
        const stillOnDraft = Boolean(
          selectedSessionRef.current?.draft
          && getSessionCacheKey(selectedSessionRef.current) === getSessionCacheKey(requestSession)
        );
        if (createdSessionId) {
          await loadProjects({
            sessionId: stillOnDraft ? createdSessionId : undefined,
            projectPath: requestProjectPath,
            provider: account.provider,
            projectDirName: resolvedProjectDirName
          });
        } else if (usedNativeSession) {
          await loadProjects({ projectPath: requestProjectPath });
        }
      } else if (usedNativeSession) {
        await reloadSessionHistory(resolvedSession);
      }
    } catch (err: any) {
      // 出错（含 native_session_failed）时清掉卡住的"正在思考中"占位。
      // 关键：要从本轮 latestRunMessages 里移除并回写缓存，否则占位仍留在 draft 的会话缓存中，
      // 只清 setMessages 会在重渲染/再次查看该会话时又冒出来（image #14 的两个卡死气泡）。
      applyRunMessages((next) => {
        const list = next.slice();
        const last = list[list.length - 1];
        if (last && last.role === 'assistant' && last.pending) list.pop();
        return list;
      });
      if (
        selectedSessionRef.current
        && getSessionCacheKey(selectedSessionRef.current) === getSessionCacheKey(resolvedSession)
      ) {
        dropPendingAssistantPlaceholder();
      }
      throw err;
    } finally {
      unregisterActiveRun(activeRunKey);
      // 本轮结束（done/错误/中止）后把终端置为只读，但保留输出供查看（直到下一次发送或手动关闭）。
      setTerminalRunsByKey((current) => {
        const terminalRun = current[activeRunKey];
        if (!terminalRun || !terminalRun.active) return current;
        return {
          ...current,
          [activeRunKey]: { ...terminalRun, active: false }
        };
      });
      const nextQueued = shiftQueuedSessionMessage(activeRunKey);
      if (nextQueued && resolvedSession && !resolvedSession.draft) {
        const queuedToRun = nextQueued;
        const targetSession = resolvedSession;
        window.setTimeout(() => {
          const backgroundAccount = resolveQueuedAccount(queuedToRun, accounts);
          if (!backgroundAccount) return;
          runSessionMessage({
            session: targetSession,
            account: backgroundAccount,
            model: queuedToRun.model,
            content: queuedToRun.content,
            imageList: Array.isArray(queuedToRun.images) ? queuedToRun.images : []
          }).catch(() => {});
        }, 0);
      }
    }
  }, [
    accounts,
    applySessionHistory,
    findActiveRunKeyForSession,
    loadProjects,
    messages,
    moveQueuedMessages,
    notifyAssistantCompleted,
    registerActiveRun,
    reloadSessionHistory,
    renameActiveRun,
    requestBrowserNotificationPermission,
    selectedProject?.path,
    shiftQueuedSessionMessage,
    unregisterActiveRun,
    updateActiveRun,
    updateRunStatus
  ]);
  runSessionMessageRef.current = runSessionMessage;

  const handleSendQueuedMessageNow = useCallback((messageId: string) => {
    if (!selectedSession || !selectedSessionQueueKey) return;
    const queue = queuedMessagesByKey[selectedSessionQueueKey] || [];
    const queued = queue.find((item) => item.id === messageId);
    if (!queued) return;

    const currentRunKey = findActiveRunKeyForSession(selectedSession);
    if (currentRunKey) {
      prioritizeQueuedSessionMessage(selectedSessionQueueKey, messageId);
      const currentRun = activeRunsRef.current.get(currentRunKey);
      if (!currentRun) return;
      suppressAbortToastRef.current = true;
      currentRun.controller.abort();
      dropPendingAssistantPlaceholder();
      message.success('已切换为立即介入，这条需求会在当前轮停止后优先发送');
      return;
    }

    const account = resolveQueuedAccount(queued, accounts);
    if (!account) {
      message.error('找不到对应账号，无法立即发送这条队列消息');
      return;
    }
    removeQueuedSessionMessage(selectedSessionQueueKey, messageId);
    runSessionMessage({
      session: selectedSession,
      account,
      model: queued.model,
      content: queued.content,
      imageList: Array.isArray(queued.images) ? queued.images : []
    }).catch((err: any) => {
      setQueuedMessagesByKey((current) => prependQueuedMessage(current, selectedSessionQueueKey, queued));
      message.error(humanizeChatError(err, '立即发送失败'));
    });
  }, [
    accounts,
    findActiveRunKeyForSession,
    prependQueuedMessage,
    prioritizeQueuedSessionMessage,
    queuedMessagesByKey,
    removeQueuedSessionMessage,
    runSessionMessage,
    selectedSession,
    selectedSessionQueueKey
  ]);

  // ── P2c 插话(mid-run steer):把队列消息立即注入当前 run(claude native,同会话下一轮),
  // 不打断当前动作;支持 live 与 detached 两种 run。
  const handleSteerQueuedMessage = useCallback(async (messageId: string) => {
    if (!selectedSession || !selectedSessionQueueKey) return;
    const queue = queuedMessagesByKey[selectedSessionQueueKey] || [];
    const queued = queue.find((item) => item.id === messageId);
    if (!queued) return;
    const currentRunKey = findActiveRunKeyForSession(selectedSession);
    const activeRun = currentRunKey ? activeRunsRef.current.get(currentRunKey) : null;
    const stableKey = !selectedSession.draft ? getSessionRunKey(selectedSession) : '';
    const detached = detachedRunRef.current;
    const runId = activeRun?.runId
      || (detached && stableKey && detached.sessionKey === stableKey ? detached.runId : '');
    if (!runId) {
      message.warning('当前没有可插话的运行');
      return;
    }
    removeQueuedSessionMessage(selectedSessionQueueKey, messageId);
    try {
      await chatAPI.steerRun(runId, queued.content);
      // 乐观追加用户气泡(真实记录会随 CLI 会话文件落盘,done 后 reload 对齐)。
      setMessages((current) => [...current, { role: 'user', content: queued.content, timestamp: Date.now() }]);
      message.success('已插话,将在当前动作后处理');
    } catch (err: any) {
      setQueuedMessagesByKey((current) => prependQueuedMessage(current, selectedSessionQueueKey, queued));
      message.error(humanizeChatError(err, '插话失败(该运行可能不支持)'));
    }
  }, [
    findActiveRunKeyForSession,
    queuedMessagesByKey,
    removeQueuedSessionMessage,
    selectedSession,
    selectedSessionQueueKey
  ]);

  // ── P2b 队列持久化:切换会话时还原(不覆盖已有内存队列),队列变更即落 sessionStorage。
  useEffect(() => {
    if (!selectedSession || selectedSession.draft) return;
    const key = getSessionRunKey(selectedSession);
    if (!key) return;
    setQueuedMessagesByKey((current) => {
      if ((current[key] || []).length > 0) return current;
      const persisted = readPersistedQueue(key);
      if (persisted.length === 0) return current;
      return { ...current, [key]: persisted };
    });
  }, [selectedSession?.id, selectedSession?.provider, selectedSession?.projectDirName]);
  useEffect(() => {
    Object.entries(queuedMessagesByKey).forEach(([key, items]) => writePersistedQueue(key, items));
  }, [queuedMessagesByKey]);

  const handleSend = async () => {
    if (!input.trim()) return message.warning('请输入消息');
    if (!selectedAccount) return message.warning('请先选择一个账号');
    if (!selectedSession) return message.warning('请先选择一个会话');
    if (!selectedSession.draft && selectedAccount.provider !== selectedSession.provider) {
      return message.error(`当前会话来自 ${providerNames[selectedSession.provider]}，请选择对应的账号`);
    }

    const requestSession = selectedSession;
    const requestProjectPath = selectedProject?.path || requestSession.projectPath;
    if (!requestProjectPath) {
      return message.error('当前会话缺少项目路径');
    }
    const queuedContent = input.trim();
    const queuedImages = images.slice();
    const queuedMode: QueuedSessionMessage['mode'] = resolveQueuedMode(selectedAccount.provider, selectedAccount.apiKeyMode);
    setInput('');
    setImages([]);

    const currentRunKey = findActiveRunKeyForSession(requestSession);
    // detached run(刷新后恢复的运行中、本地无 activeRun)也要入队:用 detachedRunRef 指向的
    // 会话稳定键,watch turn-completed 时由上面的 flush 链路自动发出。
    const detached = detachedRunRef.current;
    const detachedKey = detached && requestSession && !requestSession.draft
      && detached.sessionKey === getSessionRunKey(requestSession)
      ? detached.sessionKey : '';
    const queueKey = currentRunKey || detachedKey;
    if (queueKey) {
      enqueueSessionMessage(queueKey, {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        content: queuedContent,
        images: queuedImages,
        createdAt: Date.now(),
        provider: selectedAccount.provider,
        ...(isAihServerAccount(selectedAccount)
          ? { gateway: true as const }
          : { accountRef: selectedAccount.accountRef }),
        model: selectedModel || undefined,
        mode: queuedMode
      });
      message.info('已入队,本轮结束后自动发送');
      return;
    }

    try {
      await runSessionMessage({
        session: requestSession,
        account: selectedAccount,
        model: selectedModel || undefined,
        content: queuedContent,
        imageList: queuedImages
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        if (suppressAbortToastRef.current) {
          suppressAbortToastRef.current = false;
        } else {
          message.info('已停止生成');
        }
      } else {
        suppressAbortToastRef.current = false;
        message.error(humanizeChatError(err, '发送失败'));
      }
      await (requestSession.draft
        ? loadProjects({ projectPath: requestProjectPath })
        : reloadSessionHistory(requestSession)
      ).catch(() => {});
    } finally {
      suppressAbortToastRef.current = false;
    }
  };

  const handleStop = () => {
    const session = selectedSessionRef.current;
    const currentRunKey = findActiveRunKeyForSession(session);
    if (currentRunKey) {
      const currentRun = activeRunsRef.current.get(currentRunKey);
      // 显式 stop：先调 abort 端点【真正 kill CLI 进程】，再关本地 SSE。只关 SSE 现在只会 detach
      // （服务端为长任务防腰斩改成断连不 kill），不调 abort 的话进程会继续在后台跑。
      if (currentRun?.runId) chatAPI.abortRun(currentRun.runId);
      currentRun?.controller.abort();
      dropPendingAssistantPlaceholder();
      return;
    }
    // detached run（刷新后恢复的"运行中"）：本地无 activeRun，用记录的 runId 直接 abort。
    const stableKey = session && !session.draft ? getSessionRunKey(session) : '';
    const detached = detachedRunRef.current;
    if (detached && stableKey && detached.sessionKey === stableKey) {
      chatAPI.abortRun(detached.runId);
      detachedRunRef.current = null;
      clearWatchPending();
    }
  };

  const toggleProject = (id: string) => {
    const next = new Set(expandedProjects);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedProjects(next);
  };

  const displayProjects = (() => {
    // 草稿会话所在项目若暂时不在项目列表里（快照迟到/来源不一致），补一个占位项目组，
    // 保证选中的草稿始终在列表里可见，不会"发着消息会话就消失了"。
    const baseProjects = selectedSession?.draft
      && selectedProject
      && !projects.some((project) => project.path === selectedProject.path)
      ? [{ ...selectedProject, sessions: [] }, ...projects]
      : [...projects];
    const nextProjects = !selectedSession?.draft || !selectedProject
      ? baseProjects
      : baseProjects.map((project) => {
      if (project.path !== selectedProject.path) return project;
      return {
        ...project,
        sessions: sortSessionsByUpdatedAtDesc([
          selectedSession,
          ...project.sessions.filter((session) => session.id !== selectedSession.id)
        ])
      };
    });
    return sortProjectsByLastActivityDesc(
      nextProjects.map((project) => ({
        ...project,
        sessions: sortSessionsByUpdatedAtDesc(project.sessions)
      }))
    );
  })();

  const projectListRunningSessionKeys = (() => {
    const next = new Set<string>();
    runningSessionKeys.forEach((key) => next.add(key));
    passiveRunningSessionKeys.forEach((key) => next.add(key));
    return next;
  })();
  const selectedSessionRunning = selectedSession
    ? isProjectSessionRunning(selectedSession, projectListRunningSessionKeys)
    : false;

  const currentProjectLabel = selectedProject?.name || '项目会话';
  const projectListNode = (
    <ProjectList
      mobile={isMobile}
      projects={displayProjects}
      loading={loadingProjects}
      hydratingProjectPaths={hydratingProjectPaths}
      runningSessionKeys={projectListRunningSessionKeys}
      selectedSession={selectedSession}
      selectedProject={selectedProject}
      expandedProjects={expandedProjects}
      onRefresh={loadProjects}
      onToggleProject={toggleProject}
      onSelectProject={handleSelectProject}
      onSelectSession={handleSelectSession}
      onOpenProject={() => {
        setOpenProjectVisible(true);
      }}
      onCreateSession={handleCreateSession}
      onProjectRemoved={(project) => {
        if (selectedProject?.path === project.path) {
          setSelectedProject(null);
        }
        if (selectedSession?.projectPath === project.path) {
          setSelectedSession(null);
          setMessages([]);
          setAllMessages([]);
          setHasMoreHistory(false);
        }
      }}
      remoteSessionsPanel={null}
    />
  );

  const isTerminated = selectedSession ? (!selectedSession.draft && !findProjectBySessionId(projects, { sessionId: selectedSession.id, provider: selectedSession.provider, projectPath: selectedSession.projectPath })) : false;

  const chatContentNode = selectedSession ? (
    <MessageArea
      mobile={isMobile}
      session={selectedSession}
      isTerminated={isTerminated}
      messages={messages}
      accounts={accounts}
      selectedAccount={selectedAccount}
      selectedModel={selectedModel}
      input={input}
      loading={loading}
      loadingStatusText={selectedSessionRunStatusText}
      queuedMessages={selectedQueuedMessages}
      externalPending={Boolean(!loading && watchPendingStatus && shouldUseExternalPending(selectedSession?.provider))}
      externalPendingStatusText={watchPendingStatus || selectedSessionRunStatusText || undefined}
      interactivePrompt={selectedSessionInteractivePrompt}
      hasMoreHistory={hasMoreHistory}
      images={images}
      onLoadMore={loadMoreHistory}
      onInputChange={setInput}
      onSend={handleSend}
      onStop={handleStop}
      onEditQueuedMessage={handleEditQueuedMessage}
      onRemoveQueuedMessage={handleRemoveQueuedMessage}
      onSendQueuedMessageNow={handleSendQueuedMessageNow}
      onSteerQueuedMessage={supportsMidRunSteer(selectedAccount?.provider || '', selectedAccount?.apiKeyMode) ? handleSteerQueuedMessage : undefined}
      approvalMode={approvalMode}
      onApprovalModeChange={selectedAccount?.provider === 'claude' && !selectedAccount?.apiKeyMode ? handleApprovalModeChange : undefined}
      onSelectPlanChoice={handleSelectPlanChoice}
      terminalRun={selectedSessionTerminalRun}
      onRegisterTerminalWriter={registerTerminalWriter}
      onTerminalInput={handleTerminalInput}
      onTerminalResize={handleTerminalResize}
      onCloseTerminal={handleCloseTerminal}
      onAccountChange={(account) => {
        setSelectedAccount(account);
        if (selectedSession.draft) {
          setSelectedSession({
            ...selectedSession,
            provider: account.provider
          });
        }
      }}
      onModelChange={setSelectedModel}
      onImagesChange={setImages}
      terminalCwd={selectedSession?.projectPath}
    />
  ) : selectedProject ? (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)', padding: isMobile ? 20 : 32 }}>
      <Empty
        description={`项目：${selectedProject.path}`}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      >
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateSession}>
          新建会话
        </Button>
      </Empty>
    </div>
  ) : (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)', padding: isMobile ? 20 : 32 }}>
      <Empty
        description="先打开一个项目，或从左上角展开项目列表"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      >
        <Button type="primary" icon={<FolderOpenOutlined />} onClick={() => {
          setOpenProjectVisible(true);
        }}>
          打开项目
        </Button>
      </Empty>
    </div>
  );

  return (
    <PageScaffold fullBleed>
      <Layout style={{ height: '100%', background: 'var(--color-bg)', overflow: 'hidden' }}>
      {isMobile ? (
        <div className={styles.mobileStack}>
          {/* 列表页（导航栈根视图）。头部（会话标题 + 工具栏）由 ProjectList 的 refreshBar
              合成单行头部承担，这里不再单列大标题行，省一行、贴 iOS。 */}
          <section className={`${styles.mobileScreen} ${mobileShowChat ? styles.mobileScreenBehind : ''}`}>
            <div className={styles.mobileScreenBody}>{projectListNode}</div>
          </section>

          {/* 对话页（push 进入） */}
          <section
            className={`${styles.mobileScreen} ${styles.mobileScreenChat} ${mobileShowChat ? styles.mobileScreenActive : ''}`}
            style={providerAccentStyle(selectedSession?.provider)}
            aria-hidden={!mobileShowChat}
            onTouchStart={handleChatTouchStart}
            onTouchEnd={handleChatTouchEnd}
          >
            <header className={styles.mobileNav}>
              <div className={styles.mobileNavSide}>
                <MobileBackButton className={styles.mobileBack} title="返回会话列表" label="会话" onClick={handleMobileBack} />
              </div>
              <div className={styles.mobileNavCenter}>
                {selectedSession?.provider ? (
                  <span className={`${styles.mobileNavBadge} ${selectedSessionRunning ? styles.mobileNavBadgeRunning : ''}`}>
                    <ProviderIcon provider={selectedSession.provider} size={16} />
                  </span>
                ) : null}
                <span className={styles.mobileNavTitle}>{selectedSession?.title || currentProjectLabel}</span>
              </div>
              <div className={styles.mobileNavSide}>
                <button
                  type="button"
                  className={styles.mobileNavAction}
                  aria-label="新建会话"
                  onClick={handleCreateSession}
                >
                  <PlusOutlined />
                </button>
              </div>
            </header>
            <div className={styles.mobileScreenBody}>{chatContentNode}</div>
          </section>
        </div>
      ) : (
        <>
          <Sider
            width={280}
            theme="light"
            breakpoint="md"
            collapsedWidth={0}
            style={{
              borderRight: '1px solid var(--color-border)',
              height: '100%',
              background: 'var(--color-surface-raised)'
            }}
          >
            {projectListNode}
          </Sider>

          <Content style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            {chatContentNode}
          </Content>
        </>
      )}

      <ModalForm
        title="打开项目"
        open={openProjectVisible}
        onOpenChange={(visible) => {
          if (!visible) setOpenProjectVisible(false);
        }}
        onFinish={async () => {
          await handleOpenProject();
          return true;
        }}
        submitter={{
          searchConfig: {
            submitText: '打开',
            resetText: '取消',
          },
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <Button onClick={handlePickProject}>
            选择文件夹
          </Button>
          <Input
            placeholder="不准手填，请点击选择文件夹按钮选择"
            value={openProjectPath}
            readOnly
            style={{ background: '#f5f5f5', color: '#595959' }}
          />
          <Input
            placeholder="项目名称（可选）"
            value={openProjectName}
            onChange={(e) => setOpenProjectName(e.target.value)}
          />
        </div>
      </ModalForm>

      <Modal
        title="服务端工作目录浏览器"
        open={dirModalVisible}
        onOk={handleConfirmDirectory}
        onCancel={() => setDirModalVisible(false)}
        okText="确认选择该路径"
        cancelText="取消"
        width={700}
        destroyOnClose
      >
        <div style={{ marginTop: '16px' }}>
          {renderBreadcrumbs()}

          <div
            className="directory-list-container"
            style={{
              border: '1px solid #d9d9d9',
              borderRadius: '4px',
              height: '350px',
              overflowY: 'auto',
              background: '#fff'
            }}
          >
            {loadingDirs ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', flexDirection: 'column', gap: '12px' }}>
                <LoadingOutlined style={{ fontSize: '24px' }} />
                <span>正在获取服务端目录列表，请稍后...</span>
              </div>
            ) : (
              <div style={{ padding: '8px 0' }}>
                {parentPath && currentPath !== parentPath && (
                  <div
                    className="dir-item"
                    style={{
                      padding: '8px 16px',
                      cursor: 'pointer',
                      background: '#fcfcfc',
                      borderBottom: '1px solid #f0f0f0',
                      userSelect: 'none'
                    }}
                    onDoubleClick={() => loadLocalDirectory(parentPath)}
                  >
                    <FolderOpenOutlined style={{ marginRight: '8px', color: '#faad14' }} />
                    <strong style={{ color: 'var(--color-info)' }}>.. (返回上级目录)</strong>
                  </div>
                )}

                {dirList.length === 0 ? (
                  <div style={{ padding: '40px 0', textAlign: 'center', color: '#bfbfbf' }}>
                    没有子目录。双击上级目录可返回。
                  </div>
                ) : (
                  dirList.map(dir => {
                    const isSelected = selectedDirPath === dir.path;
                    return (
                      <div
                        key={dir.path}
                        className="dir-item"
                        style={{
                          padding: '8px 16px',
                          cursor: 'pointer',
                          background: isSelected ? '#e6f7ff' : '#fff',
                          borderBottom: '1px solid #f5f5f5',
                          userSelect: 'none'
                        }}
                        onClick={() => setSelectedDirPath(dir.path)}
                        onDoubleClick={() => loadLocalDirectory(dir.path)}
                      >
                        <FolderOpenOutlined style={{ marginRight: '8px', color: '#faad14' }} />
                        <span>{dir.name}</span>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <div style={{ marginTop: '16px' }}>
            <span style={{ marginRight: '8px', fontWeight: 'bold' }}>当前选定路径:</span>
            <code style={{ background: '#f5f5f5', padding: '4px 8px', borderRadius: '4px', fontSize: '13px' }}>
              {selectedDirPath || '未选择'}
            </code>
          </div>
        </div>
      </Modal>
    </Layout>
    </PageScaffold>
  );
};

export default Chat;
