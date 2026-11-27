import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dropdown, Grid } from 'antd';
import {
  EllipsisOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import Button from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { ProjectList } from '@/components/chat';
import ArchivedDrawer from '@/components/chat/ArchivedDrawer';
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
import { ChatConversationContent, useChatPageState, type WorkScope } from './chat-page-state';
import styles from './chat-sidebar.module.css';

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
    workScope,
    handleWorkScopeChange,
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
      workScope={workScope}
      onWorkScopeChange={handleWorkScopeChange}
      onOpenRemoteWorkspace={switchRemoteWorkspace}
      onRefresh={refreshProjectList}
      onToggleProject={projectCatalog.toggleProject}
      onSelectProject={switchProject}
      onSelectSession={switchSession}
      onOpenProject={dialogs.openProject}
      onCreateSession={switchCreateSession}
      onProjectRemoved={handleProjectRemoved}
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
  readonly workScope: WorkScope;
  readonly onWorkScopeChange: (scope: WorkScope) => void;
  readonly onOpenRemoteWorkspace: (workspace: { projectPath?: string }) => Promise<void>;
  readonly onRefresh: () => void;
  readonly onToggleProject: (projectId: string) => void;
  readonly onSelectProject: (project: AggregatedProject) => void;
  readonly onSelectSession: (session: Session) => void;
  readonly onOpenProject: () => void;
  readonly onCreateSession: () => void;
  readonly onProjectRemoved: (project: AggregatedProject) => void;
}

