import { useState } from 'react';
import { Button, Spin, Empty, Popconfirm, message } from 'antd';
import { ReloadOutlined, InboxOutlined } from '@ant-design/icons';
import type { AggregatedProject, Session } from '@/types';
import { sessionsAPI } from '@/services/api';
import ProviderIcon from './ProviderIcon';
import folderIcon from '@/assets/icons/folder.svg';
import expandIcon from '@/assets/icons/expand.svg';
import dayjs from 'dayjs';
import styles from './chat.module.css';

interface Props {
  projects: AggregatedProject[];
  loading: boolean;
  selectedSession: Session | null;
  expandedProjects: Set<string>;
  onRefresh: () => void;
  onToggleProject: (id: string) => void;
  onSelectSession: (session: Session) => void;
}

const ProjectList = ({
  projects, loading, selectedSession,
  expandedProjects, onRefresh, onToggleProject, onSelectSession
}: Props) => {
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set()); // 展开显示15条的项目

  return (
    <div className={styles.sidebar}>
      <div className={styles.refreshBar}>
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
            const maxShow = isSessionsExpanded ? 15 : 10;
            const displaySessions = isExpanded ? project.sessions.slice(0, maxShow) : [];
            const hasMore = project.sessions.length > maxShow;

            return (
              <div key={project.id}>
                {/* 项目行 */}
                <div
                  className={styles.projectItem}
                  onClick={() => onToggleProject(project.id)}
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
                </div>

                {/* 会话列表 */}
                {isExpanded && (
                  <div className={styles.sessionList}>
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
                    {hasMore && (
                      <div
                        className={styles.sessionMore}
                        style={{ cursor: 'pointer', color: '#1890ff' }}
                        onClick={() => {
                          const next = new Set(expandedSessions);
                          next.has(project.id) ? next.delete(project.id) : next.add(project.id);
                          setExpandedSessions(next);
                        }}
                      >
                        {isSessionsExpanded ? '收起' : `展开更多 (${project.sessions.length})`}
                      </div>
                    )}
                    {!hasMore && project.sessions.length > 10 && isSessionsExpanded && (
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
    </div>
  );
};

export default ProjectList;
