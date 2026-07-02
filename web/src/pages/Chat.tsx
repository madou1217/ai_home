import { useState, useEffect, useRef, useCallback } from 'react';
import { Layout, message, Empty, Modal, Input, Drawer, Grid, Breadcrumb } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import { chatAPI, accountsAPI, sessionsAPI, isSessionRequestCancelled, withWebUiAccessToken } from '@/services/api';
import type {
  ChatMessage,
  Account,
  AggregatedProject,
  Session,
  ChatStreamEvent,
  SessionEventItem,
  Provider,
  QueuedChatMessage,
  InteractivePrompt
} from '@/types';
import { ProjectList, MessageArea } from '@/components/chat';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
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
  resolveQueuedMode
} from '@/components/chat/queue-state.js';
import { FolderOpenOutlined, PlusOutlined, LeftOutlined, RightOutlined, LoadingOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import {
  readPersistedSelection,
  writePersistedSelection,
  readSelectionFromSearch
} from './chat-selection-state.js';
import {
  buildAssistantCompletionNotification,
  normalizeMessageText,
  shouldNotifyAssistantCompleted
} from './chat-notification.js';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const { Sider, Content } = Layout;

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
  accountId: string;
  model?: string;
  mode: 'after_turn' | 'after_tool_call';
};

type AccountIdentity = Pick<Account, 'provider' | 'accountId'>;
const getAccountKey = (account: AccountIdentity) => `${account.provider}:${account.accountId}`;

const pickChatAccount = (
  current: Account | null,
  accounts: Account[],
  preferredProvider?: Provider
) => {
  if (current) {
    const currentKey = getAccountKey(current);
    const nextCurrent = accounts.find((account) => getAccountKey(account) === currentKey);
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

const MODEL_STORAGE_PREFIX = 'chat-selected-model:';
const PROJECTS_CACHE_KEY = 'chat-projects-cache:v1';
const PROJECTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type CachedProjectsPayload = {
  updatedAt: number;
  projects: AggregatedProject[];
};

const readCachedProjects = (): AggregatedProject[] => {
  if (typeof window === 'undefined') return [];
  try {
    const payload = JSON.parse(localStorage.getItem(PROJECTS_CACHE_KEY) || 'null') as CachedProjectsPayload | null;
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
    localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify({
      updatedAt: Date.now(),
      projects
    }));
  } catch {}
};

const readPersistedModel = (provider: string): string => {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(`${MODEL_STORAGE_PREFIX}${provider}`) || '';
  } catch {
    return '';
  }
};
const writePersistedModel = (provider: string, model: string): void => {
  if (typeof window === 'undefined' || !provider || !model) return;
  try {
    localStorage.setItem(`${MODEL_STORAGE_PREFIX}${provider}`, model);
  } catch {}
};

