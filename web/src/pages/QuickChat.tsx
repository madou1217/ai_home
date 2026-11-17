import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawer } from 'antd';
import { MenuOutlined, PlusOutlined } from '@ant-design/icons';
import { ProjectList } from '@/components/chat';
import { getSessionRunKey } from '@/components/chat/project-runtime-state.js';
import HudCube from '@/components/hud/HudCube';
import type { WorkspaceMode } from '@/components/chat/ModeSelector';
import type { AggregatedProject, Session } from '@/types';
import { ChatConversationContent, useChatPageState } from './chat-page-state';
import { readQuickChatLaunch, useQuickChatHost } from './chat-quick-launch';
import { useSurfaceSwitch } from '@/hooks/use-surface-switch';
import { runWaapiSurfaceFallback, supersedeActiveTransition } from '@/services/view-transition';
import styles from './quick-chat.module.css';

// Chat 快捷唤起的独立外壳（/chat/quick?embed=desktop，桌面原生小窗）：只做 chat / work。
// 与 WebUI 主站不同的是「壳」，不是会话本身：会话区仍是同一个 canonical 运行时
// （ChatConversationContent → CanonicalChatRuntime），状态仍由 useChatPageState 管。
//
// 视觉：独立的简约主题（quick-chat.module.css 在 [data-quick-chat] 作用域内重设 token），
// 不用 HUD 网格 / 切角 / 发光 / 展示字体。
// 宽度三档（容器宽度，而不是 Grid 断点 —— 原生小窗常在 460~1200 之间拖动）：
//   < 600   单栏：会话列表收进抽屉；
//   600–1000 双栏：左侧会话列表 + 会话区；
//   > 1000  三栏：work 模式下会话区右侧带项目工作台（文件 / Review），chat 模式仍是双栏。

type Layout = 'single' | 'double' | 'triple';

function layoutFor(width: number): Layout {
  if (width < 600) return 'single';
  if (width <= 1000) return 'double';
  return 'triple';
}

