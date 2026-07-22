import { useCallback, useEffect, useRef, useState } from 'react';
import { Grid, message } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { ProjectList } from '@/components/chat';
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

export default function Chat() {
  const screens = Grid.useBreakpoint();
  const mobile = !screens.md;
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
  usePersistedChatSelection(projectCatalog.selectedProject, projectCatalog.selectedSession);
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
    const project = projectCatalog.selectedProject;
    const account = accountCatalog.selectedAccount || accountCatalog.accounts[0] || null;
    if (!project) {
      message.warning('请先选择一个项目');
      return;
    }
    cancelCanonicalRestore();
    if (!account) {
      if (accountCatalog.loadFailed) {
        message.error('远端账号尚未加载成功（连接异常），请点刷新重试，不是缺少账号配置');
      } else {
        message.warning('请先配置可用账号');
      }
      return;
    }
    projectCatalog.setSelectedSession({
      id: `draft-${Date.now()}`,
      title: '新会话',
      updatedAt: Date.now(),
      provider: account.provider,
      projectPath: project.path,
      draft: true,
    });
    accountCatalog.setSelectedAccount(account);
    if (mobile) setMobileShowChat(true);
  }, [accountCatalog, cancelCanonicalRestore, mobile, projectCatalog]);
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
  const projectLabel = projectCatalog.selectedProject?.name || '项目会话';
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
  const chatContent = (
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
        />
      )}
      empty={() => (
        <ChatEmptyState
          projectPath={projectCatalog.selectedProject?.path}
          mobile={mobile}
          onCreateSession={handleCreateSession}
          onOpenProject={dialogs.openProject}
        />
      )}
    />
  );
  const navigation = useMobileChatNavigation(setMobileShowChat);

  return (
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
  );
}
