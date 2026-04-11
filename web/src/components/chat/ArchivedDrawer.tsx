import { useState, useEffect } from 'react';
import { Drawer, List, Button, Tag, Empty, Spin, Popconfirm, message, Grid } from 'antd';
import { UndoOutlined } from '@ant-design/icons';
import type { ArchivedSession } from '@/types';
import { sessionsAPI } from '@/services/api';
import ProviderIcon from './ProviderIcon';
import dayjs from 'dayjs';

interface Props {
  open: boolean;
  onClose: () => void;
  onRestored: () => void; // 还原成功后刷新项目列表
}

const PROVIDER_LABELS: Record<string, string> = {
  codex: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini'
};

const ArchivedDrawer = ({ open, onClose, onRestored }: Props) => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [loading, setLoading] = useState(false);

  const loadArchived = async () => {
    setLoading(true);
    try {
      const data = await sessionsAPI.getArchivedSessions();
      setSessions(data);
    } catch {
      message.error('加载归档列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) loadArchived();
  }, [open]);

  const handleUnarchive = async (session: ArchivedSession) => {
    try {
      await sessionsAPI.unarchiveSession(session.provider, session.id, session.projectDirName);
      message.success('已还原');
      setSessions(prev => prev.filter(s => s.id !== session.id));
      onRestored();
    } catch {
      message.error('还原失败');
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
        body: { padding: '8px 16px' }
      }}
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin tip="加载中..." />
        </div>
      ) : sessions.length === 0 ? (
        <Empty description="暂无归档会话" style={{ marginTop: 60 }} />
      ) : (
        <List
          dataSource={sessions}
          renderItem={(session) => (
            <List.Item
              key={session.id}
              style={{
                padding: '10px 0',
                borderBottom: '1px solid #f0f0f0'
              }}
              actions={[
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
                    style={{ color: '#1890ff' }}
                  >
                    还原
                  </Button>
                </Popconfirm>
              ]}
            >
              <List.Item.Meta
                avatar={<ProviderIcon provider={session.provider} size={18} />}
                title={
                  <span style={{ fontSize: 13 }}>
                    {session.title}
                  </span>
                }
                description={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#999' }}>
                    <Tag
                      color={session.provider === 'codex' ? 'green' : session.provider === 'claude' ? 'orange' : 'blue'}
                      style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}
                    >
                      {PROVIDER_LABELS[session.provider] || session.provider}
                    </Tag>
                    <span>{dayjs(session.archivedAt).fromNow()}</span>
                  </div>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Drawer>
  );
};

export default ArchivedDrawer;
