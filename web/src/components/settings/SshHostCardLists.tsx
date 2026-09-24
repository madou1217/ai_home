import { Card, Empty, Popconfirm, Space, Spin } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import {
  SSH_AUTH_LABELS as AUTH_LABELS,
  SSH_DELETE_CONNECTION_CONFIRM,
  SSH_DELETE_WORKSPACE_CONFIRM,
  formatSshTarget
} from '@/features/ssh-hosts/ssh-hosts-model';
import type { SshConnection, SshWorkspace } from '@/features/ssh-hosts/ssh-hosts-model';
import './SshHostCardLists.css';

export type { SshConnection, SshWorkspace } from '@/features/ssh-hosts/ssh-hosts-model';

interface ConnectionListProps {
  connections: SshConnection[];
  loading: boolean;
  testingIds: string[];
  onTest: (connection: SshConnection) => void;
  onViewWorkspaces: (connection: SshConnection) => void;
  onCreateWorkspace: (connection: SshConnection) => void;
  onEdit: (connection: SshConnection) => void;
  onDelete: (id: string) => void;
}

export function SshConnectionCardList({
  connections,
  loading,
  testingIds,
  onTest,
  onViewWorkspaces,
  onCreateWorkspace,
  onEdit,
  onDelete
}: ConnectionListProps) {
  if (loading) return <div className="ssh-card-loading"><Spin /></div>;
  if (connections.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无远程连接" />;

  return (
    <div className="ssh-card-list">
      {connections.map((connection) => (
        <Card key={connection.id} bordered={false} className="ssh-list-card hud-panel hud-panel--sm">
          <div className="ssh-list-card-head">
            <div className="ssh-list-card-title">
              <span className="ssh-list-card-name" title={connection.label}>{connection.label}</span>
              <code className="ssh-list-card-endpoint" title={formatSshTarget(connection)}>
                {formatSshTarget(connection)}
              </code>
            </div>
            <span className={`ssh-auth-pill ssh-auth-pill--${connection.authType}`}>{AUTH_LABELS[connection.authType]}</span>
          </div>
          <div className="ssh-list-card-footer">
            <Space size={6} wrap>
              <Button size="small" loading={testingIds.includes(connection.id)} onClick={() => onTest(connection)}>测试连接</Button>
              <Button size="small" onClick={() => onViewWorkspaces(connection)}>查看工作区</Button>
              <Button size="small" onClick={() => onCreateWorkspace(connection)}>创建工作区</Button>
            </Space>
            <Space size={6} wrap>
              <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(connection)}>编辑</Button>
              <Popconfirm
                title={SSH_DELETE_CONNECTION_CONFIRM}
                onConfirm={() => onDelete(connection.id)}
                okText="确认"
                cancelText="取消"
              >
                <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
              </Popconfirm>
            </Space>
          </div>
        </Card>
      ))}
    </div>
  );
}

interface WorkspaceListProps {
  workspaces: SshWorkspace[];
  connections: SshConnection[];
  loading: boolean;
  onEdit: (workspace: SshWorkspace) => void;
  onDelete: (id: string) => void;
}

export function SshWorkspaceCardList({ workspaces, connections, loading, onEdit, onDelete }: WorkspaceListProps) {
  if (loading) return <div className="ssh-card-loading"><Spin /></div>;
  if (workspaces.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无项目工作空间" />;

  return (
    <div className="ssh-card-list">
      {workspaces.map((workspace) => {
        const connection = connections.find((item) => item.id === workspace.connectionId);
        return (
          <Card key={workspace.id} bordered={false} className="ssh-list-card hud-panel hud-panel--sm">
            <div className="ssh-list-card-head">
              <div className="ssh-list-card-title">
                <span className="ssh-list-card-name" title={workspace.label}>{workspace.label}</span>
                <code className="ssh-list-card-path" title={workspace.remoteRoot}>{workspace.remoteRoot}</code>
              </div>
              <span className={`ssh-connection-pill${connection ? '' : ' ssh-connection-pill--missing'}`}>
                <span className={`hud-led ${connection ? 'hud-led--info' : 'hud-led--err'}`} aria-hidden="true" />
                {connection ? connection.label : '连接已删除'}
              </span>
            </div>
            {connection && (
              <div className="ssh-list-card-meta" title={formatSshTarget(connection)}>
                {formatSshTarget(connection)}
              </div>
            )}
            <div className="ssh-list-card-footer ssh-list-card-footer--end">
              <Space size={6} wrap>
                <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(workspace)}>编辑</Button>
                <Popconfirm
                  title={SSH_DELETE_WORKSPACE_CONFIRM}
                  onConfirm={() => onDelete(workspace.id)}
                  okText="确认"
                  cancelText="取消"
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>移除</Button>
                </Popconfirm>
              </Space>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
