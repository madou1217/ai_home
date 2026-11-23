import { useCallback, useEffect, useMemo, useState } from 'react';
import { Grid } from 'antd';
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import Button from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { ProjectList } from '@/components/chat';
import GlobalCommandPalette from '@/components/chat/GlobalCommandPalette';
import KeyboardShortcutsModal from '@/components/chat/KeyboardShortcutsModal';
import type { WorkspaceMode } from '@/components/chat/ModeSelector';
import {
  IN_SESSION_SEARCH_OPEN_EVENT,
  resolveChatGlobalShortcut,
} from '@/components/chat/chat-global-shortcuts';
import { getSessionRunKey } from '@/components/chat/project-runtime-state.js';
import ChatWorkspaceLayout from '@/features/chat-workspace/ChatWorkspaceLayout';
import RemoteWorkspacesPanel from '@/features/ssh-hosts/RemoteWorkspacesPanel';
import { useSurfaceSwitch } from '@/hooks/use-surface-switch';
import type { AggregatedProject, Session } from '@/types';
import { ChatConversationContent, useChatPageState } from './chat-page-state';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

export default function Chat() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const shortcut = resolveChatGlobalShortcut(e);
      if (shortcut === 'command-palette') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      } else if (shortcut === 'shortcuts-help') {
        e.preventDefault();
        setShortcutsModalOpen((prev) => !prev);
      } else if (shortcut === 'in-session-search') {
        e.preventDefault();
        // 由当前挂载的 surface 监听并打开各自的检索胶囊
        // (legacy=MessageArea,native=ConversationTimeline)
        window.dispatchEvent(new Event(IN_SESSION_SEARCH_OPEN_EVENT));
      } else if (shortcut === 'chat-mini-window') {
        // ChatMiniWindow is mounted by the app shell, so this action stays
        // route-independent while the page still prevents browser handling.
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const screens = Grid.useBreakpoint();
  const mobile = !screens.md;
  const state = useChatPageState(mobile);
  const {
    workspaceMode,
    handleModeChange,
    projectCatalog,
    canonicalDirectory,
    setSelectedModel,
    mobileShowChat,
    dialogs,
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
  } = state;

  const { surfaceRef: workspaceSurfaceRef, switchSurface: switchWorkspaceSurface } = useSurfaceSwitch<HTMLDivElement>();
  const { surfaceRef: contentSurfaceRef } = useSurfaceSwitch<HTMLElement>();

  const resolveConversationStage = useCallback((): HTMLElement | null => (
    contentSurfaceRef.current?.querySelector<HTMLElement>('[data-chat-center-stage="true"]')
      || contentSurfaceRef.current
  ), [contentSurfaceRef]);

  const switchMode = useCallback((nextMode: WorkspaceMode): void => {
    if (mobile) {
      handleModeChange(nextMode);
      return;
    }
    switchWorkspaceSurface(() => handleModeChange(nextMode), {
      slot: 'mode',
      current: workspaceMode,
      next: nextMode,
      direction: nextMode === 'work' ? 'forward' : 'backward',
      element: workspaceSurfaceRef.current,
    });
  }, [handleModeChange, mobile, switchWorkspaceSurface, workspaceMode, workspaceSurfaceRef]);

  const switchProject = useCallback((project: AggregatedProject): void => {
    if (mobile) {
      handleSelectProject(project);
      return;
    }
    switchWorkspaceSurface(() => handleSelectProject(project), {
      slot: 'project',
      current: projectCatalog.selectedProject?.path || '',
      next: project.path,
      direction: 'neutral',
      element: contentSurfaceRef.current,
    });
  }, [contentSurfaceRef, handleSelectProject, mobile, projectCatalog.selectedProject?.path, switchWorkspaceSurface]);

  const switchSession = useCallback((session: Session): void => {
    if (mobile) {
      handleSelectSession(session);
      return;
    }
    const currentKey = projectCatalog.selectedSession ? getSessionRunKey(projectCatalog.selectedSession) : '';
    const nextKey = getSessionRunKey(session);
    const targetMode: WorkspaceMode = session.projectPath ? 'work' : 'chat';
    const changesMode = targetMode !== workspaceMode;
    switchWorkspaceSurface(() => handleSelectSession(session), {
      slot: 'session',
      current: currentKey,
      next: nextKey,
      direction: changesMode ? (targetMode === 'work' ? 'forward' : 'backward') : 'neutral',
      element: changesMode ? workspaceSurfaceRef.current : resolveConversationStage(),
    });
  }, [
    handleSelectSession,
    mobile,
    projectCatalog.selectedSession,
    resolveConversationStage,
    switchWorkspaceSurface,
    workspaceMode,
    workspaceSurfaceRef,
  ]);

  const switchCreateSession = useCallback((): void => {
    const canCreate = Boolean(state.accountCatalog.selectedAccount || state.accountCatalog.accounts[0])
      && (workspaceMode === 'chat' || Boolean(projectCatalog.selectedProject));
    if (mobile || !canCreate) {
      handleCreateSession();
      return;
    }
    const currentKey = projectCatalog.selectedSession ? getSessionRunKey(projectCatalog.selectedSession) : '';
    switchWorkspaceSurface(() => handleCreateSession(), {
      slot: 'session',
      current: currentKey,
      next: `draft:${Date.now()}`,
      direction: 'forward',
      element: resolveConversationStage(),
    });
  }, [
    handleCreateSession,
    mobile,
    projectCatalog.selectedProject,
    projectCatalog.selectedSession,
    resolveConversationStage,
    state.accountCatalog.accounts,
    state.accountCatalog.selectedAccount,
    switchWorkspaceSurface,
    workspaceMode,
  ]);

  const switchRemoteWorkspace = useCallback(async (workspace: { projectPath?: string }): Promise<void> => {
    const projectPath = String(workspace.projectPath || '');
    if (!projectPath || mobile) {
      await handleOpenRemoteWorkspace(workspace);
      return;
    }
    await switchWorkspaceSurface(() => handleOpenRemoteWorkspace(workspace), {
      slot: 'project',
      current: `${workspaceMode}:${projectCatalog.selectedProject?.path || ''}`,
      next: `work:${projectPath}`,
      direction: workspaceMode === 'work' ? 'neutral' : 'forward',
      element: workspaceMode === 'work' ? contentSurfaceRef.current : workspaceSurfaceRef.current,
    });
  }, [
    contentSurfaceRef,
    handleOpenRemoteWorkspace,
    mobile,
    projectCatalog.selectedProject?.path,
    switchWorkspaceSurface,
    workspaceMode,
    workspaceSurfaceRef,
  ]);

  const effectiveState = useMemo(() => (
    mobile ? state : {
      ...state,
      handleModeChange: switchMode,
      handleSelectProject: switchProject,
      handleSelectSession: switchSession,
      handleCreateSession: switchCreateSession,
      handleOpenRemoteWorkspace: switchRemoteWorkspace,
    }
  ), [
    mobile,
    state,
    switchCreateSession,
    switchMode,
    switchProject,
    switchRemoteWorkspace,
    switchSession,
  ]);

  const projectList = (
    <ChatSidebarPane
      mobile={mobile}
      workspaceMode={workspaceMode}
      projects={canonicalDirectory.projects}
      directoryStatus={canonicalDirectory.status}
      offlineCached={canonicalDirectory.offlineCached}
      loading={projectCatalog.loadingProjects}
      hydratingProjectPaths={projectCatalog.hydratingProjectPaths}
      runningSessionKeys={runningSessionKeys}
      selectedSession={projectCatalog.selectedSession}
      selectedProject={projectCatalog.selectedProject}
      expandedProjects={projectCatalog.expandedProjects}
      onModeChange={switchMode}
      onRefresh={refreshProjectList}
      onToggleProject={projectCatalog.toggleProject}
      onSelectProject={switchProject}
      onSelectSession={switchSession}
      onOpenProject={dialogs.openProject}
      onCreateSession={switchCreateSession}
      onProjectRemoved={handleProjectRemoved}
      onOpenRemoteWorkspace={switchRemoteWorkspace}
    />
  );

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
        chatContent={<ChatConversationContent state={effectiveState} />}
        dialogs={dialogs.node}
        onBack={navigation.back}
        onCreateSession={switchCreateSession}
        onTouchStart={navigation.touchStart}
        onTouchEnd={navigation.touchEnd}
        workspaceSurfaceRef={workspaceSurfaceRef}
        contentSurfaceRef={contentSurfaceRef}
      />
    </>
  );
}

