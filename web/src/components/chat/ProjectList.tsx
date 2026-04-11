import { useState } from 'react';
import { Button, Spin, Empty, Popconfirm, message } from 'antd';
import { ReloadOutlined, InboxOutlined, PlusOutlined, FolderOpenOutlined, MinusOutlined } from '@ant-design/icons';
import type { AggregatedProject, Session } from '@/types';
import { sessionsAPI } from '@/services/api';
import ProviderIcon from './ProviderIcon';
import ArchivedDrawer from './ArchivedDrawer';
import folderIcon from '@/assets/icons/folder.svg';
import expandIcon from '@/assets/icons/expand.svg';
import dayjs from 'dayjs';
import styles from './chat.module.css';

interface Props {
  projects: AggregatedProject[];
  loading: boolean;
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
}

const ProjectList = ({
  projects, loading, selectedSession, selectedProject,
  expandedProjects, onRefresh, onToggleProject, onSelectProject, onSelectSession, onOpenProject, onCreateSession,
  onProjectRemoved
}: Props) => {
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set()); // 展开显示15条的项目
  const [archivedOpen, setArchivedOpen] = useState(false);

  return (
    <div className={styles.sidebar}>
      <div className={styles.refreshBar}>
        <Button
          type="text"
          icon={<FolderOpenOutlined />}
          onClick={onOpenProject}
          className={styles.refreshBtn}
          title="打开项目"
        />
        <Button
          type="text"
          icon={<PlusOutlined />}
          onClick={onCreateSession}
          className={styles.refreshBtn}
          title="新建会话"
          disabled={!selectedProject}
        />
        <Button
          type="text"
          icon={<ReloadOutlined />}
          onClick={onRefresh}
          loading={loading}
          className={styles.refreshBtn}
        />
      </div>

      {loading ? (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin tip="加载中..." />
        </div>
      ) : projects.length === 0 ? (
        <Empty description="暂无项目" style={{ marginTop: 24 }} />
      ) : (
        <div style={{ padding: '4px 0' }}>
          {projects.map(project => {
            const isExpanded = expandedProjects.has(project.id);
            const isHovered = hoveredProject === project.id;
            const isSessionsExpanded = expandedSessions.has(project.id);
            const collapsedLimit = 10;
            const expandedLimit = 15;
            const maxShow = isSessionsExpanded ? expandedLimit : collapsedLimit;
            const displaySessions = isExpanded
              ? project.sessions.slice(0, maxShow)
              : [];
            const canExpandMore = project.sessions.length > collapsedLimit;

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
                      transform: isHovered
                        ? (isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)')
                        : 'none'
                    }}
                  />
                  <span className={styles.projectName}>
                    <strong>{project.name}</strong>
                  </span>
                  {/* provider 小图标 */}
                  <span style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                    {(project.providers || []).map(p => (
                      <ProviderIcon key={p} provider={p} size={12} />
                    ))}
                  </span>
                  <Popconfirm
                    title="移除此项目？"
                    description="仅从 Web UI 项目列表中隐藏，不会删除磁盘文件。"
                    onConfirm={async (e) => {
                      e?.stopPropagation();
                      try {
                        await sessionsAPI.removeProject(project.path);
                        message.success('项目已移除');
                        onProjectRemoved?.(project);
                        onRefresh();
                      } catch {
                        message.error('移除项目失败');
                      }
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
                </div>

                {/* 会话列表 */}
                {isExpanded && (
                  <div className={styles.sessionList}>
                    {displaySessions.length === 0 && (
                      <div className={styles.sessionMore}>暂无会话，点击上方 + 新建</div>
                    )}
                    {displaySessions.map(session => (
                      <div
                        key={session.id}
                        className={`${styles.sessionItem} ${
                          selectedSession?.id === session.id ? styles.sessionItemActive : ''
                        }`}
                        onClick={() => onSelectSession(session)}
                      >
                        <div className={styles.sessionHeader}>
                          <ProviderIcon provider={session.provider} size={14} />
                          <span className={styles.sessionTitle}>{session.title}</span>
                          {/* 归档按钮 - hover 显示 */}
                          <Popconfirm
                            title="归档此会话？"
                            onConfirm={async (e) => {
                              e?.stopPropagation();
                              try {
                                await sessionsAPI.archiveSession(session.provider, session.id, session.projectDirName);
                                message.success('已归档');
                                onRefresh();
                              } catch { message.error('归档失败'); }
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
                        </div>
                        <span className={styles.sessionTime}>
                          {dayjs(session.updatedAt).fromNow()}
                        </span>
                      </div>
                    ))}
                    {canExpandMore && !isSessionsExpanded && (
                      <div
                        className={styles.sessionMore}
                        style={{ cursor: 'pointer', color: '#1890ff' }}
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
                        style={{ cursor: 'pointer', color: '#1890ff' }}
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

      {/* 归档入口 */}
      <div className={styles.archivedEntry}>
        <Button
          type="text"
          icon={<InboxOutlined />}
          onClick={() => setArchivedOpen(true)}
          block
          style={{ color: '#999', fontSize: 12 }}
        >
          已归档的会话
        </Button>
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
