import { useState, useEffect, useRef, useCallback } from 'react';
import { Layout, message, Empty, Button, Modal, Input, Drawer, Grid } from 'antd';
import { chatAPI, accountsAPI, sessionsAPI, isSessionRequestCancelled } from '@/services/api';
import type { ChatMessage, Account, AggregatedProject, Session, ChatStreamEvent, SessionEventItem, Provider, QueuedChatMessage } from '@/types';
import { ProjectList, MessageArea } from '@/components/chat';
import { providerNames } from '@/components/chat/ProviderIcon';
import {
  getActualSessionRunKey,
  getSessionRunKey,
  findActiveRunKeyForSession as findActiveRunKeyForSessionState,
  collectRunningSessionKeys,
  resolveSelectedSessionQueueKey
} from '@/components/chat/active-run-state.js';
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
import { FolderOpenOutlined, PlusOutlined, MenuOutlined } from '@ant-design/icons';
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

const cleanLiveTerminalChunk = (text: string) => {
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return '';
  const trimmed = raw.trim();
  if (
    trimmed.startsWith('{"session_id":')
    || trimmed.startsWith('{"chars":')
    || trimmed.startsWith('{"input":')
  ) {
    return '';
  }

  const lines = raw.split('\n');
  const cleaned: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^Chunk ID:\s*/.test(line)) {
      index += 1;
      while (
        index < lines.length
        && !/^Output:\s*(.*)$/.test(lines[index])
        && !/^Chunk ID:\s*/.test(lines[index])
      ) {
        index += 1;
      }
      if (index < lines.length && /^Output:\s*(.*)$/.test(lines[index])) {
        const outputMatch = lines[index].match(/^Output:\s*(.*)$/);
        if (outputMatch?.[1]) cleaned.push(outputMatch[1]);
        index += 1;
        while (index < lines.length && !/^Chunk ID:\s*/.test(lines[index])) {
          cleaned.push(lines[index]);
          index += 1;
        }
      }
      continue;
    }
    if (
      /^Wall time:\s*/.test(line)
      || /^Process (?:running|exited) with session ID\s*/.test(line)
      || /^Original token count:\s*/.test(line)
      || /^Output:\s*$/.test(line)
    ) {
      index += 1;
      continue;
    }
    cleaned.push(line);
    index += 1;
  }
  return cleaned.join('\n').trim();
};

