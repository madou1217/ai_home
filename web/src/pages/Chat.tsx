import { useState, useEffect, useRef, useCallback } from 'react';
import { Layout, message, Empty, Button, Modal, Input, Drawer, Grid } from 'antd';
import { chatAPI, accountsAPI, sessionsAPI, isSessionRequestCancelled } from '@/services/api';
import type { ChatMessage, Account, AggregatedProject, Session, ChatStreamEvent, SessionEventItem } from '@/types';
import { ProjectList, MessageArea } from '@/components/chat';
import { providerNames } from '@/components/chat/ProviderIcon';
import { FolderOpenOutlined, PlusOutlined, MenuOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

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

const normalizeMessageText = (value?: string) => String(value || '').trim();

const CHAT_SELECTION_STORAGE_KEY = 'web-chat-selection-v1';

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

const readSelectionFromUrl = (): PersistedChatSelection => {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  return {
    projectPath: params.get('projectPath') || undefined,
    sessionId: params.get('sessionId') || undefined,
    provider: params.get('provider') || undefined,
    projectDirName: params.get('projectDirName') || undefined
  };
};

const readPersistedSelection = (): PersistedChatSelection => {
  if (typeof window === 'undefined') return {};
  const fromUrl = readSelectionFromUrl();
  if (fromUrl.projectPath || fromUrl.sessionId) return fromUrl;
  try {
    const raw = window.localStorage.getItem(CHAT_SELECTION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writePersistedSelection = (selection: PersistedChatSelection) => {
  if (typeof window === 'undefined') return;
  const next: PersistedChatSelection = {
    projectPath: selection.projectPath || undefined,
    sessionId: selection.sessionId || undefined,
    provider: selection.provider || undefined,
    projectDirName: selection.projectDirName || undefined
  };
  const params = new URLSearchParams(window.location.search);
  if (next.projectPath) params.set('projectPath', next.projectPath);
  else params.delete('projectPath');
  if (next.sessionId) params.set('sessionId', next.sessionId);
  else params.delete('sessionId');
  if (next.provider) params.set('provider', next.provider);
  else params.delete('provider');
  if (next.projectDirName) params.set('projectDirName', next.projectDirName);
  else params.delete('projectDirName');
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash || ''}`;
  window.history.replaceState(null, '', nextUrl);
  try {
    if (next.projectPath || next.sessionId) {
      window.localStorage.setItem(CHAT_SELECTION_STORAGE_KEY, JSON.stringify(next));
    } else {
      window.localStorage.removeItem(CHAT_SELECTION_STORAGE_KEY);
    }
  } catch {}
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
  const streamAbortRef = useRef<AbortController | null>(null);
  const sessionMessagesCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  const sessionCursorCacheRef = useRef<Map<string, number>>(new Map());
  const sessionReloadTimersRef = useRef<Map<string, number>>(new Map());
  const sessionWatchRef = useRef<EventSource | null>(null);
  const sessionWatchReconnectTimerRef = useRef<number | null>(null);
  const watchPendingClearTimerRef = useRef<number | null>(null);
  const resumeSyncTimerRef = useRef<number | null>(null);
  const hiddenAtRef = useRef<number>(0);
  const loadingRef = useRef(false);
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

  const appendThinkingChunk = (currentContent: string, thinkingChunk: string) => {
    const safeChunk = String(thinkingChunk || '');
    if (!safeChunk) return currentContent || '';
    const base = String(currentContent || '');
    const marker = '\n:::thinking\n';
    const closeMarker = '\n:::\n';
    const thinkingStart = base.indexOf(marker);
    if (thinkingStart >= 0) {
      const thinkingBodyStart = thinkingStart + marker.length;
      const thinkingEnd = base.indexOf(closeMarker, thinkingBodyStart);
      if (thinkingEnd >= 0) {
        const before = base.slice(0, thinkingBodyStart);
        const currentThinking = base.slice(thinkingBodyStart, thinkingEnd);
        const after = base.slice(thinkingEnd);
        return `${before}${currentThinking}${safeChunk}${after}`;
      }
    }
    return `${base}${base ? '\n' : ''}:::thinking\n${safeChunk}\n:::\n`;
  };

  const stripThinkingBlock = (content: string) => {
    const base = String(content || '');
    return base
      .replace(/\n?:::thinking\n[\s\S]*?\n:::\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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

  const clearWatchPending = useCallback(() => {
    if (watchPendingClearTimerRef.current != null) {
      window.clearTimeout(watchPendingClearTimerRef.current);
      watchPendingClearTimerRef.current = null;
    }
    setWatchPendingStatus(null);
  }, []);

  const markWatchPending = useCallback((session: Session, statusText = 'Codex 正在思考...') => {
    const currentSession = selectedSessionRef.current;
    if (!currentSession || currentSession.id !== session.id) return;
    setWatchPendingStatus(statusText);
    if (watchPendingClearTimerRef.current != null) {
      window.clearTimeout(watchPendingClearTimerRef.current);
    }
    watchPendingClearTimerRef.current = window.setTimeout(() => {
      watchPendingClearTimerRef.current = null;
      setWatchPendingStatus(null);
    }, 4500);
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
    const bundle = await sessionsAPI.getSessionMessagesBundle(
      session.provider,
      session.id,
      session.projectDirName
    );
    const history = bundle.messages;
    sessionMessagesCacheRef.current.set(getSessionCacheKey(session), history);
    sessionCursorCacheRef.current.set(getSessionCacheKey(session), bundle.cursor);
    if (selectedSessionRef.current && selectedSessionRef.current.id === session.id) {
      applySessionHistory(history);
    }
  }, []);

  const applySessionEvents = useCallback((session: Session, events: SessionEventItem[]) => {
    if (!Array.isArray(events) || events.length === 0) return;
    const cacheKey = getSessionCacheKey(session);
    const baseMessages = sessionMessagesCacheRef.current.get(cacheKey) || [];
    const nextMessages = [...baseMessages];

    const appendAssistantText = (text: string, timestamp?: string) => {
      const cleanText = String(text || '').trim();
      if (!cleanText) return;
      const last = nextMessages[nextMessages.length - 1];
      if (!last || last.role !== 'assistant') {
        nextMessages.push({ role: 'assistant', content: cleanText, pending: false, timestamp });
        return;
      }
      nextMessages[nextMessages.length - 1] = {
        ...last,
        content: `${String(last.content || '').trim()}${last.content ? '\n\n' : ''}${cleanText}`,
        pending: false,
        statusText: undefined,
        timestamp: last.timestamp || timestamp
      };
    };

    const appendAssistantThinking = (text: string, timestamp?: string) => {
      const cleanText = String(text || '').trim();
      if (!cleanText) return;
      const last = nextMessages[nextMessages.length - 1];
      if (!last || last.role !== 'assistant') {
        nextMessages.push({
          role: 'assistant',
          content: appendThinkingChunk('', cleanText),
          pending: true,
          statusText: 'Codex 正在思考...',
          timestamp
        });
        return;
      }
      nextMessages[nextMessages.length - 1] = {
        ...last,
        content: appendThinkingChunk(String(last.content || ''), cleanText),
        pending: true,
        statusText: 'Codex 正在思考...',
        timestamp: last.timestamp || timestamp
      };
    };

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
        appendAssistantText(event.text || event.content || '', event.timestamp);
        return;
      }

      if (event.type === 'assistant_reasoning') {
        clearWatchPending();
        appendAssistantThinking(event.text || event.content || '', event.timestamp);
        return;
      }

      if (event.type === 'assistant_tool_call' || event.type === 'assistant_tool_result') {
        clearWatchPending();
        const toolContent = String(event.content || '').trim();
        if (!toolContent) return;
        const last = nextMessages[nextMessages.length - 1];
        if (!last || last.role !== 'assistant') {
          nextMessages.push({
            role: 'assistant',
            content: toolContent,
            pending: false,
            timestamp: event.timestamp
          });
          return;
        }
        const existingContent = String(last.content || '').trim();
        const alreadyIncluded = existingContent.includes(toolContent);
        nextMessages[nextMessages.length - 1] = {
          ...last,
          content: alreadyIncluded
            ? existingContent
            : `${existingContent}${existingContent ? '\n\n' : ''}${toolContent}`,
          pending: false,
          statusText: undefined,
          timestamp: last.timestamp || event.timestamp
        };
      }
    });

    const normalizedMessages = dedupeChatMessages(nextMessages);
    sessionMessagesCacheRef.current.set(cacheKey, normalizedMessages);
    if (selectedSessionRef.current?.id === session.id) {
      applySessionHistory(normalizedMessages);
    }
  }, [clearWatchPending]);

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
          if (session.provider === 'codex') {
            markWatchPending(session);
          }
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

  const handleResumeSync = useCallback(async (reason: 'visible' | 'online' | 'pageshow') => {
    const session = selectedSessionRef.current;
    if (!session) return;

    if (session.draft) {
      if (loadingRef.current && streamAbortRef.current) {
        suppressAbortToastRef.current = true;
        streamAbortRef.current.abort();
      }
      return;
    }

    connectSessionWatch(session);

    const hiddenDurationMs = hiddenAtRef.current > 0 ? Date.now() - hiddenAtRef.current : 0;
    const shouldResetActiveStream = loadingRef.current
      && streamAbortRef.current
      && (reason === 'online' || hiddenDurationMs >= 15000);

    if (shouldResetActiveStream) {
      const activeStream = streamAbortRef.current;
      suppressAbortToastRef.current = true;
      activeStream?.abort();
    }

    try {
      await reloadSessionHistory(session);
      await loadProjects({
        sessionId: session.id,
        projectPath: session.projectPath,
        provider: session.provider,
        projectDirName: session.projectDirName
      });
    } catch {}
  }, [connectSessionWatch, reloadSessionHistory]);

  const loadAccounts = async () => {
    try {
      const data = await accountsAPI.list();
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
    loadProjects({
      sessionId: initialSelection.sessionId,
      projectPath: initialSelection.projectPath,
      provider: initialSelection.provider,
      projectDirName: initialSelection.projectDirName
    });
  }, []);

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
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    return () => {
      clearSessionWatch();
      streamAbortRef.current?.abort();
      sessionReloadTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      sessionReloadTimersRef.current.clear();
      if (resumeSyncTimerRef.current != null) {
        window.clearTimeout(resumeSyncTimerRef.current);
        resumeSyncTimerRef.current = null;
      }
    };
  }, [clearSessionWatch]);

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
  }, [clearSessionWatch, handleResumeSync]);

  const selectedProjectRef = (items: AggregatedProject[], projectPath?: string) =>
    items.find((project) => project.path === projectPath) || null;

  useEffect(() => {
    clearSessionWatch();
    if (!selectedSession) return;
    streamAbortRef.current?.abort();
    if (selectedSession.draft) {
      setMessages([]);
      setAllMessages([]);
      setHasMoreHistory(false);
      setLoading(false);
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
      setLoading(true);
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
      } finally {
        setLoading(false);
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
  }, [clearSessionWatch, connectSessionWatch, selectedSession]);

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

  const handleSend = async () => {
    if (loading) return;
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
    const userMsg: ChatMessage = {
      role: 'user',
      content: input.trim(),
      images: images.slice(),
      timestamp: Date.now()
    };
    const optimisticMessages = [...messages, userMsg];
    const requestMessages = optimisticMessages.map((message) => ({
      role: message.role,
      content: message.content
    }));
    const assistantPlaceholder: ChatMessage = {
      role: 'assistant',
      content: '',
      pending: true,
      statusText: '已发送，正在连接...',
      timestamp: Date.now()
    };
    const newMessages = [...optimisticMessages, assistantPlaceholder];
    setMessages(newMessages);
    if (requestSession && !requestSession.draft) {
      sessionMessagesCacheRef.current.set(getSessionCacheKey(requestSession), newMessages);
    }
    setInput('');
    setImages([]);
    setLoading(true);
    const controller = new AbortController();
    streamAbortRef.current = controller;
    let usedNativeSession = false;

    try {
      let createdSessionId = '';
      const handleStreamEvent = (event: ChatStreamEvent) => {
        if (event.mode === 'native-session') {
          usedNativeSession = true;
        }
        if (event.type === 'ready' && event.runId) {
          updatePendingAssistantStatus('已连接，准备处理中...');
          return;
        }
        if (event.type === 'session-created' && event.sessionId) {
          createdSessionId = event.sessionId;
          updatePendingAssistantStatus('会话已创建，正在生成回复...');
          return;
        }
        if (event.type === 'terminal-output' && event.text) {
          setMessages((current) => {
            const next = current.slice();
            const chunk = cleanLiveTerminalChunk(event.text || '');
            if (!chunk) return next;
            const last = next[next.length - 1];
            if (!last || last.role !== 'assistant') {
              next.push({ role: 'assistant', content: chunk, pending: false, timestamp: Date.now() });
              return next;
            }
            next[next.length - 1] = {
              ...last,
              content: `${last.content || ''}${chunk}`,
              pending: false,
              timestamp: last.timestamp || Date.now()
            };
            if (requestSession && !requestSession.draft) {
              sessionMessagesCacheRef.current.set(getSessionCacheKey(requestSession), next);
            }
            return next;
          });
          return;
        }
        if (event.type === 'thinking' && event.thinking) {
          updatePendingAssistantStatus('Codex 正在思考...');
          setMessages((current) => {
            const next = current.slice();
            const thinkingChunk = event.thinking || '';
            const last = next[next.length - 1];
            if (!last || last.role !== 'assistant') {
              next.push({
                role: 'assistant',
                content: appendThinkingChunk('', thinkingChunk),
                pending: true,
                statusText: 'Codex 正在思考...',
                timestamp: Date.now()
              });
              return next;
            }
            next[next.length - 1] = {
              ...last,
              content: appendThinkingChunk(last.content || '', thinkingChunk),
              pending: true,
              statusText: 'Codex 正在思考...',
              timestamp: last.timestamp || Date.now()
            };
            if (requestSession && !requestSession.draft) {
              sessionMessagesCacheRef.current.set(getSessionCacheKey(requestSession), next);
            }
            return next;
          });
          return;
        }
        if (event.type === 'delta') {
          updatePendingAssistantStatus('正在生成回复...');
          setMessages((current) => {
            const next = current.slice();
            const last = next[next.length - 1];
            if (!last || last.role !== 'assistant') {
              next.push({ role: 'assistant', content: event.delta || '', pending: false, timestamp: Date.now() });
              return next;
            }
            const baseContent = last.pending
              ? stripThinkingBlock(last.content || '')
              : String(last.content || '');
            next[next.length - 1] = {
              ...last,
              content: `${baseContent}${baseContent ? '\n\n' : ''}${event.delta || ''}`.trim(),
              pending: false,
              timestamp: last.timestamp || Date.now()
            };
            if (requestSession && !requestSession.draft) {
              sessionMessagesCacheRef.current.set(getSessionCacheKey(requestSession), next);
            }
            return next;
          });
          return;
        }

        if (event.type === 'result' || event.type === 'done') {
          if (typeof event.content === 'string' && event.content) {
            const finalContent = event.content;
            setMessages((current) => {
              const next = current.slice();
              const last = next[next.length - 1];
              if (!last || last.role !== 'assistant') {
                next.push({ role: 'assistant', content: finalContent, pending: false, timestamp: Date.now() });
                return next;
              }
              next[next.length - 1] = {
                ...last,
                content: finalContent,
                pending: false,
                timestamp: last.timestamp || Date.now()
              };
              if (requestSession && !requestSession.draft) {
                sessionMessagesCacheRef.current.set(getSessionCacheKey(requestSession), next);
              }
              return next;
            });
          }
        }
      };

      await chatAPI.sendStream({
        messages: requestMessages,
        prompt: userMsg.content,
        provider: selectedAccount.provider,
        accountId: selectedAccount.accountId,
        createSession: Boolean(requestSession.draft),
        sessionId: requestSession.draft ? undefined : requestSession.id,
        projectDirName: requestSession.draft ? undefined : requestSession.projectDirName,
        projectPath: requestProjectPath,
        model: selectedModel || undefined,
        images,
        stream: true
      }, {
        signal: controller.signal,
        onEvent: handleStreamEvent
      });
      if (requestSession.draft) {
        if (createdSessionId) {
          await loadProjects({
            sessionId: createdSessionId,
            projectPath: requestProjectPath,
            provider: selectedAccount.provider
          });
        } else if (usedNativeSession) {
          await loadProjects({
            projectPath: requestProjectPath
          });
        }
      } else {
        if (usedNativeSession) {
          await reloadSessionHistory(requestSession);
        }
      }
    } catch (err: any) {
      dropPendingAssistantPlaceholder();
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
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      setLoading(false);
      loadAccounts().catch(() => {});
    }
  };

  const handleStop = () => {
    streamAbortRef.current?.abort();
    dropPendingAssistantPlaceholder();
  };

  const toggleProject = (id: string) => {
    const next = new Set(expandedProjects);
    next.has(id) ? next.delete(id) : next.add(id);
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

  const currentProjectLabel = selectedProject?.name || '项目会话';
  const currentSessionLabel = selectedSession?.title
    || (selectedProject?.path ? selectedProject.path : '打开项目后即可开始聊天');

  const projectListNode = (
    <ProjectList
      mobile={isMobile}
      projects={displayProjects}
      loading={loadingProjects}
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
      externalPending={Boolean(!loading && watchPendingStatus && selectedSession?.provider === 'codex')}
      externalPendingStatusText={watchPendingStatus || undefined}
      hasMoreHistory={hasMoreHistory}
      images={images}
      onLoadMore={loadMoreHistory}
      onInputChange={setInput}
      onSend={handleSend}
      onStop={handleStop}
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
