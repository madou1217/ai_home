import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Dropdown, Skeleton, Empty, Popconfirm, message, Modal } from 'antd';
import {
  EllipsisOutlined,
  ReloadOutlined,
  InboxOutlined,
  PlusOutlined,
  FolderOpenOutlined,
  MinusOutlined,
  LoadingOutlined,
  MessageOutlined,
  DeleteOutlined,
  PushpinOutlined,
  PushpinFilled,
} from '@ant-design/icons';
import { getPinnedSessionIds, setPinnedSessionId, togglePinnedSessionId } from './pin-session-state';
import { crossTabSync } from '@/services/cross-tab-session-sync';
import type { AggregatedProject, Session } from '@/types';
import { sessionsAPI } from '@/services/api';
import ProviderIcon from './ProviderIcon';
import MobileSessions from '../mobile/MobileSessions';
import ArchivedDrawer from './ArchivedDrawer';
import SessionArchiveAction from './SessionArchiveAction';
import Button from '@/components/ui/AppButton';
import ModeSelector, { type WorkspaceMode } from './ModeSelector';
import { providerAccentStyle } from './provider-registry';
import { resolveArchiveAction } from './session-lifecycle-policy.js';
import {
  lifecycleErrorMessage,
  useSessionLifecycleCapabilities,
} from './useSessionLifecycle';
import {
  getProjectProviderBadges,
  getRunningProviders,
  getSessionRunKey,
  getVisibleProjectSessions,
  isSameSession,
  isSessionRunning,
} from './project-runtime-state.js';
import folderIcon from '@/assets/icons/folder.svg';
import expandIcon from '@/assets/icons/expand.svg';
import dayjs from 'dayjs';
import styles from './session-list.module.css';

interface Props {
  mobile?: boolean;
  projects: AggregatedProject[];
  loading: boolean;
  hydratingProjectPaths?: Set<string>;
  runningSessionKeys?: Set<string>;
  selectedSession: Session | null;
  selectedProject: AggregatedProject | null;
  expandedProjects: Set<string>;
  mode?: WorkspaceMode;
  onModeChange?: (mode: WorkspaceMode) => void;
  onRefresh: () => void;
  onToggleProject: (id: string) => void;
  onSelectProject: (project: AggregatedProject) => void;
  onSelectSession: (session: Session) => void;
  onOpenProject: () => void;
  onCreateSession: () => void;
  onProjectRemoved?: (project: AggregatedProject) => void;
  remoteSessionsPanel?: ReactNode;
}

interface MobileConfirmState {
  title: string;
  description?: string;
  confirmText?: string;
  action: () => Promise<void>;
}