function useContainerLayout(): [React.RefObject<HTMLDivElement>, Layout] {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>(() => (
    typeof window === 'undefined' ? 'double' : layoutFor(window.innerWidth)
  ));
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = layoutFor(entry.contentRect.width);
      setLayout((current) => (current === next ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, layout];
}

const MODE_LABEL: Record<WorkspaceMode, string> = { chat: 'Chat', work: 'Work' };

export default function QuickChat() {
  const [launch] = useState(() => readQuickChatLaunch());
  useQuickChatHost(launch);
  const [containerRef, layout] = useContainerLayout();
  const { surfaceRef: workspaceSurfaceRef, switchSurface: switchWorkspaceSurface } = useSurfaceSwitch<HTMLDivElement>();
  const { surfaceRef: mainSurfaceRef } = useSurfaceSwitch<HTMLElement>();
  const compact = layout === 'single';
  const state = useChatPageState(compact, launch.mode, { urlSelectionOnly: true });
  const {
    workspaceMode,
    handleModeChange,
    projectCatalog,
    canonicalDirectory,
    refreshProjectList,
    handleSelectProject,
    handleSelectSession,
    handleCreateSession,
    handleProjectRemoved,
    runningSessionKeys,
    dialogs,
  } = state;
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 一按就能打字：chat 模式打开时没有指定会话 → 直接进一个新对话（账号目录就绪后），
  // 然后把焦点放进输入框。work 模式需要先选项目，保持列表。只自动一次，之后由用户操作。
  const autoStartedRef = useRef(false);
  const accountsReady = state.accountCatalog.accounts.length > 0;
  useEffect(() => {
    if (autoStartedRef.current || workspaceMode !== 'chat' || !accountsReady) return;
    if (projectCatalog.selectedSession) { autoStartedRef.current = true; return; }
    autoStartedRef.current = true;
    handleCreateSession();
  }, [accountsReady, handleCreateSession, projectCatalog.selectedSession, workspaceMode]);
  const selectedSessionId = projectCatalog.selectedSession?.id;
  useEffect(() => {
    if (!selectedSessionId) return undefined;
    // 会话区挂载并连上运行时后（输入区所在 fieldset 在连接前是 disabled，focus 无效）再聚焦；
    // 直到真正拿到焦点为止，最多等 8s。用户自己点了别处就不再抢焦点。
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const box = containerRef.current?.querySelector<HTMLTextAreaElement>('main textarea[placeholder]');
      const usable = box && !box.disabled && !box.closest('fieldset:disabled');
      const userMoved = document.activeElement && document.activeElement !== document.body
        && document.activeElement !== box;
      if (usable && document.activeElement !== box && !userMoved) box.focus();
      if ((box && document.activeElement === box) || userMoved || attempts > 80) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [containerRef, selectedSessionId]);

  const resolveConversationStage = useCallback((): HTMLElement | null => (
    mainSurfaceRef.current?.querySelector<HTMLElement>('[data-chat-center-stage="true"]')
      || mainSurfaceRef.current
  ), [mainSurfaceRef]);

  const switchMode = useCallback((nextMode: WorkspaceMode): void => {
    if (drawerOpen) {
      supersedeActiveTransition();
      setDrawerOpen(false);
      handleModeChange(nextMode);
      if (mainSurfaceRef.current && nextMode !== workspaceMode) {
        runWaapiSurfaceFallback(mainSurfaceRef.current, nextMode === 'work' ? 'forward' : 'backward');
      }
      return;
    }
    switchWorkspaceSurface(() => handleModeChange(nextMode), {
      slot: 'mode',
      current: workspaceMode,
      next: nextMode,
      direction: nextMode === 'work' ? 'forward' : 'backward',
      element: workspaceSurfaceRef.current,
    });
  }, [drawerOpen, handleModeChange, mainSurfaceRef, switchWorkspaceSurface, workspaceMode, workspaceSurfaceRef]);

  const selectProject = useCallback((project: AggregatedProject): void => {
    if (drawerOpen) {
      handleSelectProject(project);
      return;
    }
    switchWorkspaceSurface(() => handleSelectProject(project), {
      slot: 'project',
      current: projectCatalog.selectedProject?.path || '',
      next: project.path,
      direction: 'neutral',
      element: mainSurfaceRef.current,
    });
  }, [drawerOpen, handleSelectProject, mainSurfaceRef, projectCatalog.selectedProject?.path, switchWorkspaceSurface]);

  const selectSession = useCallback((session: Session): void => {
    const currentKey = projectCatalog.selectedSession ? getSessionRunKey(projectCatalog.selectedSession) : '';
    const nextKey = getSessionRunKey(session);
    if (drawerOpen) {
      supersedeActiveTransition();
      handleSelectSession(session);
      setDrawerOpen(false);
      if (mainSurfaceRef.current && currentKey !== nextKey) {
        runWaapiSurfaceFallback(mainSurfaceRef.current, 'neutral');
      }
      return;
    }
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
    drawerOpen,
    handleSelectSession,
    mainSurfaceRef,
    projectCatalog.selectedSession,
    resolveConversationStage,
    switchWorkspaceSurface,
    workspaceMode,
    workspaceSurfaceRef,
  ]);

  const createSession = useCallback((): void => {
    const canCreate = Boolean(state.accountCatalog.selectedAccount || state.accountCatalog.accounts[0])
      && (workspaceMode === 'chat' || Boolean(projectCatalog.selectedProject));
    if (!canCreate) {
      handleCreateSession();
      return;
    }
    const currentKey = projectCatalog.selectedSession ? getSessionRunKey(projectCatalog.selectedSession) : '';
    if (drawerOpen) {
      supersedeActiveTransition();
      handleCreateSession();
      setDrawerOpen(false);
      if (mainSurfaceRef.current) {
        runWaapiSurfaceFallback(mainSurfaceRef.current, 'forward');
      }
      return;
    }
    switchWorkspaceSurface(() => handleCreateSession(), {
      slot: 'session',
      current: currentKey,
      next: `draft:${Date.now()}`,
      direction: 'forward',
      element: resolveConversationStage(),
    });
  }, [
    drawerOpen,
    handleCreateSession,
    mainSurfaceRef,
    projectCatalog.selectedProject,
    projectCatalog.selectedSession,
    resolveConversationStage,
    state.accountCatalog.accounts,
    state.accountCatalog.selectedAccount,
    switchWorkspaceSurface,
    workspaceMode,
  ]);

  const quickState = useMemo(() => ({
    ...state,
    handleModeChange: switchMode,
    handleSelectProject: selectProject,
    handleSelectSession: selectSession,
    handleCreateSession: createSession,
  }), [createSession, selectProject, selectSession, state, switchMode]);

  const sessionList = (
    <ProjectList
      projects={canonicalDirectory.projects}
      loading={projectCatalog.loadingProjects}
      hydratingProjectPaths={projectCatalog.hydratingProjectPaths}
      runningSessionKeys={runningSessionKeys}
      selectedSession={projectCatalog.selectedSession}
      selectedProject={projectCatalog.selectedProject}
      expandedProjects={projectCatalog.expandedProjects}
      mode={workspaceMode}
      onRefresh={refreshProjectList}
      onToggleProject={projectCatalog.toggleProject}
      onSelectProject={selectProject}
      onSelectSession={selectSession}
      onOpenProject={dialogs.openProject}
      onCreateSession={createSession}
      onProjectRemoved={handleProjectRemoved}
    />
  );

  const title = projectCatalog.selectedSession?.title
    || (workspaceMode === 'chat' ? '新对话' : (projectCatalog.selectedProject?.name || '选择项目'));

  return (
    <div
      ref={containerRef}
      className={styles.shell}
      data-quick-chat="true"
      data-layout={layout}
    >
      <header className={styles.topbar}>
        {compact ? (
          <button type="button" className={styles.iconButton} aria-label="会话列表" onClick={() => setDrawerOpen(true)}>
            <MenuOutlined />
          </button>
        ) : null}
        <HudCube size={18} mode="brand" tone="cyan" interactive label="AI Home 全息棱镜（点击果冻弹跳）" />
        <div className={styles.modeSwitch} data-mode={workspaceMode} role="tablist" aria-label="模式">
          {(['chat', 'work'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={workspaceMode === mode}
              className={styles.modeTab}
              data-active={workspaceMode === mode || undefined}
              onClick={() => switchMode(mode)}
            >
              {MODE_LABEL[mode]}
            </button>
          ))}
        </div>
        <div className={styles.title} title={title}>{title}</div>
        <button type="button" className={styles.iconButton} aria-label="新建会话" onClick={createSession}>
          <PlusOutlined />
        </button>
      </header>
      <div ref={workspaceSurfaceRef} className={styles.body}>
        {compact ? null : <aside className={styles.sidebar} aria-label="会话列表">{sessionList}</aside>}
        <main ref={mainSurfaceRef} className={styles.main}>
          <ChatConversationContent state={quickState} workbench={layout === 'triple'} forceColumnsLayout />
        </main>
      </div>
      {compact ? (
        <Drawer
          placement="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width="min(320px, 86vw)"
          closable={false}
          rootClassName={styles.drawer}
          styles={{ body: { padding: 0 } }}
        >
          {sessionList}
        </Drawer>
      ) : null}
      {dialogs.node}
    </div>
  );
}
