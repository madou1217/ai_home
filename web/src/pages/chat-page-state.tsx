import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import type { WorkspaceMode } from '@/components/chat/ModeSelector';
import ChatEmptyState from '@/components/chat/ChatEmptyState';
import { isSessionRunning } from '@/components/chat/project-runtime-state.js';
import { isSharedNativeSession } from '@/components/chat/session-provider-policy.js';
import type { AggregatedProject, Session } from '@/types';
import {
  CanonicalChatRuntime,
  resolveCanonicalSessionDirectoryFocus,
  resolveChatAccountChange,
  useCanonicalSessionDirectory,
  useCanonicalSessionRestore,
  useSessionApprovalMode,
} from '@/features/chat-runtime';
import ChatRuntimeBoundary from '@/features/chat-runtime/ChatRuntimeBoundary';
import ProjectWorkbench from '@/features/project-workbench/ProjectWorkbench';
import type { WorkbenchWorkspaceDescriptor } from '@/features/project-workbench/workbench-types';
import { resolveActiveServer } from '@/services/webui-auth-transport';
import { resolveWorkbenchSessions } from '@/features/project-workbench/workbench-sessions';
import ChatRuntimeFallback from '@/features/chat-runtime/ChatRuntimeFallback';
import { useChatAccountCatalog } from '@/features/chat-workspace/use-chat-account-catalog';
import { chatAccountIdentity } from '@/components/chat/aih-server-account';
import { useProjectDialogs } from '@/features/chat-workspace/use-project-dialogs';
import { useProjectCatalog } from '@/features/chat-workspace/use-project-catalog';
import type { PersistedChatSelection } from '@/features/chat-workspace/runtime-types';
import { carryComposerDraftToNextSession } from '@/features/chat-runtime/composer-draft-store';
import {
  readPersistedSelection,
} from './chat-selection-state.js';
import { shouldMobileDeepLinkEnterChat } from './chat-mobile-deeplink';
import {
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
export function useChatPageState(
  mobile: boolean,
  launchMode?: WorkspaceMode,
  options: { readonly urlSelectionOnly?: boolean } = {},
) {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => {
    // 快捷唤起指定了模式：本次打开用它，但不写回偏好（不改用户在主窗口的习惯）。
    if (launchMode) return launchMode;
    if (typeof window !== 'undefined') {
      // 深链带 projectPath（如 SSH 开发机「在 Work 中打开」）：直接进 Work。
      if (new URLSearchParams(window.location.search).get('projectPath')) return 'work';
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

  // 快捷窗口只认 URL 里显式指定的会话：不继承主窗口上次停留的会话（那可能是别的工作区里正在跑的长会话）。
  const initialSelectionRef = useRef<PersistedChatSelection>(
    options.urlSelectionOnly ? readUrlSelection() : readPersistedSelection(),
  );
  const projectCatalog = useProjectCatalog(initialSelectionRef.current);
  useEffect(() => {
    if (projectCatalog.selectedSession) {
      handleModeChange(projectCatalog.selectedSession.projectPath ? 'work' : 'chat');
    }
  }, [projectCatalog.selectedSession?.id, projectCatalog.selectedSession?.projectPath, handleModeChange]);
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
    isSharedNativeSession(projectCatalog.selectedSession),
  );
  const [selectedModel, setSelectedModel] = useState('');
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
  // 远程工作区「在 Work 中打开」：它在项目目录里以影子目录为路径，按该路径刷新并选中。
  const handleOpenRemoteWorkspace = useCallback(async (workspace: { projectPath?: string }): Promise<void> => {
    const projectPath = String(workspace.projectPath || '');
    if (!projectPath) return;
    handleModeChange('work');
    const existing = projectCatalog.projects.find((project) => project.path === projectPath);
    if (existing) {
      projectCatalog.setSelectedProject(existing);
      projectCatalog.setExpandedProjects((current) => new Set([...current, existing.id]));
      return;
    }
    await refreshSessionDirectory({ projectPath });
  }, [handleModeChange, projectCatalog, refreshSessionDirectory]);

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
    });
    accountCatalog.setSelectedAccount(account);
    if (mobile) setMobileShowChat(true);
  }, [accountCatalog, cancelCanonicalRestore, mobile, projectCatalog, workspaceMode]);

  const handleProjectRemoved = useCallback((project: AggregatedProject): void => {
    cancelCanonicalRestore();
    if (projectCatalog.selectedProject?.path === project.path) {
      projectCatalog.setSelectedProject(null);
    }
    if (projectCatalog.selectedSession?.projectPath === project.path) {
      projectCatalog.setSelectedSession(null);
    }
  }, [cancelCanonicalRestore, projectCatalog]);

  const runningSessionKeys = projectCatalog.passiveRunningSessionKeys;
  const selectedSessionRunning = projectCatalog.selectedSession
    ? isSessionRunning(projectCatalog.selectedSession, runningSessionKeys)
    : false;
  const projectLabel = projectCatalog.selectedSession && !projectCatalog.selectedSession.projectPath
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
    handleOpenRemoteWorkspace,
    handleSelectProject,
    handleSelectSession,
    handleCreateSession,
    handleProjectRemoved,
    runningSessionKeys,
    selectedSessionRunning,
    projectLabel,
    navigation,
  };
}

