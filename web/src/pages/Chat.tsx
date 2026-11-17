import { useCallback, useEffect, useMemo, useState } from 'react';
import { Grid } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
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
    <div style={{ position: 'relative', height: '100%', minHeight: 0 }}>
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
        onModeChange={switchMode}
        onRefresh={refreshProjectList}
        onToggleProject={projectCatalog.toggleProject}
        onSelectProject={switchProject}
        onSelectSession={switchSession}
        onOpenProject={dialogs.openProject}
        onCreateSession={switchCreateSession}
        onProjectRemoved={handleProjectRemoved}
        remoteSessionsPanel={workspaceMode === 'work' ? <RemoteWorkspacesPanel onOpenInWork={switchRemoteWorkspace} /> : null}
      />
      {canonicalDirectory.status === 'failed' ? (
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
            padding: '6px 12px',
            borderRadius: 2,
            border: '1px solid color-mix(in srgb, var(--color-warning) 45%, var(--color-border))',
            background: 'var(--color-surface-raised)',
            boxShadow: 'var(--elevation-3)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--color-muted-strong)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="hud-led hud-led--warn" aria-hidden="true" />
            {canonicalDirectory.offlineCached
              ? '服务端不可达，展示离线缓存的会话列表'
              : '会话目录同步失败，展示的是最近一次结果'}
          </span>
          <button
            type="button"
            onClick={refreshProjectList}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              fontSize: 12,
              color: 'var(--color-accent)',
            }}
          >
            重试
          </button>
        </div>
      ) : null}
    </div>
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
