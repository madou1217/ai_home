import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from 'antd';
import { MenuOutlined, PlusOutlined } from '@ant-design/icons';
import { ProjectList } from '@/components/chat';
import type { WorkspaceMode } from '@/components/chat/ModeSelector';
import type { Session } from '@/types';
import { ChatConversationContent, useChatPageState } from './chat-page-state';
import { readQuickChatLaunch, useQuickChatHost } from './chat-quick-launch';
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
  const compact = layout === 'single';
  const state = useChatPageState(compact, launch.mode);
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

  const selectSession = useCallback((session: Session): void => {
    handleSelectSession(session);
    setDrawerOpen(false);
  }, [handleSelectSession]);
  const createSession = useCallback((): void => {
    handleCreateSession();
    setDrawerOpen(false);
  }, [handleCreateSession]);

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
      onSelectProject={handleSelectProject}
      onSelectSession={selectSession}
      onOpenProject={dialogs.openProject}
      onCreateSession={createSession}
      onProjectRemoved={handleProjectRemoved}
    />
  );

  const title = projectCatalog.selectedSession?.title
    || (workspaceMode === 'chat' ? '新对话' : (projectCatalog.selectedProject?.name || '选择项目'));

  return (
    <div ref={containerRef} className={styles.shell} data-quick-chat="true" data-layout={layout}>
      <header className={styles.topbar}>
        {compact ? (
          <button type="button" className={styles.iconButton} aria-label="会话列表" onClick={() => setDrawerOpen(true)}>
            <MenuOutlined />
          </button>
        ) : null}
        <div className={styles.modeSwitch} role="tablist" aria-label="模式">
          {(['chat', 'work'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={workspaceMode === mode}
              className={styles.modeTab}
              data-active={workspaceMode === mode || undefined}
              onClick={() => handleModeChange(mode)}
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
      <div className={styles.body}>
        {compact ? null : <aside className={styles.sidebar} aria-label="会话列表">{sessionList}</aside>}
        <main className={styles.main}>
          <ChatConversationContent state={state} workbench={layout === 'triple'} />
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
