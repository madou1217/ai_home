import { useState } from 'react';
import type { ReactNode } from 'react';
import { Skeleton, Empty, Popconfirm, message, Modal } from 'antd';
import { ReloadOutlined, InboxOutlined, PlusOutlined, FolderOpenOutlined, MinusOutlined, LoadingOutlined } from '@ant-design/icons';
import type { AggregatedProject, Session } from '@/types';
import { sessionsAPI } from '@/services/api';
import ProviderIcon from './ProviderIcon';
import MobileSessions from '../mobile/MobileSessions';
import ArchivedDrawer from './ArchivedDrawer';
import Button from '@/components/ui/AppButton';
import { providerAccentStyle } from './provider-registry';
import { isSessionRunning, getRunningProviders, getVisibleProjectSessions, getProjectProviderBadges } from './project-runtime-state.js';
import folderIcon from '@/assets/icons/folder.svg';
import expandIcon from '@/assets/icons/expand.svg';
import dayjs from 'dayjs';
import styles from './chat.module.css';

interface Props {
  mobile?: boolean;
  projects: AggregatedProject[];
  loading: boolean;
  hydratingProjectPaths?: Set<string>;
  runningSessionKeys?: Set<string>;
  selectedSession: Session | null;
  selectedProject: AggregatedProject | null;
  expandedProjects: Set<string>;
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
  projects, loading, hydratingProjectPaths = new Set(), runningSessionKeys = new Set(), selectedSession, selectedProject,
  expandedProjects, onRefresh, onToggleProject, onSelectProject, onSelectSession, onOpenProject, onCreateSession,
  onProjectRemoved,
  remoteSessionsPanel
}: Props) => {
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set()); // 展开显示15条的项目
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [mobileConfirm, setMobileConfirm] = useState<MobileConfirmState | null>(null);
  const [mobileConfirmLoading, setMobileConfirmLoading] = useState(false);

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
      await sessionsAPI.archiveSession(session.provider, session.id, session.projectDirName);
      message.success('已归档');
      onRefresh();
    } catch {
      message.error('归档失败');
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
        body: { fontSize: 14, lineHeight: 1.6, color: '#475569' }
      }}
    >
      {mobileConfirm?.description ? (
        <div className={styles.mobileConfirmDescription}>{mobileConfirm.description}</div>
      ) : null}
    </Modal>
  );

  // Mobile "会话" tab: the bespoke project-grouped design. It is purely
  // presentational — this component stays the data/behavior owner and threads
  // its existing handlers (expand, select, archive, remove, refresh) down, so
  // there is no duplicated logic and no second sessions stream.
  if (mobile) {
    return (
      <>
        <MobileSessions
          projects={projects}
          loading={loading}
          hydratingProjectPaths={hydratingProjectPaths}
          runningSessionKeys={runningSessionKeys}
          selectedSession={selectedSession}
          expandedProjects={expandedProjects}
          canCreate={!!selectedProject}
          onToggleProject={(project) => { onSelectProject(project); onToggleProject(project.id); }}
          onSelectSession={onSelectSession}
          onCreateSession={onCreateSession}
          onOpenProject={onOpenProject}
          onOpenArchived={() => setArchivedOpen(true)}
          onRefresh={onRefresh}
          onRequestArchiveSession={(session) => openMobileConfirm({
            title: '归档此会话？',
            confirmText: '确定',
            action: () => handleArchiveSession(session)
          })}
          onRequestRemoveProject={(project) => openMobileConfirm({
            title: '移除此项目？',
            description: '仅从 Web UI 项目列表中隐藏，不会删除磁盘文件。',
            confirmText: '确定',
            action: () => handleRemoveProject(project)
          })}
        />
        <ArchivedDrawer open={archivedOpen} onClose={() => setArchivedOpen(false)} onRestored={onRefresh} />
        {mobileConfirmModal}
      </>
    );
  }

  return (
    <div className={styles.sidebar}>
      <div className={`${styles.refreshBar} ${mobile ? styles.refreshBarMobile : ''}`}>
        {/* 移动端：标题并入工具栏，构成 iOS 式单行头部（标题左 + 操作右）。桌面不显示。 */}
        {mobile ? <span className={styles.refreshBarTitle}>会话</span> : null}
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
          title="新建会话"
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

      {remoteSessionsPanel}

      <div className={styles.sidebarContent}>
        {/* 缓存存在时（projects 非空）即便在异步刷新也保持列表可见，刷新指示交给顶部刷新按钮的 loading，
            避免整列被遮罩导致空白感；只有首次无缓存加载时才用骨架屏占位。 */}
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
            {projects.map(project => {
            const isExpanded = expandedProjects.has(project.id);
            const isHovered = hoveredProject === project.id;
            const isSessionsExpanded = expandedSessions.has(project.id);
            const isHydratingSessions = hydratingProjectPaths.has(project.path);
            const collapsedLimit = 10;
            const expandedLimit = project.sessions.length;
            const displaySessions = getVisibleProjectSessions(project.sessions, isExpanded, isSessionsExpanded, collapsedLimit, expandedLimit);
            const canExpandMore = project.sessions.length > collapsedLimit;
            const runningProviders = getRunningProviders(project.sessions, runningSessionKeys);
            const projectProviderBadges = getProjectProviderBadges(project.providers || [], runningProviders, isExpanded);

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
                      transform: (!mobile && isHovered)
                        ? (isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)')
                        : 'none'
                    }}
                  />
                  <span className={styles.projectName}>
                    <strong>{project.name}</strong>
                  </span>
                  {/* provider 小图标 */}
                  <span className={styles.projectProviders}>
                    {projectProviderBadges.map((badge) => (
                      <span
                        key={badge.provider}
                        className={`${styles.projectProviderBadge} ${badge.running ? styles.projectProviderRunning : ''}`}
                        style={providerAccentStyle(badge.provider)}
                      >
                        <ProviderIcon
                          provider={badge.provider}
                          size={12}
                        />
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
                          action: () => handleRemoveProject(project)
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
                      return (
                      <div
                        key={session.id}
                        className={`${styles.sessionItem} ${
                          selectedSession?.id === session.id ? styles.sessionItemActive : ''
                        } ${isRunning ? styles.sessionItemRunning : ''}`}
                        onClick={() => onSelectSession(session)}
                      >
                        <div className={styles.sessionHeader}>
                          <span
                            className={`${styles.sessionProviderSlot} ${isRunning ? styles.sessionProviderSlotRunning : ''}`}
                            style={providerAccentStyle(session.provider)}
                          >
                            <ProviderIcon
                              provider={session.provider}
                              size={14}
                            />
                          </span>
                          <span className={styles.sessionTitle}>{session.title}</span>
                          {/* 归档按钮 - hover 显示 */}
                          {mobile ? (
                            <button
                              className={styles.archiveBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                openMobileConfirm({
                                  title: '归档此会话？',
                                  confirmText: '确定',
                                  action: () => handleArchiveSession(session)
                                });
                              }}
                              title="归档"
                            >
                              <InboxOutlined />
                            </button>
                          ) : (
                            <Popconfirm
                              title="归档此会话？"
                              onConfirm={async (e) => {
                                e?.stopPropagation();
                                await handleArchiveSession(session);
                              }}
                              onCancel={(e) => e?.stopPropagation()}
                              okText="确定"
                              cancelText="取消"
                            >
                              <button
                                className={styles.archiveBtn}
                                onClick={(e) => e.stopPropagation()}
                                title="归档"
                              >
                                <InboxOutlined />
                              </button>
                            </Popconfirm>
                          )}
                        </div>
                        <span className={styles.sessionTime}>
                          {isRunning ? '进行中' : dayjs(session.updatedAt).fromNow()}
                        </span>
                      </div>
                      );
                    })}
                    {canExpandMore && !isSessionsExpanded && (
                      <div
                        className={styles.sessionMore}
                        style={{ cursor: 'pointer', color: 'var(--color-info)' }}
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
                        className={styles.sessionMore}
                        style={{ cursor: 'pointer', color: 'var(--color-info)' }}
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

      <ArchivedDrawer
        open={archivedOpen}
        onClose={() => setArchivedOpen(false)}
        onRestored={onRefresh}
      />
    </div>
  );
};

export default ProjectList;
