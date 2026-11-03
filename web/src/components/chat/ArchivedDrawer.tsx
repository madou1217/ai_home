import { useState, useEffect, useMemo } from 'react';
import { Drawer, List, Tag, Empty, Skeleton, Popconfirm, message, Grid } from 'antd';
import { UndoOutlined } from '@ant-design/icons';
import type { ArchivedSession } from '@/types';
import { sessionsAPI } from '@/services/api';
import ProviderIcon from './ProviderIcon';
import { getProviderLabel, getProviderTagColor } from '@/providers/catalog';
import { getSessionRunKey, isSameSession } from './project-runtime-state.js';
import { usePresenceList } from '@/hooks/use-presence-list';
import { useFlipReorder } from '@/hooks/use-flip-reorder';
import {
  archivedSessionTime,
  canUnarchiveSession
} from './session-lifecycle-policy.js';
import { lifecycleErrorMessage } from './useSessionLifecycle';
import Button from '@/components/ui/AppButton';
import SessionRelativeTime from './SessionRelativeTime';
import styles from './chat-overlays.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onRestored: () => void; // 还原成功后刷新项目列表
}

const ArchivedDrawer = ({ open, onClose, onRestored }: Props) => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [loading, setLoading] = useState(false);

  const loadArchived = async () => {
    setLoading(true);
    try {
      const result = await sessionsAPI.getArchivedSessions();
      setSessions(result.archived);
      if (result.errors.length > 0) {
        message.warning(`部分原生归档加载失败：${result.errors.map((error) => error.provider).join('、')}`);
      }
    } catch (error) {
      message.error(lifecycleErrorMessage(error, '加载归档列表失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) loadArchived();
  }, [open]);

  // 还原后该行按原位淡出 170ms，其余行 FLIP 滑上来补位，避免整列瞬间跳一下
  const { render } = usePresenceList(sessions, (session) => getSessionRunKey(session));
  const leavingKeys = useMemo(
    () => new Set(render.filter((entry) => entry.leaving).map((entry) => getSessionRunKey(entry.item))),
    [render]
  );
  const listFlipRef = useFlipReorder<HTMLDivElement>(render);

  const handleUnarchive = async (session: ArchivedSession) => {
    try {
      await sessionsAPI.unarchiveSession(session.provider, session.id, session.origin);
      message.success('已还原');
      setSessions((previous) => previous.filter((candidate) => (
        !isSameSession(candidate, session)
      )));
      onRestored();
    } catch (error) {
      message.error(lifecycleErrorMessage(error, '还原失败'));
    }
  };

  return (
    <Drawer
      title="已归档的会话"
      placement="right"
      onClose={onClose}
      open={open}
      width={isMobile ? '100vw' : 420}
      styles={{
        body: { padding: '8px 16px', background: 'var(--color-bg)' },
        header: { background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }
      }}
    >
      {loading ? (
        <div className={styles.archivedList}>
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className={`hud-panel hud-panel--sm ${styles.archivedItem}`}>
              <Skeleton
                active
                avatar={{ size: 'small' }}
                title={{ width: '62%' }}
                paragraph={{ rows: 1, width: '40%' }}
              />
            </div>
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <Empty description={<span className="hud-label">暂无归档会话</span>} className={styles.archivedEmpty} />
      ) : (
        <div ref={listFlipRef}>
          <List
            dataSource={render.map((entry) => entry.item)}
            split={false}
            className={styles.archivedList}
            renderItem={(session) => {
              const sessionKey = getSessionRunKey(session);
              const leaving = leavingKeys.has(sessionKey);
              return (
                <List.Item
                  key={sessionKey}
                  data-flip-key={sessionKey}
                  aria-hidden={leaving ? true : undefined}
                  className={`hud-panel hud-panel--sm ${styles.archivedItem}${leaving ? ' aih-leaving' : ''}`}
                  actions={canUnarchiveSession(session) ? [
                    <Popconfirm
                      key="restore"
                      title="还原此会话？"
                      description="还原后会话将重新出现在项目列表中"
                      onConfirm={() => handleUnarchive(session)}
                      okText="确定"
                      cancelText="取消"
                    >
                      <Button
                        type="text"
                        icon={<UndoOutlined />}
                        size="small"
                        className={styles.archivedRestoreButton}
                      >
                        还原
                      </Button>
                    </Popconfirm>
                  ] : []}
                >
                  <List.Item.Meta
                    avatar={<ProviderIcon provider={session.provider} size={18} />}
                    title={
                      <span className={styles.archivedTitle} data-mobile={isMobile ? 'true' : undefined}>
                        {session.title}
                      </span>
                    }
                    description={
                      <div className={styles.archivedMeta} data-mobile={isMobile ? 'true' : undefined}>
                        <Tag
                          color={getProviderTagColor(session.provider)}
                          style={{ fontSize: isMobile ? 11 : 10, lineHeight: isMobile ? '18px' : '16px', padding: '0 4px', margin: 0 }}
                        >
                          {getProviderLabel(session.provider)}
                        </Tag>
                        <Tag
                          bordered={false}
                          color={session.origin === 'native' ? 'green' : 'gold'}
                          style={{ fontSize: isMobile ? 11 : 10, lineHeight: isMobile ? '18px' : '16px', padding: '0 4px', margin: 0 }}
                        >
                          {session.origin === 'native' ? '原生归档' : '历史归档'}
                        </Tag>
                        <span className={styles.archivedTime}>最后更新 <SessionRelativeTime timestamp={archivedSessionTime(session)} /></span>
                      </div>
                    }
                  />
                </List.Item>
              );
            }}
          />
        </div>
      )}
    </Drawer>
  );
};

export default ArchivedDrawer;