/**
 * AI 会话侧栏。
 *
 * 结构只有三层，避免「标题 + 又一行按钮 + 列表自带顶栏」的堆叠：
 *   1. 头部：标题「AI 会话」+ 模式标记 + 该模式下的操作按钮（唯一操作区）。
 *   2. Work 的 本地 / 远程 分段：唯一的模式切换，紧贴列表上沿。
 *   3. 列表：项目会话（本地）或 SSH 远程工作区（远程）。
 *
 * 空态 / 加载 / 失败各自只有一处表达：加载走骨架，无项目走引导卡片，同步失败走列表下方提示条。
 */
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
  workScope,
  onWorkScopeChange,
  onOpenRemoteWorkspace,
  onRefresh,
  onToggleProject,
  onSelectProject,
  onSelectSession,
  onOpenProject,
  onCreateSession,
  onProjectRemoved,
}: ChatSidebarPaneProps) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [remoteRefreshKey, setRemoteRefreshKey] = useState(0);
  // 远程工作区只在桌面侧栏切换；移动端保持原有列表交互（没有分段器就没有回程入口）。
  const workRemote = !mobile && workspaceMode === 'work' && workScope === 'remote';
  const listLoading = loading || directoryStatus === 'loading';
  // 只有「目录确实同步成功且确实没有项目」才算首次使用：loading / failed 都不弹引导，
  // 否则短暂的空目录会被误读成「数据丢了」。
  const showWorkFirstRun = !mobile
    && workspaceMode === 'work'
    && !workRemote
    && directoryStatus === 'ready'
    && !loading
    && projects.length === 0;
  const canCreate = workspaceMode === 'chat' || Boolean(selectedProject);

  // Chat 模式的会话列表由 ProjectList 自己维护；它订阅 aih:chat-sessions-changed 触发重取，
  // 这里复用同一通道刷新，不再往 ProjectList 里塞第二套刷新接口。
  const refreshChatSessions = useCallback((): void => {
    window.dispatchEvent(new Event('aih:chat-sessions-changed'));
    onRefresh();
  }, [onRefresh]);

  const headerActions = (
    <div className={styles.headerActions}>
      {workRemote ? (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setRemoteRefreshKey((current) => current + 1)}
          title="刷新远程工作区"
          aria-label="刷新远程工作区"
        >
          <ReloadOutlined />
        </button>
      ) : (
        <>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onCreateSession}
            disabled={!canCreate}
            title={workspaceMode === 'chat' ? '发起新对话' : (selectedProject ? '新建工作区会话' : '先选择一个项目')}
            aria-label={workspaceMode === 'chat' ? '新建会话' : '新建工作区会话'}
          >
            <PlusOutlined />
          </button>
          {workspaceMode === 'work' ? (
            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              menu={{
                items: [
                  { key: 'open', icon: <FolderOpenOutlined />, label: '打开项目目录' },
                  { key: 'archived', icon: <InboxOutlined />, label: '已归档的会话' },
                  { key: 'refresh', icon: <ReloadOutlined spin={listLoading} />, label: '刷新列表' },
                ],
                onClick: ({ key }) => {
                  if (key === 'open') onOpenProject();
                  else if (key === 'archived') setArchivedOpen(true);
                  else if (key === 'refresh') onRefresh();
                },
              }}
            >
              <button
                type="button"
                className={styles.iconBtn}
                title="更多操作：打开项目 / 已归档 / 刷新"
                aria-label="更多操作"
              >
                <EllipsisOutlined />
              </button>
            </Dropdown>
          ) : (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={refreshChatSessions}
              title="刷新会话列表"
              aria-label="刷新会话列表"
            >
              <ReloadOutlined spin={listLoading} />
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className={styles.pane}>
      {!mobile ? (
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>AI 会话</h1>
            <span className={styles.modeTag} aria-hidden="true">
              {workspaceMode === 'work' ? 'WORK' : 'CHAT'}
            </span>
          </div>
          {headerActions}
        </header>
      ) : null}

      {!mobile && workspaceMode === 'work' ? (
        <div className={styles.scopeTabs} role="tablist" aria-label="工作区范围">
          {(['local', 'remote'] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              role="tab"
              aria-selected={workScope === scope}
              className={`${styles.scopeTab} ${workScope === scope ? styles.scopeTabActive : ''}`}
              onClick={() => onWorkScopeChange(scope)}
            >
              {scope}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.listArea}>
        {workRemote ? (
          <div className={styles.remotePane} key={remoteRefreshKey}>
            <RemoteWorkspacesPanel onOpenInWork={onOpenRemoteWorkspace} onlyWorkspaces />
          </div>
        ) : showWorkFirstRun ? (
          <div className={styles.firstRun}>
            <strong className={styles.firstRunTitle}>还没有本地工作区</strong>
            <p className={styles.firstRunText}>
              打开一个本地项目目录，就能在这里看到它的会话、文件与终端。
            </p>
            <Button type="primary" size="small" icon={<FolderOpenOutlined />} onClick={onOpenProject}>
              打开项目目录
            </Button>
          </div>
        ) : (
          <ProjectList
            mobile={mobile}
            projects={projects}
            loading={listLoading}
            hydratingProjectPaths={hydratingProjectPaths}
            runningSessionKeys={runningSessionKeys}
            selectedSession={selectedSession}
            selectedProject={selectedProject}
            expandedProjects={expandedProjects}
            mode={workspaceMode}
            showDesktopHeader={false}
            onRefresh={onRefresh}
            onToggleProject={onToggleProject}
            onSelectProject={onSelectProject}
            onSelectSession={onSelectSession}
            onOpenProject={onOpenProject}
            onCreateSession={onCreateSession}
            onProjectRemoved={onProjectRemoved}
          />
        )}
      </div>

      {/* 失败只影响本地目录：远程面板有自己的空态，不叠加这条提示。 */}
      {directoryStatus === 'failed' && !workRemote && !mobile ? (
        <div role="alert" className={styles.failureStrip}>
          <SettingStatusTag
            status="error"
            label={offlineCached ? '离线缓存' : '同步失败'}
            detail={offlineCached ? '服务端不可达，当前展示离线缓存的会话列表' : '会话目录同步失败，展示最近一次结果'}
            compact
          />
          <Button type="link" size="small" icon={<ReloadOutlined />} onClick={onRefresh} style={{ paddingInline: 4 }}>
            重试
          </Button>
        </div>
      ) : null}

      {!mobile ? <ArchivedDrawer open={archivedOpen} onClose={() => setArchivedOpen(false)} onRestored={onRefresh} /> : null}
    </div>
  );
}