const Chat = () => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [projects, setProjects] = useState<AggregatedProject[]>([]);
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
  const [queuedMessagesByKey, setQueuedMessagesByKey] = useState<Record<string, QueuedSessionMessage[]>>({});
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [images, setImages] = useState<string[]>([]);
  const [openProjectVisible, setOpenProjectVisible] = useState(false);
  const [openProjectPath, setOpenProjectPath] = useState('');
  const [openProjectName, setOpenProjectName] = useState('');
  const [pickingProject, setPickingProject] = useState(false);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [mobileProjectPickerOpen, setMobileProjectPickerOpen] = useState(false);
  const selectedSessionRef = useRef<Session | null>(null);
  const initialSelectionRef = useRef<PersistedChatSelection>(readPersistedSelection());
  const activeRunsRef = useRef<Map<string, ActiveSessionRun>>(new Map());
  const sessionMessagesCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  const sessionCursorCacheRef = useRef<Map<string, number>>(new Map());
  const sessionReloadTimersRef = useRef<Map<string, number>>(new Map());
  const activeRunWatchersRef = useRef<Map<string, { eventSource: EventSource | null; cursor: number; reconnectTimer: number | null }>>(new Map());
  const sessionWatchRef = useRef<EventSource | null>(null);
  const sessionWatchReconnectTimerRef = useRef<number | null>(null);
  const projectRuntimeWatchRef = useRef<EventSource | null>(null);
  const projectRuntimeReconnectTimerRef = useRef<number | null>(null);
  const watchPendingStartedAtRef = useRef<number>(0);
  const resumeSyncTimerRef = useRef<number | null>(null);
  const notificationPermissionRequestedRef = useRef(false);
  const hiddenAtRef = useRef<number>(0);
  const suppressAbortToastRef = useRef(false);
  const reloadSessionHistoryRef = useRef<(session: Session) => Promise<void>>(async () => {});
  const applySessionEventsRef = useRef<(session: Session, events: SessionEventItem[]) => void>(() => {});

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
      eventSource: new EventSource(`/v0/webui/sessions/watch?${params.toString()}`),
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
    if (!selectedSession || selectedSession.draft) {
      clearWatchPending();
    }
  }, [clearWatchPending, selectedSession]);

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

    const eventSource = new EventSource(`/v0/webui/sessions/watch?${params.toString()}`);
    sessionWatchRef.current = eventSource;

    eventSource.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === 'update') {
          markWatchPending(
            session,
            supportsSessionWatchPending(session.provider)
              ? getThinkingStatusText(session.provider)
              : getGeneratingStatusText()
          );
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
  }, [clearSessionWatch, markWatchPending, scheduleSessionReload]);

  const connectProjectRuntimeWatch = useCallback(() => {
    if (typeof window === 'undefined') return;

    clearProjectRuntimeWatch();
    const eventSource = new EventSource('/v0/webui/projects/watch');
    projectRuntimeWatchRef.current = eventSource;

    eventSource.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === 'runtime') {
          setPassiveRunningSessionKeys(new Set(
            Array.isArray(data.runningSessionKeys) ? data.runningSessionKeys.map((item: unknown) => String(item || '')) : []
          ));
        }
      } catch {}
    };

    eventSource.onerror = () => {
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
    };
  }, [clearProjectRuntimeWatch]);

  const handleResumeSync = useCallback(async (_syncReason: 'visible' | 'online' | 'pageshow') => {
    const session = selectedSessionRef.current;
    connectProjectRuntimeWatch();
    if (!session) return;

    if (session.draft) return;

    connectSessionWatch(session);

    try {
      await reloadSessionHistory(session);
      await loadProjects({
        sessionId: session.id,
        projectPath: session.projectPath,
        provider: session.provider,
        projectDirName: session.projectDirName
      });
    } catch {}
  }, [connectProjectRuntimeWatch, connectSessionWatch, reloadSessionHistory]);

  const loadAccounts = async () => {
    try {
      const { accounts: data } = await accountsAPI.list();
      const usableAccounts = data.filter((a) => a.configured && !a.exhausted);
      setAccounts(usableAccounts);
      setSelectedAccount((current) => {
        if (!current) return usableAccounts[0] || null;
        const next = usableAccounts.find((item) =>
          item.provider === current.provider && item.accountId === current.accountId
        );
        return next || usableAccounts[0] || null;
      });
    } catch {
      message.error('加载账号失败');
    }
  };

  const loadProjects = async (options: PersistedChatSelection = {}) => {
    setLoadingProjects(true);
    try {
      const filtered = await fetchProjects();
      setProjects(filtered);
      if (options.sessionId) {
        const matched = findProjectBySessionId(filtered, options);
        if (matched) {
          setExpandedProjects((current) => new Set([...current, matched.project.id]));
          setSelectedProject(matched.project);
          setSelectedSession(matched.session);
          return;
        }
      }
      if (options.projectPath) {
        const project = filtered.find((item) => item.path === options.projectPath) || null;
        if (project) {
          setExpandedProjects((current) => new Set([...current, project.id]));
        }
        setSelectedProject(project);
      }
    } catch {
      message.error('加载项目失败');
    } finally {
      setLoadingProjects(false);
    }
  };

  useEffect(() => {
    loadAccounts();
    const initialSelection = initialSelectionRef.current;
    connectProjectRuntimeWatch();
    loadProjects({
      sessionId: initialSelection.sessionId,
      projectPath: initialSelection.projectPath,
      provider: initialSelection.provider,
      projectDirName: initialSelection.projectDirName
    });
  }, [connectProjectRuntimeWatch]);

  useEffect(() => {
    if (!isMobile) return;
    if (selectedProject || selectedSession) return;
    if (projects.length === 0) return;
    setProjectDrawerOpen(true);
  }, [isMobile, projects.length, selectedProject, selectedSession]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

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

  const selectedSessionRunKey = selectedSession ? findActiveRunKeyForSession(selectedSession) : '';
  const selectedSessionRunStatusText = selectedSessionRunKey
    ? runStatusByKey[selectedSessionRunKey] || undefined
    : undefined;
  const selectedSessionQueueKey = resolveSelectedSessionQueueKey(selectedSession, selectedSessionRunKey);
  const selectedQueuedMessages = selectedSessionQueueKey ? (queuedMessagesByKey[selectedSessionQueueKey] || []) : [];

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
    if (isMobile) setProjectDrawerOpen(false);
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
    if (isMobile) setProjectDrawerOpen(false);
  };

  const handlePickProject = async () => {
    setPickingProject(true);
    try {
      const result = await sessionsAPI.pickProjectDirectory();
      if (result.cancelled) return;
      if (result.project?.path) {
        setOpenProjectPath(result.project.path);
      }
      if (result.project?.name && !openProjectName.trim()) {
        setOpenProjectName(result.project.name);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '无法打开目录选择器');
    } finally {
      setPickingProject(false);
    }
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
      if (isMobile) setProjectDrawerOpen(true);
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
    if (!requestProjectPath) {
      throw new Error('当前会话缺少项目路径');
    }

    const requestRunKey = findActiveRunKeyForSession(requestSession) || getSessionRunKey(requestSession);
    const controller = new AbortController();
    let activeRunKey = requestRunKey;
    let usedNativeSession = false;
    let createdSessionId = '';
    let latestRunMessages = dedupeChatMessages([
      ...(sessionMessagesCacheRef.current.get(getSessionCacheKey(requestSession)) || (selectedSessionRef.current?.id === requestSession.id ? messages : [])),
      {
        role: 'user',
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

    const requestMessages = latestRunMessages
      .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
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
      const handleStreamEvent = (event: ChatStreamEvent) => {
        if (event.mode === 'native-session') {
          usedNativeSession = true;
        }
        if (event.type === 'ready' && event.runId) {
          updateActiveRun(activeRunKey, { runId: event.runId });
          updateSelectedPendingStatus('已连接，准备处理中...');
          return;
        }
        if (event.type === 'session-created' && event.sessionId) {
          createdSessionId = event.sessionId;
          const nextRunKey = getActualSessionRunKey(account.provider, event.sessionId, requestSession.projectDirName);
          moveQueuedMessages(activeRunKey, nextRunKey);
          activeRunKey = renameActiveRun(activeRunKey, nextRunKey, {
            provider: account.provider,
            sessionId: event.sessionId,
            projectDirName: requestSession.projectDirName,
            projectPath: requestProjectPath
          });
          resolvedSession = {
            ...requestSession,
            id: event.sessionId,
            draft: false,
            provider: account.provider,
            projectPath: requestProjectPath
          };
          persistRunMessages(resolvedSession);
          updateSelectedPendingStatus(`会话已创建，${getGeneratingStatusText()}`);
          const stillOnDraft = Boolean(selectedSessionRef.current?.draft && selectedSessionRef.current.id === requestSession.id);
          loadProjects(
            stillOnDraft
              ? {
                  sessionId: event.sessionId,
                  projectPath: requestProjectPath,
                  provider: account.provider,
                  projectDirName: requestSession.projectDirName
                }
              : { projectPath: requestProjectPath }
          ).catch(() => {});
          return;
        }
        if (event.type === 'terminal-output' && event.text) {
          updateSelectedPendingStatus(getProcessingStatusText());
          applyRunMessages((next) => {
            const chunk = cleanLiveTerminalChunk(event.text || '');
            if (!chunk) return next;
            return applyStreamingAssistantEvent(next, { ...event, text: chunk }, {
              timestamp: Date.now(),
              provider: requestSession.provider,
              processingStatusText: getProcessingStatusText()
            });
          });
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
            provider: account.provider
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
      loadAccounts().catch(() => {});
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
    if (selectedSession && !selectedSession.draft && (loading || Boolean(watchPendingStatus))) {
      next.add(getActualSessionRunKey(selectedSession.provider, selectedSession.id, selectedSession.projectDirName));
    }
    return next;
  })();

  const currentProjectLabel = selectedProject?.name || '项目会话';
  const currentSessionLabel = selectedSession?.title
    || (selectedProject?.path ? selectedProject.path : '打开项目后即可开始聊天');

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
    />
  );

  const chatContentNode = selectedSession ? (
    <MessageArea
      mobile={isMobile}
      session={selectedSession}
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
      hasMoreHistory={hasMoreHistory}
      images={images}
      onLoadMore={loadMoreHistory}
      onInputChange={setInput}
      onSend={handleSend}
      onStop={handleStop}
      onEditQueuedMessage={handleEditQueuedMessage}
      onRemoveQueuedMessage={handleRemoveQueuedMessage}
      onSendQueuedMessageNow={handleSendQueuedMessageNow}
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
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa', padding: isMobile ? 20 : 32 }}>
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
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa', padding: isMobile ? 20 : 32 }}>
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
    <Layout style={{ height: '100%', background: '#fff', overflow: 'hidden' }}>
      {isMobile ? (
        <>
          <Drawer
            placement="left"
            open={projectDrawerOpen}
            onClose={() => setProjectDrawerOpen(false)}
            width="88vw"
            styles={{
              body: { padding: 0 },
              header: { padding: '14px 16px', borderBottom: '1px solid #f0f0f0' }
            }}
            title="项目与会话"
          >
            {projectListNode}
          </Drawer>

          <div
            style={{
              padding: '10px 12px',
              borderBottom: '1px solid #f0f0f0',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexShrink: 0,
              background: 'rgba(255,255,255,0.96)'
            }}
          >
            <Button
              type="text"
              icon={<MenuOutlined />}
              onClick={() => setProjectDrawerOpen(true)}
              style={{ width: 40, height: 40 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentProjectLabel}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentSessionLabel}
              </div>
            </div>
            <Button
              type="text"
              icon={selectedProject ? <PlusOutlined /> : <FolderOpenOutlined />}
              onClick={selectedProject ? handleCreateSession : () => setMobileProjectPickerOpen(true)}
              style={{ width: 40, height: 40 }}
            />
          </div>
        </>
      ) : (
        <Sider
          width={280}
          theme="light"
          breakpoint="md"
          collapsedWidth={0}
          style={{
            borderRight: '1px solid #e8e8e8',
            height: '100%',
            background: '#f5f5f5'
          }}
        >
          {projectListNode}
        </Sider>
      )}

      <Content style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {chatContentNode}
      </Content>

      {isMobile ? (
        <Drawer
          placement="right"
          width="100vw"
          open={mobileProjectPickerOpen}
          onClose={() => setMobileProjectPickerOpen(false)}
          title="打开项目"
          styles={{
            header: { padding: '16px', borderBottom: '1px solid #f0f0f0' },
            body: { padding: '16px 16px calc(20px + env(safe-area-inset-bottom))' }
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: '100%' }}>
            <Button onClick={handlePickProject} loading={pickingProject} size="large">
              选择文件夹
            </Button>
            <Input
              size="large"
              placeholder="/absolute/path/to/project"
              value={openProjectPath}
              onChange={(e) => setOpenProjectPath(e.target.value)}
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
        <Modal
          title="打开项目"
          open={openProjectVisible}
          onOk={handleOpenProject}
          onCancel={() => setOpenProjectVisible(false)}
          okText="打开"
          cancelText="取消"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Button onClick={handlePickProject} loading={pickingProject}>
              选择文件夹
            </Button>
            <Input
              placeholder="/absolute/path/to/project"
              value={openProjectPath}
              onChange={(e) => setOpenProjectPath(e.target.value)}
            />
            <Input
              placeholder="项目名称（可选）"
              value={openProjectName}
              onChange={(e) => setOpenProjectName(e.target.value)}
            />
          </div>
        </Modal>
      )}
    </Layout>
  );
};

export default Chat;
