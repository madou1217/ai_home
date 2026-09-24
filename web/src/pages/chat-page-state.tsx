import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import type { WorkspaceMode } from '@/components/chat/ModeSelector';
import ChatEmptyState from '@/components/chat/ChatEmptyState';
import { isSessionRunning } from '@/components/chat/project-runtime-state.js';
import type { AggregatedProject, Session } from '@/types';
import { sessionsAPI } from '@/services/api';
import {
  CanonicalChatRuntime,
  resolveCanonicalSessionDirectoryFocus,
  useCanonicalSessionDirectory,
  useCanonicalSessionRestore,
  useSessionApprovalMode,
} from '@/features/chat-runtime';
import ChatRuntimeBoundary from '@/features/chat-runtime/ChatRuntimeBoundary';
import ProjectWorkbench from '@/features/project-workbench/ProjectWorkbench';
import { resolveWorkbenchSessions } from '@/features/project-workbench/workbench-sessions';
import LegacyChatRuntime from '@/features/legacy-chat/LegacyChatRuntime';
import { useChatAccountCatalog } from '@/features/legacy-chat/use-chat-account-catalog';
import { useProjectDialogs } from '@/features/legacy-chat/use-project-dialogs';
import { useProjectCatalog } from '@/features/legacy-chat/use-project-catalog';
import type { PersistedChatSelection } from '@/features/legacy-chat/runtime-types';
import {
  readPersistedSelection,
} from './chat-selection-state.js';
import { shouldMobileDeepLinkEnterChat } from './chat-mobile-deeplink';
import {
  mergeRunningSessionKeys,
  useChatSessionRestore,
  useMobileChatNavigation,
  useMobileImmersiveMode,
  usePersistedChatSelection,
} from './chat-page-hooks';

const STORAGE_KEY_CHAT_MODE = 'aih_chat_workspace_mode';

/**
 * AI 会话页的页面级状态（项目/会话目录、账号、模型、审批模式、移动端两屏导航与全部处理函数）。
 * 桌面 Chat.tsx 与移动端 MobileChat 共用同一份逻辑；`mobile` 只影响原有的移动端分支
 * （进入对话屏、沉浸态、深链直达），桌面传入的值与原先一致。
 */