interface ChatSidebarPaneProps {
  readonly mobile: boolean;
  readonly workspaceMode: WorkspaceMode;
  readonly projects: AggregatedProject[];
  readonly directoryStatus: 'loading' | 'ready' | 'failed';
  readonly offlineCached: boolean;
  readonly loading: boolean;
  readonly hydratingProjectPaths: Set<string>;
  readonly runningSessionKeys: Set<string>;
  readonly selectedSession: Session | null;
  readonly selectedProject: AggregatedProject | null;
  readonly expandedProjects: Set<string>;
  readonly onModeChange: (mode: WorkspaceMode) => void;
  readonly onRefresh: () => void;
  readonly onToggleProject: (projectId: string) => void;
  readonly onSelectProject: (project: AggregatedProject) => void;
  readonly onSelectSession: (session: Session) => void;
  readonly onOpenProject: () => void;
  readonly onCreateSession: () => void;
  readonly onProjectRemoved: (project: AggregatedProject) => void;
  readonly onOpenRemoteWorkspace: (workspace: { projectPath?: string }) => Promise<void>;
}

function ChatSidebarPane({
  mobile,
  workspaceMode,
  projects,
  directoryStatus,
  offlineCached,
  loading,
  hydratingProjectPaths,
  runningSessionKeys,
  selectedSession,
  selectedProject,
  expandedProjects,
  onModeChange,
  onRefresh,
  onToggleProject,
  onSelectProject,
  onSelectSession,
  onOpenProject,
  onCreateSession,
  onProjectRemoved,
  onOpenRemoteWorkspace,
}: ChatSidebarPaneProps) {
  const showWorkFirstRun = workspaceMode === 'work' && !loading && projects.length === 0;
  const headingSubtitle = workspaceMode === 'chat'
    ? '选择或新建对话；角色与压缩设置按会话保存'
    : '按项目组织代码会话，支持本地与远程工作区';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', height: '100%', minHeight: 0 }}>
      {!mobile ? (
        <div
          style={{
            flex: '0 0 auto',
            padding: '12px 14px 8px',
            borderBottom: '1px solid var(--color-border-subtle, var(--color-border))',
            background: 'var(--color-surface-raised)',
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1.35,
              color: 'var(--color-heading)',
            }}
          >
            AI 会话
          </h1>
          <p
            style={{
              margin: '2px 0 0',
              fontSize: 12,
              lineHeight: 1.45,
              color: 'var(--color-muted)',
            }}
          >
            {headingSubtitle}
          </p>
        </div>
      ) : null}

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        <ProjectList
          mobile={mobile}
          projects={projects}
          loading={loading}
          hydratingProjectPaths={hydratingProjectPaths}
          runningSessionKeys={runningSessionKeys}
          selectedSession={selectedSession}
          selectedProject={selectedProject}
          expandedProjects={expandedProjects}
          mode={workspaceMode}
          onModeChange={onModeChange}
          onRefresh={onRefresh}
          onToggleProject={onToggleProject}
          onSelectProject={onSelectProject}
          onSelectSession={onSelectSession}
          onOpenProject={onOpenProject}
          onCreateSession={onCreateSession}
          onProjectRemoved={onProjectRemoved}
          remoteSessionsPanel={workspaceMode === 'work' ? <RemoteWorkspacesPanel onOpenInWork={onOpenRemoteWorkspace} /> : null}
        />

        {showWorkFirstRun ? (
          <div
            style={{
              position: 'absolute',
              left: 12,
              right: 12,
              bottom: directoryStatus === 'failed' ? 56 : 12,
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 8,
              padding: 12,
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--hos-radius-md, 8px)',
              background: 'var(--color-surface)',
            }}
          >
            <strong style={{ fontSize: 13, color: 'var(--color-heading)' }}>首次使用工作区</strong>
            <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-muted)' }}>
              打开本地项目目录即可开始代码会话、文件查看与终端。
            </span>
            <Button type="primary" size="small" icon={<FolderOpenOutlined />} onClick={onOpenProject}>
              打开项目目录
            </Button>
          </div>
        ) : null}

        {directoryStatus === 'failed' ? (
          <div
            role="alert"
            style={{
              position: 'absolute',
              left: 12,
              right: 12,
              bottom: 12,
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              flexWrap: 'wrap',
              padding: '8px 10px',
              borderRadius: 'var(--hos-radius-sm, 6px)',
              border: '1px solid var(--color-border-strong, var(--color-border))',
              background: 'var(--color-surface-raised)',
              boxShadow: 'var(--elevation-3)',
              fontSize: 12,
              color: 'var(--color-muted-strong)',
            }}
          >
            <SettingStatusTag
              status="error"
              label={offlineCached ? '离线缓存' : '同步失败'}
              detail={offlineCached ? '服务端不可达，当前展示离线缓存的会话列表' : '会话目录同步失败，展示最近一次结果'}
              compact
            />
            <Button
              type="link"
              size="small"
              icon={<ReloadOutlined />}
              onClick={onRefresh}
              style={{ paddingInline: 4 }}
            >
              重试
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