export type ChatPageState = ReturnType<typeof useChatPageState>;

function readUrlSelection(): PersistedChatSelection {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const selection: PersistedChatSelection = {
    ...(params.get('projectPath') ? { projectPath: params.get('projectPath') || undefined } : {}),
    ...(params.get('sessionId') ? { sessionId: params.get('sessionId') || undefined } : {}),
    ...(params.get('provider') ? { provider: params.get('provider') || undefined } : {}),
    ...(params.get('projectDirName') ? { projectDirName: params.get('projectDirName') || undefined } : {}),
  };
  return selection;
}

/**
 * 对话运行时区域：ChatRuntimeBoundary 按会话选择 canonical / legacy / 空状态，
 * Work 模式外包 ProjectWorkbench（文件 / 终端 / Review 面板）。
 * `canonicalFrameClassName` 仅供移动端给 canonical 运行时补安全区外框；桌面不传，DOM 与原先一致。
 */
export function ChatConversationContent({
  state,
  canonicalFrameClassName,
  workbench = true,
}: {
  state: ChatPageState;
  canonicalFrameClassName?: string;
  /** work 模式是否外包项目工作台（文件 / Review）。快捷窗口窄宽度下关掉，只留会话。 */
  workbench?: boolean;
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
    handleSelectSession,
    handleCreateSession,
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
            projectPath={!session.projectPath ? undefined : projectCatalog.selectedProject?.path}
            account={accountCatalog.selectedAccount}
            accounts={accountCatalog.accounts}
            title={session.title || projectLabel}
            mobile={mobile}
            selectedModel={selectedModel}
            approvalMode={approvalMode.mode}
            approvalModeReady={approvalMode.ready}
            onAccountChange={(account) => {
              const action = resolveChatAccountChange({
                projectPath: session.projectPath, provider: session.provider, accountRef: session.accountRef,
                draft: session.draft, runtimeSessionId: session.runtimeSessionId, account,
              });
              if (action === 'ignore') return;
              accountCatalog.setSelectedAccount(account);
              if (action === 'retarget') {
                // 同 provider 换账号 = 换执行凭据：会话与时间线不变，服务端 open 时会 rebind，
                // harness 换到新账号并用会话历史回填。
                projectCatalog.setSelectedSession({
                  ...session,
                  accountRef: chatAccountIdentity(account),
                  updatedAt: Date.now(),
                });
                return;
              }
              if (!session.projectPath) {
                // 跨 provider 换账号 = 新会话；用户已输入的内容跟着走。
                carryComposerDraftToNextSession();
                projectCatalog.setSelectedSession({
                  id: `draft-${Date.now()}`, title: '新对话', updatedAt: Date.now(),
                  provider: account.provider, draft: true,
                });
                setSelectedModel('');
                return;
              }
              // Work 草稿换到另一个 provider 的账号：按新 provider 重建草稿（项目不变），
              // 否则草稿仍是旧 provider，运行目标会被判成 provider_mismatch。
              if (session.draft && session.provider !== account.provider) {
                carryComposerDraftToNextSession();
                projectCatalog.setSelectedSession({
                  id: `draft-${Date.now()}`, title: session.title || '新会话', updatedAt: Date.now(),
                  provider: account.provider, projectPath: session.projectPath, draft: true,
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
      fallback={(session) => (
        <ChatRuntimeFallback session={session} account={accountCatalog.selectedAccount} mobile={mobile} />
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
  return workspaceMode === 'chat' || !workbench ? (
    runtimeContent
  ) : (
    <ProjectWorkbench
      projectPath={projectCatalog.selectedProject?.path}
      workspace={projectCatalog.selectedProject?.path ? (projectCatalog.selectedProject.remote ? {
        // 远程工作区：文件 / 变更 / 终端都落到 SSH 开发机（root 仍是影子目录 = 项目身份）。
        kind: 'ssh-workspace',
        serverId: resolveActiveServer().serverId || undefined,
        workspaceId: projectCatalog.selectedProject.remote.workspaceId,
        root: projectCatalog.selectedProject.path,
        remoteRoot: projectCatalog.selectedProject.remote.remoteRoot,
        label: `${projectCatalog.selectedProject.remote.host}:${projectCatalog.selectedProject.remote.remoteRoot}`,
      } : {
        kind: resolveActiveServer().isRemote ? 'remote-server' : 'local-server',
        serverId: resolveActiveServer().serverId || undefined,
        root: projectCatalog.selectedProject.path,
        label: resolveActiveServer().isRemote ? '远程 Server' : '本机 Server',
      }) satisfies WorkbenchWorkspaceDescriptor : undefined}
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
