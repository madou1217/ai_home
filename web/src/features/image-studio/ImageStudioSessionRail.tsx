import React from 'react';
import { PlusOutlined, SelectOutlined } from '@ant-design/icons';
import type { ImageStudioSessionSummary } from '@/types';
import { imageStudioAssetKey } from './image-studio-utils';
import styles from './image-studio.module.css';

interface ImageStudioSessionRailProps {
  sessions: ImageStudioSessionSummary[];
  activeSessionId: string;
  assetUrls: Record<string, string>;
  onCreate: () => void;
  onSelect: (sessionId: string) => void;
  onOpenWindow: (sessionId: string) => void;
}

function statusLabel(status: ImageStudioSessionSummary['latestStatus']) {
  if (status === 'running') return '生成中';
  if (status === 'failed') return '失败';
  if (status === 'succeeded') return '已生成';
  return '未生成';
}

export const ImageStudioSessionRail: React.FC<ImageStudioSessionRailProps> = ({
  sessions,
  activeSessionId,
  assetUrls,
  onCreate,
  onSelect,
  onOpenWindow,
}) => (
  <aside className={styles.sessionRail} aria-label="影像会话">
    <div className={styles.railHeader}>
      <div>
        <strong className={styles.panelTitle}>会话列表</strong>
        <span className={styles.panelCount}>{sessions.length} 个会话</span>
      </div>
      <button className={styles.iconButton} type="button" onClick={onCreate} aria-label="新建影像会话" title="新建会话">
        <PlusOutlined />
      </button>
    </div>

    <div className={styles.sessionList}>
      {sessions.length === 0 ? (
        <div className={styles.sessionEmpty}>
          <span>暂无会话</span>
          <button type="button" className={styles.inlineLinkButton} onClick={onCreate}>
            新建会话
          </button>
        </div>
      ) : sessions.map((session, index) => {
        const previewUrl = session.previewAssetId
          ? assetUrls[imageStudioAssetKey(session.id, session.previewAssetId)]
          : '';
        const active = session.id === activeSessionId;
        return (
          <div className={`${styles.sessionItem} ${active ? styles.sessionItemActive : ''}`} key={session.id}>
            <button
              className={styles.sessionSelect}
              type="button"
              onClick={() => onSelect(session.id)}
              aria-current={active ? 'page' : undefined}
            >
              <span className={styles.sessionFrame}>
                {previewUrl ? (
                  <img src={previewUrl} alt="" />
                ) : (
                  <span>{String(index + 1).padStart(2, '0')}</span>
                )}
              </span>
              <span className={styles.sessionCopy}>
                <span className={styles.sessionTitle}>{session.title}</span>
                <span className={styles.sessionMeta}>
                  {session.revisionCount} 帧 · {statusLabel(session.latestStatus)}
                </span>
                <span className={styles.sessionModel}>{session.latestModel || '未生成'}</span>
              </span>
            </button>
            <button
              className={styles.sessionWindowButton}
              type="button"
              onClick={() => onOpenWindow(session.id)}
              aria-label={`在新窗口打开 ${session.title}`}
              title="在新窗口打开"
            >
              <SelectOutlined />
            </button>
          </div>
        );
      })}
    </div>
  </aside>
);

export default ImageStudioSessionRail;
