import { useState } from 'react';
import {
  CodeOutlined,
  DeleteOutlined,
  DownOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  InboxOutlined,
  LoadingOutlined,
  MessageOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import ProviderIcon from '@/components/chat/ProviderIcon';
import {
  getRunningProviders,
  getSessionRunKey,
  getVisibleProjectSessions,
  isSameSession,
  isSessionRunning,
} from '@/components/chat/project-runtime-state.js';
import { getProviderLabel, providerAccentStyle } from '@/components/chat/provider-registry';
import MobileBoot from '@/mobile/MobileBoot';
import {
  EmptySignal,
  HudChips,
  HudIconButton,
  HudSection,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow,
} from '@/mobile/ui';
import type { SwipeAction } from '@/mobile/ui';
import type { ChatPageState } from '@/pages/chat-page-state';
import type { AggregatedProject, Session } from '@/types';
import type { MobileChatSessions } from './use-mobile-chat-sessions';
import styles from './mobile-chat.module.css';

const COLLAPSED_LIMIT = 10;

interface Props {
  state: ChatPageState;
  sessions: MobileChatSessions;
  onOpenArchived: () => void;
}

/** 按运行中优先、再按最近活跃排序（与旧移动端列表一致，只影响展示顺序）。 */
function sortByActivity<T extends Session>(list: T[], running: Set<string>): T[] {
  return [...list].sort((a, b) => {
    const ra = isSessionRunning(a, running) ? 1 : 0;
    const rb = isSessionRunning(b, running) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function projectActivity(project: AggregatedProject): number {
  return Math.max(0, ...project.sessions.map((session) => session.updatedAt || 0));
}

/** 屏 1：会话列表（顶栏 + 底部导航可见）。 */
export default function ChatSessionList({ state, sessions, onOpenArchived }: Props) {
  const {
    workspaceMode,
    handleModeChange,
    projectCatalog,
    canonicalDirectory,
    dialogs,
    refreshProjectList,
    handleSelectProject,
    handleSelectSession,
    handleCreateSession,
    runningSessionKeys,
  } = state;
  // 手风琴状态本地持有、按 path 标识：目录快照会反复重算 expandedProjects，
  // 而聚合项目 id 会随 provider 顺序漂移，path 才是稳定键。
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const chatMode = workspaceMode === 'chat';
  const projects = canonicalDirectory.projects;
  const loading = chatMode ? sessions.loadingChatSessions : projectCatalog.loadingProjects;
  const selectedProject = projectCatalog.selectedProject;
  const selectedSession = projectCatalog.selectedSession;

  const projectHasRunning = (project: AggregatedProject) =>
    project.sessions.some((session) => isSessionRunning(session, runningSessionKeys));
  const orderedProjects = [...projects].sort((a, b) => {
    const ra = projectHasRunning(a) ? 1 : 0;
    const rb = projectHasRunning(b) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return projectActivity(b) - projectActivity(a);
  });
  const runningTotal = projects.reduce(
    (sum, project) => sum + project.sessions.filter((s) => isSessionRunning(s, runningSessionKeys)).length,
    0,
  );

  const toggleProject = (project: AggregatedProject) => {
    setOpenPath((current) => (current === project.path ? null : project.path));
    // 与桌面项目行点击一致：选中项目（补全会话）+ 切换展开
    handleSelectProject(project);
    projectCatalog.toggleProject(project.id);
  };

  const toggleShowAll = (path: string) => {
    setShowAll((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const refresh = chatMode ? () => { void sessions.fetchChatSessions(); } : refreshProjectList;
  const createDisabled = !chatMode && !selectedProject;
  const pinnedCount = sessions.chatSessions.filter((session) => sessions.pinnedSessionIds.has(session.id)).length;

  const renderChatSession = (session: Session) => {
    const pinned = sessions.pinnedSessionIds.has(session.id);
    const active = isSameSession(selectedSession, session);
    const actions: SwipeAction[] = [
      {
        key: 'pin',
        label: pinned ? '取消置顶' : '置顶',
        icon: pinned ? <PushpinFilled /> : <PushpinOutlined />,
        tone: 'primary',
        onAction: () => sessions.togglePin(session.id),
      },
      {
        key: 'delete',
        label: '删除',
        icon: <DeleteOutlined />,
        tone: 'danger',
        onAction: () => { void sessions.deleteChatSession(session); },
      },
    ];
    return (
      <SwipeRow
        key={session.id}
        actions={actions}
        onTap={() => handleSelectSession(session)}
        ariaLabel={session.title || '新对话'}
      >
        <span
          className={`mhud-row__icon ${styles.providerSlot}${active ? ` ${styles.rowActive}` : ''}`}
          style={providerAccentStyle(session.provider)}
        >
          <ProviderIcon provider={session.provider} size={18} />
        </span>
        <div className="mhud-row__main">
          <span className="mhud-row__title">
            {pinned ? <PushpinFilled className={`${styles.pin} mhud-tone--warn`} aria-label="已置顶" /> : null}
            {session.title || '新对话'}
          </span>
          <span className="mhud-row__meta">
            {session.model ? `${getProviderLabel(session.provider)} · ${session.model}` : getProviderLabel(session.provider)}
          </span>
        </div>
        <div className="mhud-row__side">
          <span className={styles.time}>{dayjs(session.updatedAt).fromNow()}</span>
          {active ? <span className="mhud-status mhud-tone--info"><span className="hud-led hud-led--info" aria-hidden="true" />OPEN</span> : null}
        </div>
      </SwipeRow>
    );
  };

  const renderWorkSession = (session: Session) => {
    const running = isSessionRunning(session, runningSessionKeys);
    const active = isSameSession(selectedSession, session);
    const archive = sessions.archiveAction(session);
    const actions: SwipeAction[] = archive.visible
      ? [{
        key: 'archive',
        label: '归档',
        icon: <InboxOutlined />,
        disabled: archive.disabled,
        onAction: () => { void sessions.archiveSession(session); },
      }]
      : [];
    return (
      <SwipeRow
        key={getSessionRunKey(session)}
        actions={actions}
        onTap={() => handleSelectSession(session)}
        ariaLabel={session.title}
      >
        <span className={styles.nest} aria-hidden="true" />
        <span
          className={`mhud-row__icon ${styles.providerSlot}${active ? ` ${styles.rowActive}` : ''}`}
          style={providerAccentStyle(session.provider)}
        >
          <ProviderIcon provider={session.provider} size={18} />
        </span>
        <div className="mhud-row__main">
          <span className="mhud-row__title">{session.title}</span>
          <span className="mhud-row__meta">{session.model || getProviderLabel(session.provider)}</span>
        </div>
        <div className="mhud-row__side">
          {running ? (
            <span className="mhud-status mhud-tone--ok"><span className="hud-led hud-led--ok hud-led--live" aria-hidden="true" />RUN</span>
          ) : (
            <span className={styles.time}>{dayjs(session.updatedAt).fromNow()}</span>
          )}
        </div>
      </SwipeRow>
    );
  };

  const renderProject = (project: AggregatedProject) => {
    const isOpen = openPath === project.path;
    const isSelected = selectedProject?.path === project.path;
    const runningProviders = getRunningProviders(project.sessions, runningSessionKeys);
    const runCount = project.sessions.filter((s) => isSessionRunning(s, runningSessionKeys)).length;
    const isShowAll = showAll.has(project.path);
    const visible = getVisibleProjectSessions(
      sortByActivity(project.sessions, runningSessionKeys),
      isOpen,
      isShowAll,
      COLLAPSED_LIMIT,
      project.sessions.length,
    );
    const canExpandMore = project.sessions.length > COLLAPSED_LIMIT;
    const hydrating = projectCatalog.hydratingProjectPaths.has(project.path);
    return [
      <SwipeRow
        key={`p:${project.path}`}
        actions={[{
          key: 'remove',
          label: '移除',
          icon: <MinusCircleOutlined />,
          tone: 'danger',
          onAction: () => { void sessions.removeProject(project); },
        }]}
        onTap={() => toggleProject(project)}
        ariaLabel={`${project.name}，${isOpen ? '收起' : '展开'}会话`}
      >
        <span className={`mhud-row__icon${isSelected ? ` ${styles.rowActive}` : ''}`}>
          {isOpen ? <FolderOpenOutlined /> : <FolderOutlined />}
        </span>
        <div className="mhud-row__main">
          <span className="mhud-row__title">{project.name}</span>
          <span className="mhud-row__meta">
            {project.sessionTotal ?? project.sessions.length} 会话
            {runCount > 0 ? <span className="mhud-tone--ok"> · {runCount} 运行中</span> : null}
          </span>
        </div>
        <div className={`mhud-row__side ${styles.projectSide}`}>
          <span className={styles.providerStack}>
            {(project.providers || []).slice(0, 3).map((provider) => (
              <span
                key={provider}
                className={`${styles.providerMini}${runningProviders.has(provider) ? ` ${styles.providerMiniRunning}` : ''}`}
                style={providerAccentStyle(provider)}
              >
                <ProviderIcon provider={provider} size={14} />
              </span>
            ))}
          </span>
          <DownOutlined className={`${styles.chevron}${isOpen ? ` ${styles.chevronOpen}` : ''}`} aria-hidden="true" />
        </div>
      </SwipeRow>,
      ...(isOpen ? [
        ...(hydrating ? [
          <div key={`h:${project.path}`} className={styles.listNote}>
            <LoadingOutlined spin /> 加载完整会话列表
          </div>,
        ] : []),
        ...(visible.length === 0 && !hydrating ? [
          <div key={`e:${project.path}`} className={styles.listNote}>暂无会话，点击下方新建</div>,
        ] : []),
        ...visible.map(renderWorkSession),
        ...(canExpandMore ? [
          <button
            key={`m:${project.path}`}
            type="button"
            className={styles.listMore}
            onClick={() => toggleShowAll(project.path)}
          >
            {isShowAll ? '收起' : `展开更多 · ${project.sessions.length}`}
          </button>,
        ] : []),
      ] : []),
    ];
  };

  const chatBody = () => {
    if (sessions.loadingChatSessions && sessions.chatSessions.length === 0) return <MobileBoot label="SYNC" />;
    if (sessions.chatSessionsFailed && sessions.chatSessions.length === 0) {
      return (
        <div className={styles.errorLine} role="alert">
          <span className="hud-led hud-led--err" aria-hidden="true" />
          <span className={styles.errorText}>纯聊天会话列表加载失败</span>
          <HudIconButton icon={<ReloadOutlined />} label="重试" showLabel onClick={refresh} />
        </div>
      );
    }
    if (sessions.chatSessions.length === 0) {
      return <EmptySignal title="NO SESSIONS" description="暂无纯聊天会话，点击下方「发起新对话」开始。" />;
    }
    return <MonoList ariaLabel="纯聊天会话">{sessions.chatSessions.map(renderChatSession)}</MonoList>;
  };

  const workBody = () => {
    if (projectCatalog.loadingProjects && projects.length === 0) return <MobileBoot label="SYNC" />;
    if (projects.length === 0) {
      return (
        <EmptySignal
          title="NO PROJECTS"
          description="暂无项目。挂载一个服务器上的项目目录后即可新建工作区会话。"
          action={<HudIconButton icon={<FolderOpenOutlined />} label="打开项目" showLabel onClick={dialogs.openProject} />}
        />
      );
    }
    return <MonoList ariaLabel="工作区项目">{orderedProjects.flatMap(renderProject)}</MonoList>;
  };

  return (
    <MobilePage>
      <HudChips
        ariaLabel="会话模式"
        value={workspaceMode}
        onChange={(key) => handleModeChange(key === 'work' ? 'work' : 'chat')}
        items={[
          { key: 'chat', label: 'CHAT · 纯聊天', icon: <MessageOutlined /> },
          { key: 'work', label: 'WORK · 工作区', icon: <CodeOutlined /> },
        ]}
      />
      <MobileToolbar
        start={
          <span className={styles.summary}>
            {chatMode ? (
              <>
                {sessions.chatSessions.length} 对话
                {pinnedCount > 0 ? ` · ${pinnedCount} 置顶` : null}
              </>
            ) : (
              <>
                {projects.length} 项目
                {runningTotal > 0 ? <span className="mhud-tone--ok"> · {runningTotal} 运行中</span> : null}
              </>
            )}
          </span>
        }
      >
        {!chatMode ? (
          <>
            <HudIconButton icon={<InboxOutlined />} label="已归档的会话" onClick={onOpenArchived} />
            <HudIconButton icon={<FolderOpenOutlined />} label="打开项目" onClick={dialogs.openProject} />
          </>
        ) : null}
        <HudIconButton icon={<ReloadOutlined />} label="刷新列表" loading={loading} onClick={refresh} />
      </MobileToolbar>

      {!chatMode && canonicalDirectory.status === 'failed' ? (
        <div className={styles.errorLine} role="alert">
          <span className="hud-led hud-led--warn" aria-hidden="true" />
          <span className={styles.errorText}>
            {canonicalDirectory.offlineCached
              ? '服务端不可达，展示离线缓存的会话列表'
              : '会话目录同步失败，展示的是最近一次结果'}
          </span>
          <HudIconButton icon={<ReloadOutlined />} label="重试" showLabel onClick={refreshProjectList} />
        </div>
      ) : null}

      <HudSection
        code={chatMode ? 'CHAT' : 'WORK'}
        title={chatMode ? '纯聊天会话' : '工作区项目'}
        count={chatMode ? sessions.chatSessions.length : projects.length}
      >
        {chatMode ? chatBody() : workBody()}
      </HudSection>

      <div className={styles.dock}>
        {createDisabled ? (
          <span className={styles.dockHint}>先点选一个项目，再新建工作区会话</span>
        ) : !chatMode && selectedProject ? (
          <span className={styles.dockHint}>项目 · {selectedProject.name}</span>
        ) : null}
        <HudIconButton
          icon={<PlusOutlined />}
          label={chatMode ? '发起新对话' : '新建工作区会话'}
          tone="primary"
          showLabel
          disabled={createDisabled}
          onClick={handleCreateSession}
        />
      </div>
    </MobilePage>
  );
}