export function useChatPageState(mobile: boolean) {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => {
    if (typeof window !== 'undefined') {
      return (window.localStorage.getItem(STORAGE_KEY_CHAT_MODE) as WorkspaceMode) || 'chat';
    }
    return 'chat';
  });

  const handleModeChange = useCallback((newMode: WorkspaceMode) => {
    setWorkspaceMode(newMode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY_CHAT_MODE, newMode);
    }
  }, []);

  const initialSelectionRef = useRef<PersistedChatSelection>(readPersistedSelection());
  const projectCatalog = useProjectCatalog(initialSelectionRef.current);
  useEffect(() => {
    if (projectCatalog.selectedSession) {
      handleModeChange(projectCatalog.selectedSession.mode || 'work');
    }
  }, [projectCatalog.selectedSession?.id, projectCatalog.selectedSession?.mode, handleModeChange]);
  const canonicalDirectory = useCanonicalSessionDirectory(
    projectCatalog.displayProjects,
    resolveCanonicalSessionDirectoryFocus(projectCatalog.selectedSession, {
      provider: initialSelectionRef.current.provider,
      projectPath: initialSelectionRef.current.projectPath,
      nativeSessionId: initialSelectionRef.current.sessionId,
    }),
    undefined,
    { catalogLoading: projectCatalog.loadingProjects },
  );
  const accountCatalog = useChatAccountCatalog(
    projectCatalog.selectedSession?.provider,
    projectCatalog.selectedSession?.accountRef,
  );
  const [selectedModel, setSelectedModel] = useState('');
  const [legacyRunningSessionKeys, setLegacyRunningSessionKeys] = useState<Set<string>>(new Set());
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const cancelCanonicalRestore = useCanonicalSessionRestore({
    initialSelection: initialSelectionRef.current,
    ready: canonicalDirectory.ready,
    directoryProjects: canonicalDirectory.projects,
    catalogProjects: projectCatalog.projects,
    selectedSession: projectCatalog.selectedSession,
    setSelectedProject: projectCatalog.setSelectedProject,
    setSelectedSession: projectCatalog.setSelectedSession,
    setExpandedProjects: projectCatalog.setExpandedProjects,
  });
  const dialogs = useProjectDialogs({
    mobile,
    loadProjects: projectCatalog.loadProjects,
    setExpandedProjects: projectCatalog.setExpandedProjects,
    setSelectedSession: projectCatalog.setSelectedSession,
    setMobileShowChat,
    onSelectionMutation: cancelCanonicalRestore,
  });
  const approvalMode = useSessionApprovalMode(projectCatalog.selectedSession);
  const refreshSessionDirectory = useCallback(async (
    selection: PersistedChatSelection = {},
  ): Promise<void> => {
    await Promise.all([
      projectCatalog.loadProjects(selection),
      canonicalDirectory.refresh(),
    ]);
  }, [canonicalDirectory.refresh, projectCatalog.loadProjects]);
  const refreshProjectList = useCallback((): void => {
    void refreshSessionDirectory();
  }, [refreshSessionDirectory]);

  useMobileImmersiveMode(mobile, mobileShowChat);
  usePersistedChatSelection(projectCatalog.selectedProject, projectCatalog.selectedSession, workspaceMode === 'chat');
  // chat 模式会话(无 projectPath)不在 canonical/project 目录里,需单独从 chat-sessions 恢复
  useChatSessionRestore({
    initialSelection: initialSelectionRef.current,
    selectedSession: projectCatalog.selectedSession,
    setSelectedSession: projectCatalog.setSelectedSession,
  });
  useEffect(() => {
    if (!mobile) return;
    if (!projectCatalog.selectedProject && !projectCatalog.selectedSession) {
      setMobileShowChat(false);
    }
  }, [mobile, projectCatalog.projects.length, projectCatalog.selectedProject, projectCatalog.selectedSession]);

  // 移动端深链直达：URL/持久化恢复的会话不经过 handleSelectSession，
  // mobileShowChat 停在 false 会一直停在列表屏，恢复命中后补一次进详情屏。
  const mobileDeepLinkRef = useRef(false);
  useEffect(() => {
    if (!mobile || mobileDeepLinkRef.current) return;
    if (!shouldMobileDeepLinkEnterChat(initialSelectionRef.current, projectCatalog.selectedSession)) return;
    mobileDeepLinkRef.current = true;
    setMobileShowChat(true);
  }, [mobile, projectCatalog.selectedSession]);

  const handleLegacyRunningSessionKeysChange = useCallback((keys: Set<string>): void => {
    setLegacyRunningSessionKeys(keys);
  }, []);
  const handleSelectProject = useCallback((project: AggregatedProject): void => {
    cancelCanonicalRestore();
    projectCatalog.setSelectedProject(project);
    projectCatalog.hydrateProjectSessions(project.path, { projectPath: project.path }).catch(() => {});
    if (projectCatalog.selectedSession?.projectPath !== project.path) {
      projectCatalog.setSelectedSession(null);
    }
  }, [cancelCanonicalRestore, projectCatalog]);
  const handleSelectSession = useCallback((session: Session): void => {
    cancelCanonicalRestore();
    projectCatalog.setSelectedSession(session);
    const owner = projectCatalog.projects.find((project) => project.path === session.projectPath);
    if (owner) {
      projectCatalog.setSelectedProject(owner);
      projectCatalog.setExpandedProjects((current) => new Set([...current, owner.id]));
    }
    if (mobile) setMobileShowChat(true);
  }, [cancelCanonicalRestore, mobile, projectCatalog]);

  const handleCreateSession = useCallback((): void => {
    const account = accountCatalog.selectedAccount || accountCatalog.accounts[0] || null;
    cancelCanonicalRestore();
    if (!account) {
      if (accountCatalog.loadFailed) {
        message.error('远端账号尚未加载成功（连接异常），请点刷新重试，不是缺少账号配置');
      } else {
        message.warning('请先配置可用账号');
      }
      return;
    }

    if (workspaceMode === 'chat') {
      // 纯聊天模式：不需要 projectPath
      projectCatalog.setSelectedSession({
        id: `draft-${Date.now()}`,
        title: '新对话',
        updatedAt: Date.now(),
        provider: account.provider,
        draft: true,
        mode: 'chat',
      });
      accountCatalog.setSelectedAccount(account);
      if (mobile) setMobileShowChat(true);
      return;
    }

    // Work 模式：需要选择工作区项目
    const project = projectCatalog.selectedProject;
    if (!project) {
      message.warning('请先选择一个项目');
      return;
    }

    projectCatalog.setSelectedSession({
      id: `draft-${Date.now()}`,
      title: '新会话',
      updatedAt: Date.now(),
      provider: account.provider,
      projectPath: project.path,
      draft: true,
      mode: 'work',
    });
    accountCatalog.setSelectedAccount(account);
    if (mobile) setMobileShowChat(true);
  }, [accountCatalog, cancelCanonicalRestore, mobile, projectCatalog, workspaceMode]);

  const handleForkSession = useCallback(async (messageIndex: number) => {
    if (!projectCatalog.selectedSession) return;
    try {
      const current = projectCatalog.selectedSession;
      const originalMessages = (await sessionsAPI.getSessionMessages(current.provider, current.id)) || [];
      const branchMessages = originalMessages.slice(0, messageIndex + 1);

      const newSessionId = `chat-branch-${Date.now()}`;
      const forkedSession = {
        id: newSessionId,
        title: `${current.title || '会话'} (分支)`,
        provider: current.provider,
        model: selectedModel || current.model,
        mode: workspaceMode,
        projectPath: current.projectPath,
        updatedAt: Date.now(),
        messages: branchMessages,
      };

      projectCatalog.setSelectedSession(forkedSession as any);
      message.success('已从此消息成功派生新分支会话！');
    } catch {
      message.error('分支派生失败');
    }
  }, [projectCatalog, selectedModel, workspaceMode]);

  const handleProjectRemoved = useCallback((project: AggregatedProject): void => {
    cancelCanonicalRestore();
    if (projectCatalog.selectedProject?.path === project.path) {
      projectCatalog.setSelectedProject(null);
    }
    if (projectCatalog.selectedSession?.projectPath === project.path) {
      projectCatalog.setSelectedSession(null);
    }
  }, [cancelCanonicalRestore, projectCatalog]);

  const runningSessionKeys = mergeRunningSessionKeys(
    legacyRunningSessionKeys,
    projectCatalog.passiveRunningSessionKeys,
  );
  const selectedSessionRunning = projectCatalog.selectedSession
    ? isSessionRunning(projectCatalog.selectedSession, runningSessionKeys)
    : false;
  const projectLabel = projectCatalog.selectedSession?.mode === 'chat'
    ? 'AI 纯聊天'
    : (projectCatalog.selectedProject?.name || '项目会话');
  const navigation = useMobileChatNavigation(setMobileShowChat);

  return {
    mobile,
    workspaceMode,
    handleModeChange,
    projectCatalog,
    canonicalDirectory,
    accountCatalog,
    selectedModel,
    setSelectedModel,
    mobileShowChat,
    setMobileShowChat,
    dialogs,
    approvalMode,
    refreshSessionDirectory,
    refreshProjectList,
    handleLegacyRunningSessionKeysChange,
    handleSelectProject,
    handleSelectSession,
    handleCreateSession,
    handleForkSession,
    handleProjectRemoved,
    runningSessionKeys,
    selectedSessionRunning,
    projectLabel,
    navigation,
  };
}

