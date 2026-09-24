import { useCallback, useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import type { WorkspaceMode } from '@/components/chat/ModeSelector';
import {
  getPinnedSessionIds,
  setPinnedSessionId,
  togglePinnedSessionId,
} from '@/components/chat/pin-session-state';
import { isSessionRunning } from '@/components/chat/project-runtime-state.js';
import { resolveArchiveAction } from '@/components/chat/session-lifecycle-policy.js';
import type { ArchiveActionState } from '@/components/chat/session-lifecycle-policy.js';
import {
  lifecycleErrorMessage,
  useSessionLifecycleCapabilities,
} from '@/components/chat/useSessionLifecycle';
import { crossTabSync } from '@/services/cross-tab-session-sync';
import { sessionsAPI } from '@/services/api';
import type { AggregatedProject, Session } from '@/types';
import { confirmAction } from '@/utils/confirm-action';

interface Options {
  readonly mode: WorkspaceMode;
  readonly selectedSession: Session | null;
  readonly runningSessionKeys: Set<string>;
  /** Work 模式目录刷新（与桌面 ProjectList 的 onRefresh 相同：refreshProjectList） */
  readonly onRefreshDirectory: () => void;
  readonly onCreateSession: () => void;
  readonly onProjectRemoved: (project: AggregatedProject) => void;
}

/**
 * 移动端会话列表的数据与操作：与桌面 ProjectList 使用同一组真实 API
 * （getChatSessions / deleteChatSession / archiveSession / removeProject / lifecycle-capabilities）、
 * 同一份置顶存储（pin-session-state + 跨 Tab SESSION_PINNED）与同样的提示文案。
 * 桌面用 Popconfirm 的地方这里统一用 confirmAction（底部多边形确认框）。
 */
export function useMobileChatSessions({
  mode,
  selectedSession,
  runningSessionKeys,
  onRefreshDirectory,
  onCreateSession,
  onProjectRemoved,
}: Options) {
  const { capabilities } = useSessionLifecycleCapabilities();
  const [chatSessions, setChatSessions] = useState<Session[]>([]);
  const [loadingChatSessions, setLoadingChatSessions] = useState(false);
  const [chatSessionsFailed, setChatSessionsFailed] = useState(false);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(() => getPinnedSessionIds());

  const fetchChatSessions = useCallback(async () => {
    if (mode !== 'chat') return;
    setLoadingChatSessions(true);
    try {
      const list = await sessionsAPI.getChatSessions();
      setChatSessions(Array.isArray(list) ? list : []);
      setChatSessionsFailed(false);
    } catch {
      setChatSessionsFailed(true);
    } finally {
      setLoadingChatSessions(false);
    }
  }, [mode]);

  useEffect(() => {
    if (mode === 'chat') void fetchChatSessions();
  }, [fetchChatSessions, mode]);

  // 运行时在 chat 会话回到 idle 时广播 aih:chat-sessions-changed（SessionWorkspace）。
  useEffect(() => {
    const refresh = () => { void fetchChatSessions(); };
    window.addEventListener('aih:chat-sessions-changed', refresh);
    return () => window.removeEventListener('aih:chat-sessions-changed', refresh);
  }, [fetchChatSessions]);

  // 其他 Tab 的置顶变更：幂等写入并刷新（不回播，避免回环）。
  useEffect(() => crossTabSync.subscribe('SESSION_PINNED', (event) => {
    const sessionId = String(event?.payload?.sessionId || '');
    if (!sessionId) return;
    setPinnedSessionIds(setPinnedSessionId(sessionId, Boolean(event.payload.pinned)));
  }), []);

  const sortedChatSessions = useMemo(() => [...chatSessions].sort((a, b) => {
    const aPinned = pinnedSessionIds.has(a.id);
    const bPinned = pinnedSessionIds.has(b.id);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  }), [chatSessions, pinnedSessionIds]);

  const togglePin = useCallback((sessionId: string) => {
    const next = togglePinnedSessionId(sessionId);
    setPinnedSessionIds(next);
    crossTabSync.broadcast('SESSION_PINNED', { sessionId, pinned: next.has(sessionId) });
  }, []);

  const deleteChatSession = useCallback(async (session: Session) => {
    const ok = await confirmAction({ title: '删除该对话？', okText: '确定', danger: true });
    if (!ok) return;
    try {
      await sessionsAPI.deleteChatSession(session.id);
      message.success('已删除会话');
      void fetchChatSessions();
      if (selectedSession?.id === session.id) onCreateSession();
    } catch {
      message.error('删除会话失败');
    }
  }, [fetchChatSessions, onCreateSession, selectedSession?.id]);

  const archiveAction = useCallback((session: Session): ArchiveActionState => {
    const action = resolveArchiveAction(capabilities, session.provider);
    if (isSessionRunning(session, runningSessionKeys) && action.visible) {
      return { ...action, disabled: true, reason: 'session_lifecycle_active' };
    }
    return action;
  }, [capabilities, runningSessionKeys]);

  const archiveSession = useCallback(async (session: Session) => {
    const ok = await confirmAction({
      title: '归档此会话？',
      content: '将通过 provider 原生协议归档',
      okText: '确定',
    });
    if (!ok) return;
    try {
      await sessionsAPI.archiveSession(session.provider, session.id);
      message.success('已归档');
      onRefreshDirectory();
    } catch (error) {
      message.error(lifecycleErrorMessage(error, '归档失败'));
    }
  }, [onRefreshDirectory]);

  const removeProject = useCallback(async (project: AggregatedProject) => {
    const ok = await confirmAction({
      title: '移除此项目？',
      content: '仅从 Web UI 项目列表中隐藏，不会删除磁盘文件。',
      okText: '确定',
      danger: true,
    });
    if (!ok) return;
    try {
      await sessionsAPI.removeProject(project.path);
      message.success('项目已移除');
      onProjectRemoved(project);
      onRefreshDirectory();
    } catch {
      message.error('移除项目失败');
    }
  }, [onProjectRemoved, onRefreshDirectory]);

  return {
    chatSessions: sortedChatSessions,
    loadingChatSessions,
    chatSessionsFailed,
    fetchChatSessions,
    pinnedSessionIds,
    togglePin,
    deleteChatSession,
    archiveAction,
    archiveSession,
    removeProject,
  };
}

export type MobileChatSessions = ReturnType<typeof useMobileChatSessions>;
