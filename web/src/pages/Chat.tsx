import { useCallback, useEffect, useRef, useState } from 'react';
import { Grid, message } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { ProjectList } from '@/components/chat';
import GlobalCommandPalette from '@/components/chat/GlobalCommandPalette';
import KeyboardShortcutsModal from '@/components/chat/KeyboardShortcutsModal';
import type { WorkspaceMode } from '@/components/chat/ModeSelector';
import ChatEmptyState from '@/components/chat/ChatEmptyState';
import { isSessionRunning } from '@/components/chat/project-runtime-state.js';
import type { AggregatedProject, Session } from '@/types';
import {
  CanonicalChatRuntime,
  resolveCanonicalSessionDirectoryFocus,
  useCanonicalSessionDirectory,
  useCanonicalSessionRestore,
  useSessionApprovalMode,
} from '@/features/chat-runtime';
import ChatRuntimeBoundary from '@/features/chat-runtime/ChatRuntimeBoundary';
import ChatWorkspaceLayout from '@/features/legacy-chat/ChatWorkspaceLayout';
import ProjectWorkbench from '@/features/project-workbench/ProjectWorkbench';
import LegacyChatRuntime from '@/features/legacy-chat/LegacyChatRuntime';
import { useChatAccountCatalog } from '@/features/legacy-chat/use-chat-account-catalog';
import { useProjectDialogs } from '@/features/legacy-chat/use-project-dialogs';
import { useProjectCatalog } from '@/features/legacy-chat/use-project-catalog';
import type { PersistedChatSelection } from '@/features/legacy-chat/runtime-types';
import {
  readPersistedSelection,
} from './chat-selection-state.js';
import {
  mergeRunningSessionKeys,
  useMobileChatNavigation,
  useMobileImmersiveMode,
  usePersistedChatSelection,
} from './chat-page-hooks';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const STORAGE_KEY_CHAT_MODE = 'aih_chat_workspace_mode';

export default function Chat() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setShortcutsModalOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const screens = Grid.useBreakpoint();
  const mobile = !screens.md;
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
  const canonicalDirectory = useCanonicalSessionDirectory(
    projectCatalog.displayProjects,
    resolveCanonicalSessionDirectoryFocus(projectCatalog.selectedSession, {
      provider: initialSelectionRef.current.provider,
      projectPath: initialSelectionRef.current.projectPath,
      nativeSessionId: initialSelectionRef.current.sessionId,
    }),
  );
  const accountCatalog = useChatAccountCatalog(projectCatalog.selectedSession?.provider);
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
  useEffect(() => {
    if (!mobile) return;
    if (!projectCatalog.selectedProject && !projectCatalog.selectedSession) {
      setMobileShowChat(false);
    }
  }, [mobile, projectCatalog.projects.length, projectCatalog.selectedProject, projectCatalog.selectedSession]);

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

  const projectList = (
    <ProjectList
      mobile={mobile}
      projects={canonicalDirectory.projects}
      loading={projectCatalog.loadingProjects}
      hydratingProjectPaths={projectCatalog.hydratingProjectPaths}
      runningSessionKeys={runningSessionKeys}
      selectedSession={projectCatalog.selectedSession}
      selectedProject={projectCatalog.selectedProject}
      expandedProjects={projectCatalog.expandedProjects}
      mode={workspaceMode}
      onModeChange={handleModeChange}
      onRefresh={refreshProjectList}
      onToggleProject={projectCatalog.toggleProject}
      onSelectProject={handleSelectProject}
      onSelectSession={handleSelectSession}
      onOpenProject={dialogs.openProject}
      onCreateSession={handleCreateSession}
      onProjectRemoved={handleProjectRemoved}
      remoteSessionsPanel={null}
    />
  );

  const runtimeContent = (
    <ChatRuntimeBoundary
      session={projectCatalog.selectedSession}
      account={accountCatalog.selectedAccount}
      canonical={(session) => (
        <CanonicalChatRuntime
          session={session}
          projectPath={projectCatalog.selectedProject?.path}
          account={accountCatalog.selectedAccount}
          accounts={accountCatalog.accounts}
          title={session.title || projectLabel}
          mobile={mobile}
          selectedModel={selectedModel}
          approvalMode={approvalMode.mode}
          approvalModeReady={approvalMode.ready}
          onAccountChange={accountCatalog.setSelectedAccount}
          onModelChange={setSelectedModel}
          onApprovalModeChange={approvalMode.change}
          onSessionChange={projectCatalog.setSelectedSession}
          onProjectsRefresh={refreshSessionDirectory}
        />
      )}
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
  const chatContent = workspaceMode === 'chat' ? (
    runtimeContent
  ) : (
    <ProjectWorkbench
      projectPath={projectCatalog.selectedProject?.path}
      mobile={mobile}
      chat={runtimeContent}
    />
  );
  const navigation = useMobileChatNavigation(setMobileShowChat);

  return (
    <>
      <GlobalCommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onSelectModel={setSelectedModel}
      />
      <KeyboardShortcutsModal
        open={shortcutsModalOpen}
        onClose={() => setShortcutsModalOpen(false)}
      />
      <ChatWorkspaceLayout
      mobile={mobile}
      mobileShowChat={mobileShowChat}
      selectedSession={projectCatalog.selectedSession}
      sessionRunning={selectedSessionRunning}
      projectLabel={projectLabel}
      projectList={projectList}
      chatContent={chatContent}
      dialogs={dialogs.node}
      onBack={navigation.back}
      onCreateSession={handleCreateSession}
      onTouchStart={navigation.touchStart}
      onTouchEnd={navigation.touchEnd}
    />
    </>
  );
}