export type ChatPageState = ReturnType<typeof useChatPageState>;

/**
 * 对话运行时区域：ChatRuntimeBoundary 按会话选择 canonical / legacy / 空状态，
 * Work 模式外包 ProjectWorkbench（文件 / 终端 / Review 面板）。
 * `canonicalFrameClassName` 仅供移动端给 canonical 运行时补安全区外框；桌面不传，DOM 与原先一致。
 */
export function ChatConversationContent({
  state,
  canonicalFrameClassName,
}: {
  state: ChatPageState;
  canonicalFrameClassName?: string;
}) {
  const {
    mobile,
    workspaceMode,
    projectCatalog,
    canonicalDirectory,
    accountCatalog,
    selectedModel,
    setSelectedModel,
    dialogs,
    approvalMode,
    refreshSessionDirectory,
    handleLegacyRunningSessionKeysChange,
    handleSelectSession,
    handleCreateSession,
    handleForkSession,
    runningSessionKeys,
    projectLabel,
  } = state;

  const runtimeContent = (
    <ChatRuntimeBoundary
      session={projectCatalog.selectedSession}
      account={accountCatalog.selectedAccount}
      canonical={(session) => {
        const canonical = (
          <CanonicalChatRuntime
            session={session}
            projectPath={session.mode === 'chat' ? undefined : projectCatalog.selectedProject?.path}
            account={accountCatalog.selectedAccount}
            accounts={accountCatalog.accounts}
            title={session.title || projectLabel}
            mobile={mobile}
            selectedModel={selectedModel}
            approvalMode={approvalMode.mode}
            approvalModeReady={approvalMode.ready}
            onAccountChange={(account) => {
              if (session.mode === 'chat' && session.accountRef === account.accountRef) return;
              accountCatalog.setSelectedAccount(account);
              if (session.mode === 'chat') {
                projectCatalog.setSelectedSession({
                  id: `draft-${Date.now()}`, title: '新对话', updatedAt: Date.now(),
                  provider: account.provider, draft: true, mode: 'chat',
                });
                setSelectedModel('');
              }
            }}
            onModelChange={setSelectedModel}
            onApprovalModeChange={approvalMode.change}
            onSessionChange={projectCatalog.setSelectedSession}
            onProjectsRefresh={refreshSessionDirectory}
          />
        );
        return canonicalFrameClassName
          ? <div className={canonicalFrameClassName}>{canonical}</div>
          : canonical;
      }}
      legacy={(session) => (
        <LegacyChatRuntime
          mobile={mobile}
          selection={{
            session,
            sessionRef: projectCatalog.selectedSessionRef,
            project: projectCatalog.selectedProject,
            account: accountCatalog.selectedAccount,
            model: selectedModel,
            approvalMode: approvalMode.mode,
            changeSession: projectCatalog.setSelectedSession,
            changeProject: projectCatalog.setSelectedProject,
            changeAccount: accountCatalog.setSelectedAccount,
            changeModel: setSelectedModel,
            changeApprovalMode: approvalMode.change,
          }}
          catalog={{
            projects: projectCatalog.projects,
            accounts: accountCatalog.accounts,
            accountsRef: accountCatalog.accountsRef,
            findProjectByPath: projectCatalog.findProjectByPath,
            refreshProjects: projectCatalog.loadProjects,
            pauseProjectWatch: projectCatalog.pauseProjectWatch,
            resumeProjectWatch: projectCatalog.resumeProjectWatch,
            selectAccountForProvider: accountCatalog.selectAccountForProvider,
          }}
          onRunningSessionKeysChange={handleLegacyRunningSessionKeysChange}
          // 原样搬自 Chat.tsx：LegacyChatRuntime 的 props 尚未声明/转发 onForkSession（既有问题，
          // 运行时该属性被忽略）。此处不改运行时行为，只保留原有接线并显式标注类型缺口。
          // @ts-expect-error LegacyChatRuntimeProps 未声明 onForkSession
          onForkSession={handleForkSession}
        />
      )}
      empty={() => (
        <ChatEmptyState
          mode={workspaceMode}
          projectPath={projectCatalog.selectedProject?.path}
          mobile={mobile}
          onCreateSession={handleCreateSession}
          onOpenProject={dialogs.openProject}
        />
      )}
    />
  );

  // 在纯聊天模式下，直接展示对话面板，无需 ProjectWorkbench 工作区标签页
  return workspaceMode === 'chat' ? (
    runtimeContent
  ) : (
    <ProjectWorkbench
      projectPath={projectCatalog.selectedProject?.path}
      mobile={mobile}
      chat={runtimeContent}
      sessions={resolveWorkbenchSessions(
        canonicalDirectory.projects,
        projectCatalog.selectedProject?.path,
      )}
      selectedSession={projectCatalog.selectedSession}
      runningSessionKeys={runningSessionKeys}
      onSelectSession={handleSelectSession}
    />
  );
}