const ProjectList = ({
  mobile = false,
  projects,
  loading,
  hydratingProjectPaths = new Set(),
  runningSessionKeys = new Set(),
  selectedSession,
  selectedProject,
  expandedProjects,
  mode = 'work',
  onModeChange,
  onRefresh,
  onToggleProject,
  onSelectProject,
  onSelectSession,
  onOpenProject,
  onCreateSession,
  onProjectRemoved,
  remoteSessionsPanel,
}: Props) => {
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [mobileConfirm, setMobileConfirm] = useState<MobileConfirmState | null>(null);
  const [mobileConfirmLoading, setMobileConfirmLoading] = useState(false);
  const { capabilities: lifecycleCapabilities } = useSessionLifecycleCapabilities();

  // 纯聊天 (Chat 模式) 会话列表状态
  const [chatSessions, setChatSessions] = useState<Session[]>([]);
  const [loadingChatSessions, setLoadingChatSessions] = useState(false);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(() => getPinnedSessionIds());

  const handleTogglePin = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = togglePinnedSessionId(sessionId);
    setPinnedSessionIds(next);
    // 跨 Tab 同步：置顶变更广播给其他 Tab；接收端只应用不再回播，天然无回环。
    crossTabSync.broadcast('SESSION_PINNED', { sessionId, pinned: next.has(sessionId) });
  };

  // 订阅其他 Tab 的置顶变更：幂等写入 localStorage 并刷新 UI（此处不广播，避免回环风暴）。
  useEffect(() => {
    return crossTabSync.subscribe('SESSION_PINNED', (event) => {
      const sessionId = String(event?.payload?.sessionId || '');
      if (!sessionId) return;
      setPinnedSessionIds(setPinnedSessionId(sessionId, Boolean(event.payload.pinned)));
    });
  }, []);

  const fetchChatSessions = useCallback(async () => {
    if (mode !== 'chat') return;
    setLoadingChatSessions(true);
    try {
      const list = await sessionsAPI.getChatSessions();
      setChatSessions(Array.isArray(list) ? list : []);
    } catch {
      // ignore
    } finally {
      setLoadingChatSessions(false);
    }
  }, [mode]);

  useEffect(() => {
    if (mode === 'chat') {
      void fetchChatSessions();
    }
  }, [fetchChatSessions, mode]);
  useEffect(() => {
    const refresh = () => { void fetchChatSessions(); };
    window.addEventListener('aih:chat-sessions-changed', refresh);
    return () => window.removeEventListener('aih:chat-sessions-changed', refresh);
  }, [fetchChatSessions]);

  const handleRemoveProject = async (project: AggregatedProject) => {
    try {
      await sessionsAPI.removeProject(project.path);
      message.success('项目已移除');
      onProjectRemoved?.(project);
      onRefresh();
    } catch {
      message.error('移除项目失败');
    }
  };

  const handleArchiveSession = async (session: Session) => {
    try {
      await sessionsAPI.archiveSession(session.provider, session.id);
      message.success('已归档');
      onRefresh();
    } catch (error) {
      message.error(lifecycleErrorMessage(error, '归档失败'));
    }
  };

  const handleDeleteChatSession = async (sessionId: string) => {
    try {
      await sessionsAPI.deleteChatSession(sessionId);
      message.success('已删除会话');
      void fetchChatSessions();
      if (selectedSession?.id === sessionId) {
        onCreateSession();
      }
    } catch {
      message.error('删除会话失败');
    }
  };

  const openMobileConfirm = (state: MobileConfirmState) => {
    setMobileConfirm(state);
  };

  const closeMobileConfirm = () => {
    if (mobileConfirmLoading) return;
    setMobileConfirm(null);
  };

  const handleMobileConfirmOk = async () => {
    if (!mobileConfirm) return;
    setMobileConfirmLoading(true);
    try {
      await mobileConfirm.action();
      setMobileConfirm(null);
    } finally {
      setMobileConfirmLoading(false);
    }
  };

  const mobileConfirmModal = (
    <Modal
      open={!!mobileConfirm}
      title={mobileConfirm?.title}
      onOk={handleMobileConfirmOk}
      onCancel={closeMobileConfirm}
      okText={mobileConfirm?.confirmText || '确定'}
      cancelText="取消"
      confirmLoading={mobileConfirmLoading}
      centered
      destroyOnHidden
      width="calc(100vw - 32px)"
      className={styles.mobileConfirmModal}
      styles={{
        content: { paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' },
        header: { paddingRight: 28 },
        body: { fontSize: 14, lineHeight: 1.6, color: 'var(--color-muted-strong)' },
      }}
    >
      {mobileConfirm?.description ? (
        <div className={styles.mobileConfirmDescription}>{mobileConfirm.description}</div>
      ) : null}
    </Modal>
  );

  if (mobile) {
    return (
      <>
        {onModeChange && (
          <ModeSelector mode={mode} onChange={onModeChange} mobile={mobile} />
        )}
        {mode === 'chat' ? (
          <div className={styles.sidebarContent} style={{ padding: '8px 12px' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={onCreateSession}
                style={{ flex: 1 }}
              >
                发起新对话
              </Button>
              <Button
                icon={<ReloadOutlined />}
                onClick={fetchChatSessions}
                loading={loadingChatSessions}
              />
            </div>
            {chatSessions.length === 0 ? (
              <Empty description="暂无对话，点击上方发起新对话" style={{ marginTop: 24 }} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {chatSessions.map((session) => (
                  <div
                    key={session.id}
                    className={`${styles.sessionItem} ${
                      isSameSession(selectedSession, session) ? styles.sessionItemActive : ''
                    }`}
                    onClick={() => onSelectSession(session)}
                    style={{ padding: '10px 12px' }}
                  >
                    <div className={styles.sessionHeader}>
                      <span className={styles.sessionProviderSlot} style={providerAccentStyle(session.provider)}>
                        <ProviderIcon provider={session.provider} size={14} />
                      </span>
                      <span className={styles.sessionTitle}>{session.title || '新对话'}</span>
                      <Button
                        type="text"
                        size="small"
                        icon={<DeleteOutlined />}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteChatSession(session.id);
                        }}
                      />
                    </div>
                    <span className={styles.sessionTime}>
                      {dayjs(session.updatedAt).fromNow()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <MobileSessions
            projects={projects}
            loading={loading}
            hydratingProjectPaths={hydratingProjectPaths}
            runningSessionKeys={runningSessionKeys}
            selectedSession={selectedSession}
            expandedProjects={expandedProjects}
            canCreate={!!selectedProject}
            onToggleProject={(project) => {
              onSelectProject(project);
              onToggleProject(project.id);
            }}
            onSelectSession={onSelectSession}
            onCreateSession={onCreateSession}
            onOpenProject={onOpenProject}
            onOpenArchived={() => setArchivedOpen(true)}
            onRefresh={onRefresh}
            lifecycleCapabilities={lifecycleCapabilities}
            onRequestArchiveSession={(session) =>
              openMobileConfirm({
                title: '通过原生协议归档此会话？',
                confirmText: '确定',
                action: () => handleArchiveSession(session),
              })
            }
            onRequestRemoveProject={(project) =>
              openMobileConfirm({
                title: '移除此项目？',
                description: '仅从 Web UI 项目列表中隐藏，不会删除磁盘文件。',
                confirmText: '确定',
                action: () => handleRemoveProject(project),
              })
            }
          />
        )}
        <ArchivedDrawer open={archivedOpen} onClose={() => setArchivedOpen(false)} onRestored={onRefresh} />
        {mobileConfirmModal}
      </>
    );
  }

  return (
    <div className={styles.sidebar}>
      {/* 统一 HarmonyOS 6 风格侧边栏沉浸顶栏 */}
      <div className={styles.sidebarUnifiedHeader}>
        {onModeChange && (
          <ModeSelector mode={mode} onChange={onModeChange} mobile={false} />
        )}
        {/* 顶栏是桌面端唯一的操作区（不再在列表上方重复一行同样的按钮；移动端保留自己的
            带标题操作行）。侧栏宽度下模式切换旁只放得下两个按钮，所以 WORK 模式把
            新建会话（最常用）作为主按钮，打开项目/归档/刷新收进「更多」菜单。 */}
        <div className={styles.sidebarHeaderActions}>
          <button
            type="button"
            className={styles.sidebarActionBtn}
            onClick={onCreateSession}
            disabled={mode === 'work' && !selectedProject}
            title={mode === 'chat' ? '发起新对话' : (selectedProject ? '新建工作区会话' : '先选择一个项目')}
            aria-label={mode === 'chat' ? '新建会话' : '新建工作区会话'}
          >
            <PlusOutlined />
          </button>
          {mode === 'work' ? (
            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              menu={{
                items: [
                  { key: 'open', icon: <FolderOpenOutlined />, label: '打开项目目录' },
                  { key: 'archived', icon: <InboxOutlined />, label: '已归档的会话' },
                  { key: 'refresh', icon: <ReloadOutlined spin={loading} />, label: '刷新列表' }
                ],
                onClick: ({ key }) => {
                  if (key === 'open') onOpenProject?.();
                  else if (key === 'archived') setArchivedOpen(true);
                  else if (key === 'refresh') onRefresh?.();
                }
              }}
            >
              <button
                type="button"
                className={styles.sidebarActionBtn}
                title="更多操作：打开项目 / 已归档 / 刷新"
                aria-label="更多操作"
              >
                <EllipsisOutlined />
              </button>
            </Dropdown>
          ) : (
            <button
              type="button"
              className={styles.sidebarActionBtn}
              onClick={fetchChatSessions}
              title="刷新列表"
              aria-label="刷新列表"
            >
              <ReloadOutlined spin={loadingChatSessions} />
            </button>
          )}
        </div>
      </div>

      {mode === 'chat' ? (
        <>

          <div className={styles.sidebarContent} style={{ padding: '4px 8px' }}>
            {loadingChatSessions && chatSessions.length === 0 ? (
              <div className={styles.sidebarSkeleton}>
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className={styles.sidebarSkeletonRow}>
                    <Skeleton.Avatar active size={16} shape="square" />
                    <Skeleton.Input active size="small" block />
                  </div>
                ))}
              </div>
            ) : chatSessions.length === 0 ? (
              <Empty
                description="暂无纯聊天会话"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                style={{ marginTop: 32 }}
              >
                <Button type="primary" icon={<MessageOutlined />} onClick={onCreateSession}>
                  发起新对话
                </Button>
              </Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[...chatSessions]
                  .sort((a, b) => {
                    const aPinned = pinnedSessionIds.has(a.id);
                    const bPinned = pinnedSessionIds.has(b.id);
                    if (aPinned && !bPinned) return -1;
                    if (!aPinned && bPinned) return 1;
                    return (b.updatedAt || 0) - (a.updatedAt || 0);
                  })
                  .map((session) => (
                  <div
                    key={session.id}
                    className={`${styles.sessionItem} ${
                      isSameSession(selectedSession, session) ? styles.sessionItemActive : ''
                    }`}
                    onClick={() => onSelectSession(session)}
                    style={{ padding: '8px 10px' }}
                  >
                    <div className={styles.sessionHeader}>
                      <span className={styles.sessionProviderSlot} style={providerAccentStyle(session.provider)}>
                        <ProviderIcon provider={session.provider} size={14} />
                      </span>
                      <span className={styles.sessionTitle}>{session.title || '新对话'}</span>
                      <button
                        className={styles.archiveBtn}
                        onClick={(e) => handleTogglePin(session.id, e)}
                        title={pinnedSessionIds.has(session.id) ? '取消置顶' : '置顶会话'}
                        style={{ opacity: pinnedSessionIds.has(session.id) ? 1 : undefined }}
                      >
                        {pinnedSessionIds.has(session.id) ? (
                          <PushpinFilled style={{ color: 'var(--color-warning)' }} />
                        ) : (
                          <PushpinOutlined />
                        )}
                      </button>
                      <Popconfirm
                        title="删除该对话？"
                        onConfirm={(e) => {
                          e?.stopPropagation();
                          void handleDeleteChatSession(session.id);
                        }}
                        onCancel={(e) => e?.stopPropagation()}
                        okText="确定"
                        cancelText="取消"
                      >
                        <button
                          className={styles.archiveBtn}
                          onClick={(e) => e.stopPropagation()}
                          title="删除对话"
                        >
                          <DeleteOutlined />
                        </button>
                      </Popconfirm>
                    </div>
                    <span className={styles.sessionTime}>
                      {dayjs(session.updatedAt).fromNow()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {mobile ? (
          <div className={`${styles.refreshBar} ${styles.refreshBarMobile}`}>
            <span className={styles.refreshBarTitle}>会话</span>
            <Button
              type={mobile ? 'default' : 'text'}
              icon={<FolderOpenOutlined />}
              onClick={onOpenProject}
              className={`${styles.refreshBtn} ${mobile ? styles.refreshBtnMobile : ''}`}
              title="打开项目"
            />
            <Button
              type={mobile ? 'default' : 'text'}
              icon={<PlusOutlined />}
              onClick={onCreateSession}
              className={`${styles.refreshBtn} ${mobile ? styles.refreshBtnMobile : ''}`}
              title="新建工作区会话"
              disabled={!selectedProject}
            />
            <Button
              type={mobile ? 'default' : 'text'}
              icon={<InboxOutlined />}
              onClick={() => setArchivedOpen(true)}
              className={`${styles.refreshBtn} ${mobile ? styles.refreshBtnMobile : ''}`}
              title="已归档的会话"
            />
            <Button
              type={mobile ? 'default' : 'text'}
              icon={<ReloadOutlined />}
              onClick={onRefresh}
              loading={loading}
              className={`${styles.refreshBtn} ${mobile ? styles.refreshBtnMobile : ''}`}
            />
          </div>
          ) : null}

          {remoteSessionsPanel}

          <div className={styles.sidebarContent}>
            {loading && projects.length === 0 ? (
              <div className={styles.sidebarSkeleton}>
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className={styles.sidebarSkeletonRow}>
                    <Skeleton.Avatar active size={16} shape="square" />
                    <Skeleton.Input active size="small" block />
                  </div>
                ))}
              </div>
            ) : projects.length === 0 ? (
              <Empty description="暂无项目" style={{ marginTop: 24 }} />
            ) : (
              <div style={{ padding: '4px 0' }}>
                {projects.map((project) => {
                  const isExpanded = expandedProjects.has(project.id);
                  const isHovered = hoveredProject === project.id;
                  const isSessionsExpanded = expandedSessions.has(project.id);
                  const isHydratingSessions = hydratingProjectPaths.has(project.path);
                  const collapsedLimit = 10;
                  const expandedLimit = project.sessions.length;
                  const displaySessions = getVisibleProjectSessions(
                    project.sessions,
                    isExpanded,
                    isSessionsExpanded,
                    collapsedLimit,
                    expandedLimit,
                  );
                  const canExpandMore = project.sessions.length > collapsedLimit;
                  const runningProviders = getRunningProviders(project.sessions, runningSessionKeys);
                  const projectProviderBadges = getProjectProviderBadges(
                    project.providers || [],
                    runningProviders,
                    isExpanded,
                  );

                  return (
                    <div key={project.id}>
                      {/* 项目行 */}
                      <div
                        className={`${styles.projectItem} ${
                          selectedProject?.path === project.path ? styles.projectItemActive : ''
                        }`}
                        onClick={() => {
                          onSelectProject(project);
                          onToggleProject(project.id);
                        }}
                        onMouseEnter={() => setHoveredProject(project.id)}
                        onMouseLeave={() => setHoveredProject(null)}
                      >
                        <img
                          src={isHovered ? expandIcon : folderIcon}
                          alt=""
                          className={styles.projectIcon}
                          style={{
                            transform:
                              !mobile && isHovered
                                ? isExpanded
                                  ? 'rotate(0deg)'
                                  : 'rotate(-90deg)'
                                : 'none',
                          }}
                        />
                        <span className={styles.projectName}>
                          <strong>{project.name}</strong>
                        </span>
                        <span className={styles.projectProviders}>
                          {projectProviderBadges.map((badge) => (
                            <span
                              key={badge.provider}
                              className={`${styles.projectProviderBadge} ${
                                badge.running ? styles.projectProviderRunning : ''
                              }`}
                              style={providerAccentStyle(badge.provider)}
                            >
                              <ProviderIcon provider={badge.provider} size={12} />
                            </span>
                          ))}
                        </span>
                        {mobile ? (
                          <button
                            className={styles.archiveBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              openMobileConfirm({
                                title: '移除此项目？',
                                description: '仅从 Web UI 项目列表中隐藏，不会删除磁盘文件。',
                                confirmText: '确定',
                                action: () => handleRemoveProject(project),
                              });
                            }}
                            title="移除项目"
                          >
                            <MinusOutlined />
                          </button>
                        ) : (
                          <Popconfirm
                            title="移除此项目？"
                            description="仅从 Web UI 项目列表中隐藏，不会删除磁盘文件。"
                            onConfirm={async (e) => {
                              e?.stopPropagation();
                              await handleRemoveProject(project);
                            }}
                            onCancel={(e) => e?.stopPropagation()}
                            okText="确定"
                            cancelText="取消"
                          >
                            <button
                              className={styles.archiveBtn}
                              onClick={(e) => e.stopPropagation()}
                              title="移除项目"
                            >
                              <MinusOutlined />
                            </button>
                          </Popconfirm>
                        )}
                      </div>

                      {/* 会话列表 */}
                      {isExpanded && (
                        <div className={styles.sessionList}>
                          {displaySessions.length === 0 && (
                            <div className={styles.sessionMore}>暂无会话，点击上方 + 新建</div>
                          )}
                          {isHydratingSessions && (
                            <div className={styles.sessionMore}>
                              <LoadingOutlined spin /> 加载完整会话列表
                            </div>
                          )}
                          {displaySessions.map((session) => {
                            const isRunning = isSessionRunning(session, runningSessionKeys);
                            const providerArchiveAction = resolveArchiveAction(
                              lifecycleCapabilities,
                              session.provider,
                            );
                            const archiveAction =
                              isRunning && providerArchiveAction.visible
                                ? {
                                    ...providerArchiveAction,
                                    disabled: true,
                                    reason: 'session_lifecycle_active',
                                  }
                                : providerArchiveAction;
                            return (
                              <div
                                key={getSessionRunKey(session)}
                                className={`${styles.sessionItem} ${
                                  isSameSession(selectedSession, session) ? styles.sessionItemActive : ''
                                } ${isRunning ? styles.sessionItemRunning : ''}`}
                                onClick={() => onSelectSession(session)}
                              >
                                <div className={styles.sessionHeader}>
                                  <span
                                    className={`${styles.sessionProviderSlot} ${
                                      isRunning ? styles.sessionProviderSlotRunning : ''
                                    }`}
                                    style={providerAccentStyle(session.provider)}
                                  >
                                    <ProviderIcon provider={session.provider} size={14} />
                                  </span>
                                  <span className={styles.sessionTitle}>{session.title}</span>
                                  <SessionArchiveAction
                                    action={archiveAction}
                                    session={session}
                                    onArchive={handleArchiveSession}
                                  />
                                </div>
                                <span className={styles.sessionTime}>
                                  {isRunning ? <span className="hud-led hud-led--ok hud-led--live" aria-hidden="true" /> : null}
                                  {isRunning ? '进行中' : dayjs(session.updatedAt).fromNow()}
                                </span>
                              </div>
                            );
                          })}
                          {canExpandMore && !isSessionsExpanded && (
                            <div
                              className={`${styles.sessionMore} ${styles.sessionMoreAction}`}
                              onClick={() => {
                                const next = new Set(expandedSessions);
                                next.add(project.id);
                                setExpandedSessions(next);
                              }}
                            >
                              展开更多
                            </div>
                          )}
                          {canExpandMore && isSessionsExpanded && (
                            <div
                              className={`${styles.sessionMore} ${styles.sessionMoreAction}`}
                              onClick={() => {
                                const next = new Set(expandedSessions);
                                next.delete(project.id);
                                setExpandedSessions(next);
                              }}
                            >
                              收起
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      <ArchivedDrawer open={archivedOpen} onClose={() => setArchivedOpen(false)} onRestored={onRefresh} />
    </div>
  );
};

export default ProjectList;