const Chat = () => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [projects, setProjects] = useState<AggregatedProject[]>(() => readCachedProjects());
  const [selectedProject, setSelectedProject] = useState<AggregatedProject | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
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
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const search = window.location.search;
      const fromUrl = readSelectionFromSearch(search);
      const provider = fromUrl.provider || readPersistedSelection().provider;
      if (provider) {
        return readPersistedModel(provider);
      }
    }
    return '';
  });
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
  const [mobileProjectPickerOpen, setMobileProjectPickerOpen] = useState(false);
  const selectedSessionRef = useRef<Session | null>(null);
  const selectedProjectStateRef = useRef<AggregatedProject | null>(null);
  const initialSelectionRef = useRef<PersistedChatSelection>(readPersistedSelection());
  const pendingProjectSelectionRef = useRef<PersistedChatSelection>(initialSelectionRef.current);
  const projectSnapshotReceivedAtRef = useRef(0);
  const projectSnapshotRevisionRef = useRef(0);
  const projectRefreshFallbackTimerRef = useRef<number | null>(null);
  const activeRunsRef = useRef<Map<string, ActiveSessionRun>>(new Map());
  const sessionMessagesCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  const sessionCursorCacheRef = useRef<Map<string, number>>(new Map());
  const sessionReloadTimersRef = useRef<Map<string, number>>(new Map());
  const activeRunWatchersRef = useRef<Map<string, { eventSource: EventSource | null; cursor: number; reconnectTimer: number | null }>>(new Map());
  // 终端写入通道（按 runId）：terminal-output 直接写进 xterm；面板尚未挂载时先缓冲，注册时回放。
  const terminalWritersRef = useRef<Map<string, (data: string) => void>>(new Map());
  const terminalOutputBufferRef = useRef<Map<string, string[]>>(new Map());
  const sessionWatchRef = useRef<EventSource | null>(null);
  const sessionWatchReconnectTimerRef = useRef<number | null>(null);
  const projectRuntimeWatchRef = useRef<EventSource | null>(null);
  const projectRuntimeReconnectTimerRef = useRef<number | null>(null);
  const accountsRef = useRef<Account[]>([]);
  const accountsSnapshotReceivedAtRef = useRef(0);
  const watchPendingStartedAtRef = useRef<number>(0);
  const resumeSyncTimerRef = useRef<number | null>(null);
  const notificationPermissionRequestedRef = useRef(false);
  const hiddenAtRef = useRef<number>(0);
  const suppressAbortToastRef = useRef(false);
  const reloadSessionHistoryRef = useRef<(session: Session) => Promise<void>>(async () => {});
  const applySessionEventsRef = useRef<(session: Session, events: SessionEventItem[]) => void>(() => {});
  const runSessionMessageRef = useRef<null | ((args: {
    session: Session;
    account: Account;
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

  const loadMoreHistory = () => {
    const currentLen = messages.length;
    const totalLen = allMessages.length;
    if (currentLen >= totalLen) return;
    const moreCount = Math.min(LOAD_MORE_COUNT, totalLen - currentLen);
    const startIdx = totalLen - currentLen - moreCount;
    setMessages(allMessages.slice(Math.max(0, startIdx)));
    setHasMoreHistory(startIdx > 0);
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
      p.name !== '默认项目' && p.path && p.path !== '默认项目' && p.path.startsWith('/')
    );
  };

  const normalizeProjects = (items: AggregatedProject[]) => (
    Array.isArray(items)
      ? sortProjectsByLastActivityDesc(items.filter((p) =>
        p.name !== '默认项目' && p.path && p.path !== '默认项目' && p.path.startsWith('/')
      ))
      : []
  );

  const clearProjectRefreshFallbackTimer = () => {
    if (projectRefreshFallbackTimerRef.current === null) return;
    window.clearTimeout(projectRefreshFallbackTimerRef.current);
    projectRefreshFallbackTimerRef.current = null;
  };

  const applyProjectSnapshot = (items: AggregatedProject[], options: PersistedChatSelection = {}) => {
    const filtered = normalizeProjects(items);
    writeCachedProjects(filtered);
    setProjects(filtered);
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
        if (options.projectPath) {
          setExpandedProjects((current) => new Set([...current, project.id]));
        }
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
    if (selectedSessionRef.current?.id === session.id && selectedSessionRef.current?.provider === session.provider) {
      return;
    }

    clearActiveRunWatch(runKey);
    const params = new URLSearchParams();
    params.set('sessionId', session.id);
    params.set('provider', session.provider);
    if (session.projectDirName) params.set('projectDirName', session.projectDirName);

    const state = {
      eventSource: new EventSource(withWebUiAccessToken(`/v0/webui/sessions/watch?${params.toString()}`)),
      cursor: 0,
      reconnectTimer: null as number | null
    };
    activeRunWatchersRef.current.set(runKey, state);

    state.eventSource.onmessage = () => {
      sessionsAPI.getSessionEvents(session.provider, session.id, state.cursor, session.projectDirName)
        .then((payload) => {
          state.cursor = payload.cursor;
          if ((payload.events || []).some((event) => event.type === 'assistant_tool_call')) {
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
    if (!currentSession || currentSession.id !== session.id) return;
    if (!watchPendingStartedAtRef.current) {
      watchPendingStartedAtRef.current = Date.now();
    }
    setWatchPendingStatus(statusText);
  }, []);

  const scheduleSessionReload = useCallback((session: Session, delayMs = 180) => {
    const cacheKey = `${session.provider}:${session.id}:${session.projectDirName || ''}`;
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
        sessionCursorCacheRef.current.set(cacheKey, payload.cursor);
        if (payload.events && payload.events.length > 0) {
          applySessionEventsRef.current(session, payload.events);
        }
        if (payload.requiresSnapshot) {
          const hasReasoningEvent = payload.events?.some((event) => event.type === 'assistant_reasoning');
          if (hasReasoningEvent) {
            window.setTimeout(() => {
              reloadSessionHistoryRef.current(session).catch(() => {});
            }, 420);
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
    const previousHistory = sessionMessagesCacheRef.current.get(getSessionCacheKey(session)) || [];
    const bundle = await sessionsAPI.getSessionMessagesBundle(
      session.provider,
      session.id,
      session.projectDirName
    );
    const history = bundle.messages;
    sessionMessagesCacheRef.current.set(getSessionCacheKey(session), history);
    sessionCursorCacheRef.current.set(getSessionCacheKey(session), bundle.cursor);
    if (selectedSessionRef.current && selectedSessionRef.current.id === session.id) {
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
      applySessionHistory(history);
    }
  }, [clearWatchPending]);

  const applySessionEvents = useCallback((session: Session, events: SessionEventItem[]) => {
    if (!Array.isArray(events) || events.length === 0) return;
    const cacheKey = getSessionCacheKey(session);
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
        clearWatchPending();
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
        clearWatchPending();
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
    if (selectedSessionRef.current?.id === session.id) {
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

    const eventSource = new EventSource(withWebUiAccessToken(`/v0/webui/sessions/watch?${params.toString()}`));
    sessionWatchRef.current = eventSource;

    eventSource.onmessage = (evt) => {
      if (findActiveRunKeyForSession(session)) {
        return;
      }
      try {
        const data = JSON.parse(evt.data);
        const action = resolveSessionWatchUpdateAction(data);
        if (action.clearPending) {
          clearWatchPending();
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
        && currentSession.id === session.id;
      if (!canReconnect) return;
      sessionWatchReconnectTimerRef.current = window.setTimeout(() => {
        sessionWatchReconnectTimerRef.current = null;
        const latestSession = selectedSessionRef.current;
        if (!latestSession || latestSession.draft || latestSession.id !== session.id) return;
        connectSessionWatch(latestSession);
      }, 1200);
    };
  }, [clearSessionWatch, clearWatchPending, findActiveRunKeyForSession, markWatchPending, scheduleSessionReload]);

  const connectProjectRuntimeWatch = useCallback(() => {
    if (typeof window === 'undefined') return;

    clearProjectRuntimeWatch();
    const eventSource = sessionsAPI.watchProjects({
      onSnapshot: ({ revision, projects: nextProjects }) => {
        projectSnapshotReceivedAtRef.current = Date.now();
        projectSnapshotRevisionRef.current = revision;
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
    try {
      const { accounts: data } = await accountsAPI.list();
      applyChatAccounts(data);
    } catch {
      message.error('加载账号失败');
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
    setLoadingProjects(true);
    try {
      const filtered = await fetchProjects();
      projectSnapshotReceivedAtRef.current = Date.now();
      applyProjectSnapshot(filtered, options);
    } catch {
      message.error('加载项目失败');
    } finally {
      setLoadingProjects(false);
      clearProjectRefreshFallbackTimer();
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
        applyChatAccounts(snapshotAccounts);
      },
      onAccount: (account) => {
        const accountKey = getAccountKey(account);
        const withoutAccount = accountsRef.current.filter((item) => getAccountKey(item) !== accountKey);
        applyChatAccounts(isChatSelectableAccount(account) ? [...withoutAccount, account] : withoutAccount);
      },
      onAccountRemoved: (event) => {
        const removedKey = getAccountKey(event);
        applyChatAccounts(accountsRef.current.filter((account) => getAccountKey(account) !== removedKey));
      },
      onError: () => {
        if (accountsSnapshotReceivedAtRef.current > 0) return;
        loadAccounts().catch(() => {});
      }
    });
    return () => {
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

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

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
      if (selectedSession?.id === session.id && selectedSession?.provider === session.provider) {
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

  useEffect(() => {
    if (selectedSession?.provider && selectedModel) {
      writePersistedModel(selectedSession.provider, selectedModel);
    }
  }, [selectedModel, selectedSession?.provider]);

  useEffect(() => {
    if (selectedSession?.provider) {
      const saved = readPersistedModel(selectedSession.provider);
      setSelectedModel(saved);
    }
  }, [selectedSession?.provider]);

  const selectedSessionRunKey = selectedSession ? findActiveRunKeyForSession(selectedSession) : '';
  const selectedSessionInteractivePrompt = selectedSessionRunKey
    ? interactivePromptsByRunKey[selectedSessionRunKey] || null
    : null;
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
    const currentRunKey = findActiveRunKeyForSession(selectedSessionRef.current);
    const activeRun = currentRunKey ? activeRunsRef.current.get(currentRunKey) : null;
    const activePrompt = currentRunKey ? interactivePromptsByRunKey[currentRunKey] : null;
    if (!currentRunKey || !activeRun?.runId || !activePrompt || activePrompt.promptId !== prompt.promptId) {
      message.warning('当前计划选择已过期');
      return;
    }

    try {
      setInteractivePromptsByRunKey((current) => {
        if (current[currentRunKey]?.promptId !== prompt.promptId) return current;
        const next = { ...current };
        delete next[currentRunKey];
        return next;
      });
      await chatAPI.sendRunInput(activeRun.runId, normalizedChoice, true, prompt.promptId);
      updateRunStatus(currentRunKey, '已提交计划选择');
    } catch (error: any) {
      setInteractivePromptsByRunKey((current) => {
        if (current[currentRunKey]) return current;
        return {
          ...current,
          [currentRunKey]: prompt
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

  const selectedProjectRef = (items: AggregatedProject[], projectPath?: string) =>
    items.find((project) => project.path === projectPath) || null;

  useEffect(() => {
    clearSessionWatch();
    refreshSelectedSessionLoading();
    if (!selectedSession) return;
    if (selectedSession.draft) {
      setMessages([]);
      setAllMessages([]);
      setHasMoreHistory(false);
      refreshSelectedSessionLoading();
      return;
    }

    const loadMessages = async () => {
      const cached = sessionMessagesCacheRef.current.get(getSessionCacheKey(selectedSession));
      if (cached && cached.length > 0) {
        applySessionHistory(cached);
      } else {
        setMessages([]);
        setAllMessages([]);
        setHasMoreHistory(false);
      }
      try {
        const bundle = await sessionsAPI.getSessionMessagesBundle(
          selectedSession.provider,
          selectedSession.id,
          selectedSession.projectDirName
        );
        const history = bundle.messages;
        sessionMessagesCacheRef.current.set(getSessionCacheKey(selectedSession), history);
        sessionCursorCacheRef.current.set(getSessionCacheKey(selectedSession), bundle.cursor);
        if (selectedSessionRef.current && selectedSessionRef.current.id === selectedSession.id) {
          applySessionHistory(history);
        }

        if (!selectedAccount || selectedAccount.provider !== selectedSession.provider) {
          const match = accounts.find((a) => a.provider === selectedSession.provider);
          if (match) setSelectedAccount(match);
        }
        const ownerProject = selectedProjectRef(projects, selectedSession.projectPath);
        if (ownerProject) setSelectedProject(ownerProject);
      } catch {
        message.error('加载会话历史失败');
      }
    };

    loadMessages();

    if (selectedSession.id) {
      connectSessionWatch(selectedSession);
      return () => {
        clearSessionWatch();
        const cacheKey = getSessionCacheKey(selectedSession);
        const existingTimer = sessionReloadTimersRef.current.get(cacheKey);
        if (existingTimer) {
          window.clearTimeout(existingTimer);
          sessionReloadTimersRef.current.delete(cacheKey);
        }
      };
    }
  }, [clearSessionWatch, connectSessionWatch, refreshSelectedSessionLoading, selectedSession]);

  const handleSelectProject = (project: AggregatedProject) => {
    setSelectedProject(project);
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
      message.warning('请先配置可用账号');
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
      setMobileProjectPickerOpen(false);
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
    account: Account;
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
      || (selectedSessionRef.current?.id === requestSession.id ? messages : []);
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
      if (currentRunKey !== activeRunKey && !(currentSession.id === requestSession.id && currentSession.provider === requestSession.provider)) {
        return;
      }
      setMessages(latestRunMessages);
    };

    const persistRunMessages = (resolvedSession: Session) => {
      sessionMessagesCacheRef.current.set(getSessionCacheKey(resolvedSession), latestRunMessages);
      if (selectedSessionRef.current?.id === resolvedSession.id && selectedSessionRef.current?.provider === resolvedSession.provider) {
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

    const applyRunMessages = (updater: (current: ChatMessage[]) => ChatMessage[]) => {
      latestRunMessages = updater([...latestRunMessages]);
      persistRunMessages(resolvedSession);
    };

    const updateSelectedPendingStatus = (statusText: string) => {
      updateRunStatus(activeRunKey, statusText);
      const currentSession = selectedSessionRef.current;
      if (currentSession && currentSession.id === resolvedSession.id && currentSession.provider === resolvedSession.provider) {
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
        updateSelectedPendingStatus(`会话已创建，${getGeneratingStatusText()}`);
        const stillOnDraft = Boolean(selectedSessionRef.current?.draft && selectedSessionRef.current.id === requestSession.id);
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
            setTerminalRunsByKey((current) => ({
              ...current,
              [activeRunKey]: {
                runId,
                command: String(event.slashCommand || '').trim(),
                active: true
              }
            }));
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
          updateSelectedPendingStatus(getProcessingStatusText());
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
        accountId: account.accountId,
        createSession: Boolean(requestSession.draft),
        sessionId: requestSession.draft ? undefined : requestSession.id,
        projectDirName: requestSession.draft ? undefined : requestSession.projectDirName,
        projectPath: requestProjectPath,
        model: model || undefined,
        images: imageList,
        stream: true
      }, {
        signal: controller.signal,
        onEvent: handleStreamEvent
      });

      if (requestSession.draft) {
        const stillOnDraft = Boolean(selectedSessionRef.current?.draft && selectedSessionRef.current.id === requestSession.id);
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
      if (selectedSessionRef.current?.id === resolvedSession.id && selectedSessionRef.current?.provider === resolvedSession.provider) {
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
          const backgroundAccount = accounts.find((item) =>
            item.provider === queuedToRun.provider && item.accountId === queuedToRun.accountId
          );
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

    const account = accounts.find((item) =>
      item.provider === queued.provider && item.accountId === queued.accountId
    );
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
      message.error(err?.response?.data?.error || err?.response?.data?.message || err?.message || '立即发送失败');
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
    if (currentRunKey) {
      enqueueSessionMessage(currentRunKey, {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        content: queuedContent,
        images: queuedImages,
        createdAt: Date.now(),
        provider: selectedAccount.provider,
        accountId: selectedAccount.accountId,
        model: selectedModel || undefined,
        mode: queuedMode
      });
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
        message.error(err?.response?.data?.error || err?.response?.data?.message || err?.message || '发送失败');
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
    const currentRunKey = findActiveRunKeyForSession(selectedSessionRef.current);
    if (!currentRunKey) return;
    const currentRun = activeRunsRef.current.get(currentRunKey);
    currentRun?.controller.abort();
    dropPendingAssistantPlaceholder();
  };

  const toggleProject = (id: string) => {
    const next = new Set(expandedProjects);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedProjects(next);
  };

  const displayProjects = (() => {
    const nextProjects = !selectedSession?.draft || !selectedProject
      ? [...projects]
      : projects.map((project) => {
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
      runningSessionKeys={projectListRunningSessionKeys}
      selectedSession={selectedSession}
      selectedProject={selectedProject}
      expandedProjects={expandedProjects}
      onRefresh={loadProjects}
      onToggleProject={toggleProject}
      onSelectProject={handleSelectProject}
      onSelectSession={handleSelectSession}
      onOpenProject={() => {
        if (isMobile) {
          setMobileProjectPickerOpen(true);
          return;
        }
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
          if (isMobile) {
            setMobileProjectPickerOpen(true);
            return;
          }
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
          {/* 列表页（导航栈根视图） */}
          <section className={`${styles.mobileScreen} ${mobileShowChat ? styles.mobileScreenBehind : ''}`}>
            <header className={styles.mobileNav}>
              <h1 className={styles.mobileNavTitleLarge}>会话</h1>
            </header>
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
                <button type="button" className={styles.mobileBack} onClick={handleMobileBack} aria-label="返回会话列表">
                  <LeftOutlined />
                  <span>会话</span>
                </button>
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

      {isMobile ? (
        <Drawer
          placement="right"
          width="100vw"
          open={mobileProjectPickerOpen}
          onClose={() => setMobileProjectPickerOpen(false)}
          title="打开项目"
          styles={{
            header: { padding: '16px', borderBottom: '1px solid var(--color-border)' },
            body: { padding: '16px 16px calc(20px + env(safe-area-inset-bottom))' }
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: '100%' }}>
            <Button onClick={handlePickProject} size="large">
              选择文件夹
            </Button>
            <Input
              size="large"
              placeholder="不准手填，请点击选择文件夹按钮选择"
              value={openProjectPath}
              readOnly
              style={{ background: '#f5f5f5', color: '#595959' }}
            />
            <Input
              size="large"
              placeholder="项目名称（可选）"
              value={openProjectName}
              onChange={(e) => setOpenProjectName(e.target.value)}
            />
            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Button type="primary" size="large" onClick={handleOpenProject}>
                打开项目
              </Button>
              <Button size="large" onClick={() => setMobileProjectPickerOpen(false)}>
                取消
              </Button>
            </div>
          </div>
        </Drawer>
      ) : (
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
      )}

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
