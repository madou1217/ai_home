import { useEffect, useState } from 'react';
import { Grid } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { ProjectList } from '@/components/chat';
import GlobalCommandPalette from '@/components/chat/GlobalCommandPalette';
import KeyboardShortcutsModal from '@/components/chat/KeyboardShortcutsModal';
import {
  IN_SESSION_SEARCH_OPEN_EVENT,
  resolveChatGlobalShortcut,
} from '@/components/chat/chat-global-shortcuts';
import ChatWorkspaceLayout from '@/features/legacy-chat/ChatWorkspaceLayout';
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
    handleSelectProject,
    handleSelectSession,
    handleCreateSession,
    handleProjectRemoved,
    runningSessionKeys,
    selectedSessionRunning,
    projectLabel,
    navigation,
  } = state;

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
      chatContent={<ChatConversationContent state={state} />}
      dialogs={dialogs.node}
      onBack={navigation.back}
      onCreateSession={handleCreateSession}
      onTouchStart={navigation.touchStart}
      onTouchEnd={navigation.touchEnd}
    />
    </>
  );
}
